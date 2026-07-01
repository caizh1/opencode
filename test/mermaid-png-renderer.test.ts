import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MermaidPngRenderError,
  renderMermaidToPngRemoteFirst,
  setMermaidPngRendererForTest,
} from "../src/mermaid-png-renderer"

afterEach(() => {
  setMermaidPngRendererForTest(undefined)
})

describe("Mermaid PNG remote renderer", () => {
  test("fails with remote-unconfigured when no render server endpoint is configured", async () => {
    await expect(renderMermaidToPngRemoteFirst({
      source: "flowchart TD\nA-->B",
    })).rejects.toMatchObject({
      diagnostic: expect.objectContaining({
        errorCode: "remote-unconfigured",
        platform: process.platform,
        nodeVersion: process.version,
      }),
    })
  })

  test("renders through the remote /render/mermaid endpoint and writes the PNG artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "chipmate-mermaid-remote-"))
    const outputPath = join(root, "diagram.png")
    const endpoint = await listen(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/render/mermaid") return json(response, 404, { ok: false })
      const body = JSON.parse(await readRequestBody(request)) as { source?: string; filename?: string; scale?: number }
      expect(body.source).toContain("flowchart TD")
      expect(body.filename).toBe("diagram.mmd")
      expect(body.scale).toBe(3)
      return json(response, 200, {
        ok: true,
        png: { contentType: "image/png", base64: Buffer.from(tinyPngBytes()).toString("base64") },
        width: 640,
        height: 360,
        pixelWidth: 1920,
        pixelHeight: 1080,
        scale: 3,
        contentBounds: { x: 16, y: 18, width: 600, height: 320 },
        cropBounds: { x: 0, y: 0, width: 640, height: 360 },
        padding: 32,
        contentCropRatio: 0.83,
        issues: [],
      })
    })
    try {
      const result = await renderMermaidToPngRemoteFirst({
        source: "flowchart TD\nA-->B",
        remoteEndpoint: endpoint,
        filename: "diagram.mmd",
        outputPath,
        scale: 3,
      })
      expect(result.renderProvider).toBe("remote-opencode")
      expect(result.fallbackUsed).toBe(false)
      expect(result.width).toBe(640)
      expect(result.height).toBe(360)
      expect(result.pixelWidth).toBe(1920)
      expect(result.pixelHeight).toBe(1080)
      expect(result.scale).toBe(3)
      expect(result.cropMetadataMissing).toBe(false)
      expect(result.contentBounds).toEqual({ x: 16, y: 18, width: 600, height: 320 })
      expect(result.cropBounds).toEqual({ x: 0, y: 0, width: 640, height: 360 })
      expect(result.padding).toBe(32)
      expect(result.contentCropRatio).toBe(0.83)
      expect((await readFile(outputPath)).subarray(0, 8)).toEqual(tinyPngBytes().subarray(0, 8))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("infers PNG pixel dimensions when an old remote omits scale metadata", async () => {
    const endpoint = await listen(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/render/mermaid") return json(response, 404, { ok: false })
      const body = JSON.parse(await readRequestBody(request)) as { scale?: number }
      expect(body.scale).toBe(3)
      return json(response, 200, {
        ok: true,
        png: { contentType: "image/png", base64: Buffer.from(tinyPngBytes()).toString("base64") },
        width: 640,
        height: 360,
        issues: [],
      })
    })

    const result = await renderMermaidToPngRemoteFirst({
      source: "flowchart TD\nA-->B",
      remoteEndpoint: endpoint,
      scale: 3,
    })

    expect(result.width).toBe(640)
    expect(result.height).toBe(360)
    expect(result.pixelWidth).toBe(1)
    expect(result.pixelHeight).toBe(1)
    expect(result.scale).toBe(3)
    expect(result.scaleMetadataMissing).toBe(true)
    expect(result.cropMetadataMissing).toBe(true)
  })

  test("reports remote render failures in remote-only mode", async () => {
    const endpoint = await listen(async (_request, response) => {
      return json(response, 503, {
        ok: false,
        issues: [{ severity: "error", code: "remote-unavailable", message: "fixture remote service unavailable" }],
      })
    })
    let caught: unknown
    try {
      await renderMermaidToPngRemoteFirst({
        source: "flowchart TD\nA-->B",
        remoteEndpoint: endpoint,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MermaidPngRenderError)
    expect((caught as MermaidPngRenderError).diagnostic).toMatchObject({
      errorCode: "remote-unavailable",
      message: "fixture remote service unavailable",
    })
  })

  test("reports invalid remote responses as structured diagnostics", async () => {
    const endpoint = await listen(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{not json")
    })
    await expect(renderMermaidToPngRemoteFirst({
      source: "flowchart TD\nA-->B",
      remoteEndpoint: endpoint,
    })).rejects.toMatchObject({
      diagnostic: expect.objectContaining({
        errorCode: "remote-invalid-response",
        httpStatus: 200,
      }),
    })
  })

  test("test renderer seam still produces remote-provider results", async () => {
    const root = await mkdtemp(join(tmpdir(), "chipmate-mermaid-test-seam-"))
    const outputPath = join(root, "diagram.png")
    setMermaidPngRendererForTest(async (input) => {
      expect(input.source).toContain("flowchart TD")
      expect(input.scale).toBe(3)
      return { bytes: tinyPngBytes(), width: 320, height: 180, pixelWidth: 960, pixelHeight: 540, scale: 3 }
    })
    try {
      const result = await renderMermaidToPngRemoteFirst({
        source: "flowchart TD\nA-->B",
        outputPath,
        scale: 3,
      })
      expect(result.renderProvider).toBe("remote-opencode")
      expect(result.fallbackUsed).toBe(false)
      expect(result.pixelWidth).toBe(960)
      expect(result.pixelHeight).toBe(540)
      expect(result.scale).toBe(3)
      expect((await readFile(outputPath)).subarray(0, 8)).toEqual(tinyPngBytes().subarray(0, 8))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  server.unref()
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(payload))
}

function tinyPngBytes() {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0xf8, 0x0f, 0x04, 0x00,
    0x09, 0xfb, 0x03, 0xfd, 0xa7, 0x98, 0x9d, 0xa6,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ])
}
