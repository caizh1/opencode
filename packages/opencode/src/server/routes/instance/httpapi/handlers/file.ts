import * as InstanceState from "@/effect/instance-state"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Ripgrep } from "@/file/ripgrep"
import { Bus } from "@/bus"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { InstanceHttpApi } from "../api"
import { FileWritePayload } from "../groups/file"
import { handleDownload } from "./file-download"
import path from "path"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* File.Service
    const ripgrep = yield* Ripgrep.Service
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service

    const router = yield* HttpRouter.HttpRouter

    const deleteFile = () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const rawPath = url.searchParams.get("path")
        if (!rawPath) return yield* HttpServerResponse.empty({ status: 400 })
        const targetDir = url.searchParams.get("directory") ?? request.headers["x-opencode-directory"] ?? process.cwd()
        const targetPath = path.isAbsolute(rawPath)
          ? path.resolve(targetDir, path.relative("/", rawPath))
          : path.resolve(targetDir, rawPath)
        if (!targetPath.startsWith(path.resolve(targetDir))) {
          return yield* HttpServerResponse.empty({ status: 403 })
        }
        const exists = yield* fs.existsSafe(targetPath)
        if (!exists) return yield* HttpServerResponse.empty({ status: 404 })
        const isDir = yield* fs.isDir(targetPath)
        yield* fs.remove(targetPath, { recursive: isDir, force: true })
        yield* bus.publish(File.Event.Edited, { file: targetPath })
        yield* bus.publish(FileWatcher.Event.Updated, { file: targetPath, event: "unlink" })
        return HttpServerResponse.jsonUnsafe({ path: rawPath }, { status: 200 })
      })

    yield* router.add("DELETE", "/file/delete", deleteFile())
    yield* router.add("GET", "/file/download", handleDownload(fs))

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
      const targetDir = instance.directory
      const targetPath = path.isAbsolute(ctx.payload.path)
        ? path.resolve(targetDir, path.relative("/", ctx.payload.path))
        : path.resolve(targetDir, ctx.payload.path)
      if (!targetPath.startsWith(path.resolve(targetDir))) {
        return yield* new HttpApiError.BadRequest({})
      }
      const raw = ctx.payload.content
      const isDataUrl = raw.includes(";base64,")
      const base64Body = isDataUrl ? raw.slice(raw.indexOf(";base64,") + 8) : raw
      const content = (ctx.payload.encoding === "base64" || isDataUrl)
        ? Buffer.from(base64Body, "base64")
        : Buffer.from(raw, "utf-8")
      const exists = yield* fs.existsSafe(targetPath)
      yield* fs.writeWithDirs(targetPath, content)
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
