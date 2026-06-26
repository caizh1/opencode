import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadDrawioRuntimeHtml } from "../src/drawio-runtime-html"
import { verifyDrawioRuntimeStatic } from "../scripts/verify-drawio-runtime"

describe("offline draw.io runtime", () => {
  const repoRoot = join(import.meta.dir, "..")
  const adapter = readFileSync(join(repoRoot, "media", "vendor", "drawio", "adapter.html"), "utf8")
  const chatHtml = readFileSync(join(repoRoot, "src", "chat-html.ts"), "utf8")

  test("passes the offline runtime packaging gate", () => {
    expect(() => verifyDrawioRuntimeStatic(repoRoot)).not.toThrow()
  })

  test("builds an inline srcdoc runtime without remote iframe navigation", () => {
    const result = loadDrawioRuntimeHtml(repoRoot, "DrawioNonce123")

    expect(result.error).toBeUndefined()
    expect(result.html).toContain("viewer-static")
    expect(result.html).toContain("function waitForRuntimeReady")
    expect(result.html).toContain("connect-src 'none'")
    expect(result.html).toContain('<script nonce="DrawioNonce123">')
    expect(result.html).toContain('<script nonce="DrawioNonce123">\nwindow.PROXY_URL')
    expect(result.html).toContain("Graph.prototype.getSvg")
  })

  test("does not use the brittle Graph and Editor initialization gate", () => {
    expect(adapter).toContain("function waitForRuntimeReady")
    expect(adapter).toContain("function selfTestRuntime")
    expect(adapter).toContain("window.Graph || window.mxGraph")
    expect(adapter).toContain("canUseBaseSvgExport")
    expect(adapter).toContain('rootNode.nodeName === "mxGraphModel"')
    expect(adapter).toContain("api.Editor.extractGraphModel")
    expect(adapter).toContain("drawio.mxfile_requires_editor")
    expect(adapter).toContain('toDataURL("image/png")')
    expect(adapter).toContain('PNG_DATA_URI_PREFIX = "data:image/png;base64,"')
    expect(adapter).not.toContain("!window.Graph || !window.Editor || !window.mxUtils || !window.mxCodec")
  })

  test("keeps draw.io render failures quiet while preserving source tools", () => {
    expect(chatHtml).toContain("离线 draw.io 预览暂不可用")
    expect(chatHtml).toContain("function drawioFailureCode")
    expect(chatHtml).toContain("function shouldShowDrawioSourceOnFailure")
    expect(chatHtml).toContain('drawioFailureCode(error) === "drawio.invalid_source"')
    expect(chatHtml).toContain("function drawioRuntimeMessageError")
    expect(chatHtml).toContain("error.code = message.code || \"\"")
    expect(chatHtml).toContain("setDrawioExportUnavailable")
    expect(chatHtml).toContain("DRAWIO_RUNTIME_HTML_B64")
    expect(chatHtml).toContain("frame.srcdoc = decodeDrawioRuntimeHtml();")
    expect(chatHtml).toContain('type: "drawioRenderTelemetry"')
    expect(chatHtml).not.toContain('"Draw.io render failed: " + diagramErrorMessage(error)')
  })
})
