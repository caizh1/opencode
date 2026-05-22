import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import path from "path"

const log = Log.create({ service: "download" })

function emit(msg: string, data?: unknown) {
  const line = data ? `[download] ${msg} ${JSON.stringify(data)}` : `[download] ${msg}`
  console.error(line)
  log.error(msg, data ? { data } : undefined)
}

const errorResponse = (message: string, detail: string) =>
  HttpServerResponse.jsonUnsafe({ error: message, detail }, { status: 500 })

export const handleDownload = (fs: AppFileSystem.Interface) =>
  Effect.fn("FileHttpApi.download")(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(request.url, "http://localhost")
    const rawPath = url.searchParams.get("path")
    if (!rawPath) {
      emit("missing path param")
      return yield* HttpServerResponse.empty({ status: 400 })
    }

    const targetDir = url.searchParams.get("directory") ?? request.headers["x-opencode-directory"] ?? process.cwd()
    const targetPath = path.isAbsolute(rawPath)
      ? path.resolve(targetDir, path.relative("/", rawPath))
      : path.resolve(targetDir, rawPath)

    emit("request", { rawPath, targetPath, targetDir })

    if (!targetPath.startsWith(path.resolve(targetDir))) {
      emit("path traversal blocked", { targetPath })
      return yield* HttpServerResponse.empty({ status: 403 })
    }

    const isDir = yield* fs.isDir(targetPath)
    const isFile = yield* fs.isFile(targetPath)

    if (!isFile && !isDir) {
      emit("not found", { targetPath, isDir, isFile })
      return yield* HttpServerResponse.empty({ status: 404 })
    }

    emit("resolved", { isDir, isFile, targetPath })

    if (isFile) {
      const outcome = yield* fs.readFile(targetPath).pipe(
        Effect.tapError((err) =>
          Effect.sync(() => emit("readFile failed", { targetPath, error: String(err) })),
        ),
        Effect.match({
          onSuccess: (content) => ({ _tag: "ok" as const, content }),
          onFailure: (error) => ({ _tag: "err" as const, error: String(error) }),
        }),
      )
      if (outcome._tag === "err") return errorResponse("Failed to read file", outcome.error)
      const name = path.basename(targetPath)
      const headers = new Headers({
        "content-disposition": `attachment; filename="${name}"`,
        "content-type": "application/octet-stream",
      })
      return HttpServerResponse.raw(outcome.content, { headers })
    }

    const dirName = path.basename(targetPath)
    const outcome = yield* collectFiles(fs, targetPath, targetDir).pipe(
      Effect.tapError((err) =>
        Effect.sync(() => emit("collectFiles failed", { targetPath, error: String(err) })),
      ),
      Effect.match({
        onSuccess: (files) => ({ _tag: "ok" as const, files }),
        onFailure: (error) => ({ _tag: "err" as const, error: String(error) }),
      }),
    )
    if (outcome._tag === "err") return errorResponse("Failed to collect files for zip", outcome.error)
    const zipData = createZip(outcome.files)
    const headers = new Headers({
      "content-disposition": `attachment; filename="${dirName}.zip"`,
      "content-type": "application/zip",
    })
    return HttpServerResponse.raw(zipData, { headers })
  })

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createZip(files: Array<{ relativePath: string; content: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder()
  const localHeaders: Array<{ offset: number; name: string; crc: number; size: number }> = []
  const chunks: Uint8Array[] = []
  let offset = 0

  for (const { relativePath, content } of files) {
    const nameBytes = encoder.encode(relativePath)
    const crc = crc32(content)
    const size = content.length

    const localHeader = new Uint8Array(30 + nameBytes.length + size)
    const view = new DataView(localHeader.buffer)

    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0, true)
    view.setUint16(8, 0, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, 0, true)
    view.setUint32(14, crc, true)
    view.setUint32(18, size, true)
    view.setUint32(22, size, true)
    view.setUint16(26, nameBytes.length, true)
    view.setUint16(28, 0, true)

    localHeader.set(nameBytes, 30)
    localHeader.set(content, 30 + nameBytes.length)

    chunks.push(localHeader)
    localHeaders.push({ offset, name: relativePath, crc, size })
    offset += localHeader.length
  }

  const nameLengths = localHeaders.reduce((sum, entry) => sum + new TextEncoder().encode(entry.name).length, 0)
  const centralDir = new Uint8Array(localHeaders.length * 46 + nameLengths)
  const cdView = new DataView(centralDir.buffer)
  let cdOffset = 0

  for (const entry of localHeaders) {
    const nameBytes = new TextEncoder().encode(entry.name)
    cdView.setUint32(cdOffset, 0x02014b50, true)
    cdView.setUint16(cdOffset + 4, 20, true)
    cdView.setUint16(cdOffset + 6, 20, true)
    cdView.setUint16(cdOffset + 8, 0, true)
    cdView.setUint16(cdOffset + 10, 0, true)
    cdView.setUint16(cdOffset + 12, 0, true)
    cdView.setUint16(cdOffset + 14, 0, true)
    cdView.setUint32(cdOffset + 16, entry.crc, true)
    cdView.setUint32(cdOffset + 20, entry.size, true)
    cdView.setUint32(cdOffset + 24, entry.size, true)
    cdView.setUint16(cdOffset + 28, nameBytes.length, true)
    cdView.setUint16(cdOffset + 30, 0, true)
    cdView.setUint16(cdOffset + 32, 0, true)
    cdView.setUint16(cdOffset + 34, 0, true)
    cdView.setUint16(cdOffset + 36, 0, true)
    cdView.setUint32(cdOffset + 38, 0, true)
    cdView.setUint32(cdOffset + 42, entry.offset, true)
    centralDir.set(nameBytes, cdOffset + 46)
    cdOffset += 46 + nameBytes.length
  }

  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(4, 0, true)
  eocdView.setUint16(6, 0, true)
  eocdView.setUint16(8, localHeaders.length, true)
  eocdView.setUint16(10, localHeaders.length, true)
  eocdView.setUint32(12, centralDir.length, true)
  eocdView.setUint32(16, offset, true)
  eocdView.setUint16(20, 0, true)

  chunks.push(centralDir, eocd)

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
  const result = new Uint8Array(totalLength)
  let pos = 0
  for (const chunk of chunks) {
    result.set(chunk, pos)
    pos += chunk.length
  }
  return result
}

function collectFiles(
  fs: AppFileSystem.Interface,
  dir: string,
  rootDir: string,
): Effect.Effect<Array<{ relativePath: string; content: Uint8Array }>> {
  return Effect.gen(function* () {
    const entries = yield* fs.readDirectoryEntries(dir)
    const results: Array<{ relativePath: string; content: Uint8Array }> = []
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      const relativePath = path.relative(rootDir, entryPath)
      if (entry.type === "file") {
        const content = yield* fs.readFile(entryPath)
        results.push({ relativePath, content })
      } else if (entry.type === "directory") {
        const subResults = yield* collectFiles(fs, entryPath, rootDir)
        results.push(...subResults)
      } else if (entry.type === "symlink") {
        const isSymDir = yield* fs.isDir(entryPath)
        if (isSymDir) {
          const subResults = yield* collectFiles(fs, entryPath, rootDir)
          results.push(...subResults)
        } else {
          const content = yield* fs.readFile(entryPath)
          if (content.length > 0) {
            results.push({ relativePath, content })
          }
        }
      }
    }
    return results
  })
}
