import * as InstanceState from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Ripgrep } from "@/file/ripgrep"
import { Bus } from "@/bus"
import type { InstanceContext } from "@/project/instance-context"
import * as Project from "@/project/project"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { InstanceHttpApi } from "../api"
import { FileWritePayload } from "../groups/file"
import { handleDownload } from "./file-download"
import { randomUUID } from "crypto"
import { createWriteStream, type WriteStream } from "fs"
import fs from "fs/promises"
import iconv from "iconv-lite"
import path from "path"

export function resolveFileWritePath(directory: string, file: string) {
  const root = path.resolve(directory)
  const target = path.isAbsolute(file)
    ? path.resolve(root, path.relative(path.parse(file).root, file))
    : path.resolve(root, file)
  const relative = path.relative(root, target)
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) return
  return target
}

function decodeDirectory(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function rawInstanceContext(
  directory: string,
  project: Project.Info,
  worktree: string,
): InstanceContext {
  return {
    directory,
    worktree,
    project,
  }
}

export function decodeFileWriteContent(payload: typeof FileWritePayload.Type) {
  const raw = payload.content
  const isDataUrl = raw.includes(";base64,")
  const base64Body = isDataUrl ? raw.slice(raw.indexOf(";base64,") + 8) : raw
  if (payload.encoding === "base64" || isDataUrl) return Buffer.from(base64Body, "base64")
  if (payload.charset === "utf-8-bom") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw)])
  if (payload.charset === "utf-16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(raw, "utf16-le")])
  if (payload.charset === "utf-16be") return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(raw, "utf16-be")])
  if (payload.charset) return iconv.encode(raw, payload.charset)
  return Buffer.from(raw, "utf-8")
}

function requestHasBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.headers["content-length"] !== undefined) return true
  if (request.headers["transfer-encoding"] !== undefined) return true
  return request.source instanceof Request && request.source.body !== null
}

function streamError(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function writeChunk(writer: WriteStream, chunk: Uint8Array) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      writer.off("drain", onDrain)
      reject(error)
    }
    const onDrain = () => {
      writer.off("error", onError)
      resolve()
    }
    if (writer.write(chunk)) {
      resolve()
      return
    }
    writer.once("drain", onDrain)
    writer.once("error", onError)
  })
}

function finishWriter(writer: WriteStream) {
  return new Promise<void>((resolve, reject) => {
    if (writer.closed) {
      resolve()
      return
    }
    writer.end((error?: Error | null) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function closeWriter(writer: WriteStream) {
  return Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (writer.closed || writer.destroyed) {
          resolve()
          return
        }
        writer.destroy()
        resolve()
      }),
  )
}

function writeUploadBody(request: HttpServerRequest.HttpServerRequest, target: string) {
  return Effect.acquireUseRelease(
    Effect.sync(() => createWriteStream(target, { flags: "wx" })),
    (writer) =>
      Stream.runForEach(request.stream, (chunk) =>
        Effect.tryPromise({
          try: () => writeChunk(writer, chunk),
          catch: streamError,
        }),
      ).pipe(
        Effect.flatMap(() =>
          Effect.tryPromise({
            try: () => finishWriter(writer),
            catch: streamError,
          }),
        ),
      ),
    closeWriter,
  )
}

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* File.Service
    const ripgrep = yield* Ripgrep.Service
    const appfs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const project = yield* Project.Service

    const router = yield* HttpRouter.HttpRouter

    const publishUpdate = (directory: string, file: string, event: "add" | "change" | "unlink") =>
      Effect.gen(function* () {
        const info = yield* project.fromDirectory(directory)
        const ctx = rawInstanceContext(directory, info.project, info.sandbox)
        yield* bus.publish(File.Event.Edited, { file }).pipe(Effect.provideService(InstanceRef, ctx))
        yield* bus
          .publish(FileWatcher.Event.Updated, { file, event })
          .pipe(Effect.provideService(InstanceRef, ctx))
      }).pipe(
        Effect.timeout("2 seconds"),
        Effect.catch(() => Effect.void),
      )

    const deleteFile = () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const rawPath = url.searchParams.get("path")
        if (!rawPath) return HttpServerResponse.empty({ status: 400 })
        const targetDir = decodeDirectory(
          url.searchParams.get("directory") ?? request.headers["x-opencode-directory"] ?? process.cwd(),
        )
        const targetPath = resolveFileWritePath(targetDir, rawPath)
        if (!targetPath) return HttpServerResponse.empty({ status: 403 })
        const exists = yield* appfs.existsSafe(targetPath)
        if (!exists) return HttpServerResponse.empty({ status: 404 })
        const isDir = yield* appfs.isDir(targetPath)
        yield* appfs.remove(targetPath, { recursive: isDir, force: true })
        yield* publishUpdate(targetDir, targetPath, "unlink").pipe(Effect.forkDetach)
        return HttpServerResponse.jsonUnsafe({ path: rawPath }, { status: 200 })
      })

    const uploadFile = () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const rawPath = url.searchParams.get("path")
        if (!rawPath) return HttpServerResponse.empty({ status: 400 })
        if (!requestHasBody(request)) return HttpServerResponse.empty({ status: 400 })

        const targetDir = decodeDirectory(
          url.searchParams.get("directory") ?? request.headers["x-opencode-directory"] ?? process.cwd(),
        )
        const targetPath = resolveFileWritePath(targetDir, rawPath)
        if (!targetPath) return HttpServerResponse.empty({ status: 403 })
        const exists = yield* appfs.existsSafe(targetPath).pipe(Effect.orDie)
        if (exists && (yield* appfs.isDir(targetPath))) return HttpServerResponse.empty({ status: 409 })

        const tmpPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.upload`)
        const response = yield* Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => fs.mkdir(path.dirname(targetPath), { recursive: true }),
            catch: streamError,
          })
          yield* writeUploadBody(request, tmpPath)
          yield* Effect.tryPromise({
            try: () => fs.rename(tmpPath, targetPath),
            catch: streamError,
          })
          yield* publishUpdate(targetDir, targetPath, exists ? "change" : "add").pipe(Effect.forkDetach)
          return HttpServerResponse.jsonUnsafe({ path: rawPath }, { status: 200 })
        }).pipe(
          Effect.catch((error) =>
            Effect.promise(() => fs.rm(tmpPath, { force: true }).catch(() => {})).pipe(
              Effect.as(
                HttpServerResponse.jsonUnsafe(
                  { error: "Upload failed", detail: error.message },
                  { status: 500 },
                ),
              ),
            ),
          ),
        )
        return response
      })

    yield* router.add("DELETE", "/file/delete", deleteFile())
    yield* router.add("PUT", "/file/upload", uploadFile())
    yield* router.add("GET", "/file/download", handleDownload(appfs))

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .search({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).items
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      return yield* svc.search({
        query: ctx.query.query,
        limit: ctx.query.limit ?? 10,
        dirs: ctx.query.dirs !== "false",
        type: ctx.query.type,
      })
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      return yield* svc.list(ctx.query.path)
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      return yield* svc.read(ctx.query.path)
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return yield* svc.status()
    })

    const write = Effect.fn("FileHttpApi.write")(function* (ctx: {
      payload: typeof FileWritePayload.Type
    }) {
      const instance = yield* InstanceState.context
      const targetPath = resolveFileWritePath(instance.directory, ctx.payload.path)
      if (!targetPath) {
        return HttpServerResponse.jsonUnsafe({ error: "Bad Request" }, { status: 400 })
      }
      const content = decodeFileWriteContent(ctx.payload)
      const exists = yield* appfs.existsSafe(targetPath).pipe(Effect.orDie)
      yield* appfs.writeWithDirs(targetPath, content).pipe(Effect.orDie)
      yield* bus.publish(File.Event.Edited, { file: targetPath })
      yield* bus.publish(FileWatcher.Event.Updated, {
        file: targetPath,
        event: exists ? "change" : "add",
      })
      return { path: ctx.payload.path }
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
      .handle("write", write)
  }),
)
