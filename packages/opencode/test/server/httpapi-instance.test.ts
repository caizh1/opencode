import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { describe, expect } from "bun:test"
import { Config, Context, Effect, FileSystem, Layer, Path } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import nodePath from "path"
import { WorkspaceID } from "../../src/control-plane/schema"
import { ControlPaths } from "../../src/server/routes/instance/httpapi/groups/control"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { PermissionID } from "../../src/permission/schema"
import { ProjectID } from "../../src/project/schema"
import { QuestionID } from "../../src/question/schema"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { HEADER as FenceHeader } from "../../src/server/shared/fence"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Flip the experimental workspaces flag so SyncEvent.run actually writes to
// EventSequenceTable (the source of truth the fence middleware reads). Reset
// the database around the test so per-instance state does not leak between
// runs. resetDatabase() already calls disposeAllInstances(), so we don't
// repeat it.
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
        await resetDatabase()
      }),
    )
  }),
)

// Mount the production HttpApi route tree on a real Node HTTP server bound to
// 127.0.0.1:0 and a fetch-based HttpClient that prepends the server URL. This
// keeps the test wired directly through the same route layer production uses.
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(Layer.mergeAll(testStateLayer, httpApiServerLayer))
const handlerContext = Context.empty() as Context.Context<unknown>

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-opencode-directory", dir)
const uploadRequest = (dir: string, file: string, body?: BodyInit) =>
  Effect.promise(() =>
    HttpApiApp.webHandler().handler(
      new Request(
        `http://localhost${FilePaths.upload}?directory=${encodeURIComponent(dir)}&path=${encodeURIComponent(file)}`,
        {
          method: "PUT",
          headers: body ? { "content-type": "application/octet-stream" } : undefined,
          body,
        },
      ),
      handlerContext,
    ),
  )

describe("instance HttpApi", () => {
  it.live("serves the OpenAPI document", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/doc")

      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("application/json")
      expect(yield* response.json).toMatchObject({
        openapi: expect.any(String),
        info: expect.any(Object),
        paths: expect.objectContaining({
          "/global/health": expect.any(Object),
          "/session": expect.any(Object),
        }),
      })
    }),
  )

  it.live("writes text files through file.write and creates parent directories", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClientRequest.post(FilePaths.write).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ path: "nested/note.txt", content: "hello" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ path: "nested/note.txt" })
      expect(yield* Effect.promise(() => Bun.file(nodePath.join(dir, "nested", "note.txt")).text())).toBe("hello")

      const read = yield* HttpClientRequest.get(
        `${FilePaths.content}?path=${encodeURIComponent("nested/note.txt")}`,
      ).pipe(directoryHeader(dir), HttpClient.execute)

      expect(read.status).toBe(200)
      expect(yield* read.json).toMatchObject({ type: "text", content: "hello" })
    }),
  )

  it.live("writes text files with the requested charset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClientRequest.post(FilePaths.write).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ path: "gb18030.txt", content: "中文", charset: "gb18030" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(response.status).toBe(200)
      expect(
        Buffer.from(yield* Effect.promise(() => Bun.file(nodePath.join(dir, "gb18030.txt")).arrayBuffer())).toString(
          "hex",
        ),
      ).toBe("d6d0cec4")

      const read = yield* HttpClientRequest.get(`${FilePaths.content}?path=${encodeURIComponent("gb18030.txt")}`).pipe(
        directoryHeader(dir),
        HttpClient.execute,
      )

      expect(read.status).toBe(200)
      expect(yield* read.json).toMatchObject({ type: "text", content: "中文", charset: "gb18030" })
    }),
  )

  it.live("rejects file.write paths outside the workspace", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sibling = `${dir}-sibling`
      const response = yield* HttpClientRequest.post(FilePaths.write).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({
          path: `../${nodePath.basename(sibling)}/outside.txt`,
          content: "outside",
        }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => Bun.file(nodePath.join(sibling, "outside.txt")).exists())).toBe(false)
    }),
  )

  it.live("uploads raw binary files and creates parent directories", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const bytes = new Uint8Array([0, 1, 2, 3, 255])
      const response = yield* uploadRequest(dir, "nested/data.bin", bytes)

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toEqual({ path: "nested/data.bin" })
      const written = new Uint8Array(
        yield* Effect.promise(() => Bun.file(nodePath.join(dir, "nested", "data.bin")).arrayBuffer()),
      )
      expect(Array.from(written)).toEqual(Array.from(bytes))
    }),
  )

  it.live("overwrites existing files through raw upload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => Bun.write(nodePath.join(dir, "existing.bin"), new Uint8Array([1, 1, 1])))

      const bytes = new Uint8Array([9, 8, 7])
      const response = yield* uploadRequest(dir, "existing.bin", bytes)

      expect(response.status).toBe(200)
      const written = new Uint8Array(
        yield* Effect.promise(() => Bun.file(nodePath.join(dir, "existing.bin")).arrayBuffer()),
      )
      expect(Array.from(written)).toEqual(Array.from(bytes))
    }),
  )

  it.live("rejects raw upload paths outside the workspace", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sibling = `${dir}-sibling`
      const response = yield* uploadRequest(dir, `../${nodePath.basename(sibling)}/outside.bin`, new Uint8Array([1]))

      expect(response.status).toBe(403)
      expect(yield* Effect.promise(() => Bun.file(nodePath.join(sibling, "outside.bin")).exists())).toBe(false)
    }),
  )

  it.live("rejects raw uploads without a path or body", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const missingPath = yield* Effect.promise(() =>
        HttpApiApp.webHandler().handler(
          new Request(`http://localhost${FilePaths.upload}?directory=${encodeURIComponent(dir)}`, {
            method: "PUT",
            body: new Uint8Array([1]),
          }),
          handlerContext,
        ),
      )
      const missingBody = yield* uploadRequest(dir, "empty.bin")

      expect(missingPath.status).toBe(400)
      expect(missingBody.status).toBe(400)
    }),
  )

  it.live("emits a sync fence header for fixed-workspace mutations", () =>
    Effect.gen(function* () {
      const originalWorkspaceID = Flag.OPENCODE_WORKSPACE_ID
      Flag.OPENCODE_WORKSPACE_ID = WorkspaceID.ascending()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.OPENCODE_WORKSPACE_ID = originalWorkspaceID
        }),
      )

      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClientRequest.post(SessionPaths.create).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ title: "fenced" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(response.status).toBe(200)
      expect(JSON.parse(response.headers[FenceHeader] ?? "{}")).not.toEqual({})
    }),
  )

  it.live("does not emit sync fence headers for fixed-workspace reads or no-op mutations", () =>
    Effect.gen(function* () {
      const originalWorkspaceID = Flag.OPENCODE_WORKSPACE_ID
      Flag.OPENCODE_WORKSPACE_ID = WorkspaceID.ascending()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.OPENCODE_WORKSPACE_ID = originalWorkspaceID
        }),
      )

      const dir = yield* tmpdirScoped({ git: true })
      const read = yield* HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute)
      const log = yield* HttpClientRequest.post(ControlPaths.log).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ service: "fence-test", level: "info", message: "noop" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(read.status).toBe(200)
      expect(read.headers[FenceHeader]).toBeUndefined()
      expect(log.status).toBe(200)
      expect(log.headers[FenceHeader]).toBeUndefined()
    }),
  )

  it.live("rejects malformed permission and question request ids", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const request = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { "x-opencode-directory": dir, "content-type": "application/json", ...init?.headers },
            }),
            handlerContext,
          ),
        )
      const [permission, questionReply, questionReject] = yield* Effect.all(
        [
          request("/permission/invalid-permission-id/reply", {
            method: "POST",
            body: JSON.stringify({ reply: "once" }),
          }),
          request("/question/invalid-question-id/reply", {
            method: "POST",
            body: JSON.stringify({ answers: [["Yes"]] }),
          }),
          request("/question/invalid-question-id/reject", { method: "POST" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(permission.status).toBe(400)
      expect(questionReply.status).toBe(400)
      expect(questionReject.status).toBe(400)
    }),
  )

  it.live("returns typed not found bodies for missing permission and question requests", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const request = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { "x-opencode-directory": dir, "content-type": "application/json", ...init?.headers },
            }),
            handlerContext,
          ),
        )
      const permissionID = PermissionID.ascending()
      const questionReplyID = QuestionID.ascending()
      const questionRejectID = QuestionID.ascending()
      const [permission, questionReply, questionReject] = yield* Effect.all(
        [
          request(`/permission/${permissionID}/reply`, {
            method: "POST",
            body: JSON.stringify({ reply: "once" }),
          }),
          request(`/question/${questionReplyID}/reply`, {
            method: "POST",
            body: JSON.stringify({ answers: [["Yes"]] }),
          }),
          request(`/question/${questionRejectID}/reject`, { method: "POST" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(permission.status).toBe(404)
      expect(yield* Effect.promise(() => permission.json())).toEqual({
        _tag: "PermissionNotFoundError",
        requestID: permissionID,
        message: `Permission request not found: ${permissionID}`,
      })
      expect(questionReply.status).toBe(404)
      expect(yield* Effect.promise(() => questionReply.json())).toEqual({
        _tag: "QuestionNotFoundError",
        requestID: questionReplyID,
        message: `Question request not found: ${questionReplyID}`,
      })
      expect(questionReject.status).toBe(404)
      expect(yield* Effect.promise(() => questionReject.json())).toEqual({
        _tag: "QuestionNotFoundError",
        requestID: questionRejectID,
        message: `Question request not found: ${questionRejectID}`,
      })
    }),
  )

  it.live("returns typed not found bodies for missing projects", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const projectID = ProjectID.make("project_missing")
      const response = yield* Effect.promise(() =>
        HttpApiApp.webHandler().handler(
          new Request(`http://localhost/project/${projectID}`, {
            method: "PATCH",
            headers: { "x-opencode-directory": dir, "content-type": "application/json" },
            body: JSON.stringify({ name: "Missing" }),
          }),
          handlerContext,
        ),
      )

      expect(response.status).toBe(404)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        _tag: "ProjectNotFoundError",
        projectID,
        message: `Project not found: ${projectID}`,
      })
    }),
  )

  it.live("serves path and VCS read endpoints", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(path.join(dir, "changed.txt"), "hello")

      const [paths, vcs, diff] = yield* Effect.all(
        [
          HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get(InstancePaths.vcs).pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get(InstancePaths.vcsDiff).pipe(
            HttpClientRequest.setUrlParam("mode", "git"),
            directoryHeader(dir),
            HttpClient.execute,
          ),
        ],
        { concurrency: "unbounded" },
      )

      expect(paths.status).toBe(200)
      expect(yield* paths.json).toMatchObject({ directory: dir, worktree: dir })

      expect(vcs.status).toBe(200)
      expect(yield* vcs.json).toMatchObject({ branch: expect.any(String) })

      expect(diff.status).toBe(200)
      expect(yield* diff.json).toContainEqual(
        expect.objectContaining({ file: "changed.txt", additions: 1, status: "added" }),
      )
    }),
  )
})
