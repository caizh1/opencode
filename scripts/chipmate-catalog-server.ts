import { createReadStream, promises as fs } from "node:fs"
import { createServer } from "node:http"
import { extname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type Options = {
  root: string
  host: string
  port: number
}

const DEFAULT_HOST = "0.0.0.0"
const DEFAULT_PORT = 8765

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const root = resolve(options.root)
  const stat = await fs.stat(root).catch(() => undefined)
  if (!stat?.isDirectory()) {
    throw new Error(`Catalog root does not exist or is not a directory: ${root}`)
  }

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" })
        response.end("Method not allowed\n")
        return
      }

      const target = resolveRequestPath(root, request.url || "/")
      const targetStat = await fs.stat(target).catch(() => undefined)
      if (!targetStat?.isFile()) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
        response.end("Not found\n")
        return
      }

      response.writeHead(200, {
        "Content-Type": contentType(target),
        "Content-Length": targetStat.size,
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      })
      if (request.method === "HEAD") {
        response.end()
        return
      }
      createReadStream(target).pipe(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
      response.end(`${message}\n`)
    }
  })

  await new Promise<void>((resolveListen) => {
    server.listen(options.port, options.host, resolveListen)
  })
  console.log(`ChipMate catalog server: http://${options.host}:${options.port}/catalog.json`)
  console.log(`Serving: ${root}`)
}

function parseArgs(args: string[]): Options {
  let root = process.cwd()
  let host = DEFAULT_HOST
  let port = DEFAULT_PORT

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--root") root = requiredValue(args, ++index, arg)
    else if (arg === "--host") host = requiredValue(args, ++index, arg)
    else if (arg === "--port") port = Number(requiredValue(args, ++index, arg))
    else if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid port: ${port}`)
  return { root, host, port }
}

function requiredValue(args: string[], index: number, flag: string) {
  const value = args[index]
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`)
  return value
}

function resolveRequestPath(root: string, rawUrl: string) {
  const url = new URL(rawUrl, "http://localhost")
  const pathname = decodeURIComponent(url.pathname)
  const clean = pathname.replace(/^\/+/, "") || "catalog.json"
  const target = resolve(root, clean)
  const rel = relative(root, target)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Request path escapes the catalog root.")
  }
  return target
}

function contentType(path: string) {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "application/json; charset=utf-8"
    case ".zip":
      return "application/zip"
    case ".md":
      return "text/markdown; charset=utf-8"
    default:
      return "application/octet-stream"
  }
}

function printHelp() {
  console.log([
    "Usage: bun scripts/chipmate-catalog-server.ts [--root DIR] [--host HOST] [--port PORT]",
    "",
    "Serve an offline ChipMate catalog directory over plain HTTP.",
    "Expected layout:",
    "  catalog.json",
    "  skills/<skill-id>-<version>.zip",
    "  mcps/<mcp-id>-<version>.zip",
  ].join("\n"))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
