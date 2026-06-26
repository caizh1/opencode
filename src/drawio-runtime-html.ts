import { readFileSync } from "node:fs"
import * as path from "node:path"

const DRAWIO_VENDOR_PATH = ["media", "vendor", "drawio"]
const VIEWER_SCRIPT_TAG = '<script src="./viewer-static.min.js"></script>'
const VIEWER_SCRIPT_PLACEHOLDER = "__CHIPMATE_DRAWIO_VIEWER_SCRIPT__"

export type DrawioRuntimeHtmlLoadResult = {
  html: string
  error?: string
}

export function loadDrawioRuntimeHtml(extensionRoot: string, scriptNonce = ""): DrawioRuntimeHtmlLoadResult {
  try {
    const vendorRoot = path.join(extensionRoot, ...DRAWIO_VENDOR_PATH)
    const adapter = readFileSync(path.join(vendorRoot, "adapter.html"), "utf8")
    const viewer = readFileSync(path.join(vendorRoot, "viewer-static.min.js"), "utf8")
    if (!adapter.includes(VIEWER_SCRIPT_TAG)) {
      throw new Error("draw.io adapter does not reference the vendored viewer-static runtime.")
    }
    if (!adapter.includes("connect-src 'none'")) {
      throw new Error("draw.io adapter CSP must keep connect-src 'none'.")
    }
    if (/embed\.diagrams\.net|viewer\.diagrams\.net/.test(adapter)) {
      throw new Error("draw.io adapter must not reference remote draw.io viewers.")
    }
    const nonceAttribute = scriptNonce ? ` nonce="${escapeHtmlAttribute(scriptNonce)}"` : ""
    const adapterWithPlaceholder = adapter.replace(VIEWER_SCRIPT_TAG, VIEWER_SCRIPT_PLACEHOLDER)
    const adapterWithNonce = nonceAttribute
      ? adapterWithPlaceholder.replace(/<script>/g, `<script${nonceAttribute}>`)
      : adapterWithPlaceholder
    const inlineViewer = `<script${nonceAttribute}>\n${escapeInlineScriptText(viewer)}\n</script>`
    return {
      html: adapterWithNonce.replace(VIEWER_SCRIPT_PLACEHOLDER, inlineViewer),
    }
  } catch (error) {
    return {
      html: "",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function escapeInlineScriptText(source: string) {
  return source.replace(/<\/script/gi, "<\\/script")
}

function escapeHtmlAttribute(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;"
      case "<": return "&lt;"
      case ">": return "&gt;"
      case "\"": return "&quot;"
      case "'": return "&#39;"
      default: return character
    }
  })
}
