import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadDrawioRuntimeHtml } from "../src/drawio-runtime-html"

const MINIMAL_MXGRAPHMODEL = '<mxGraphModel dx="140" dy="90" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="160" pageHeight="100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Offline" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#eaf4ff;strokeColor=#5b8def;fontColor=#172033;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="100" height="44" as="geometry"/></mxCell></root></mxGraphModel>'

export function verifyDrawioRuntimeStatic(repoRoot = join(import.meta.dir, "..")) {
  const vendorRoot = join(repoRoot, "media", "vendor", "drawio")
  const adapterPath = join(vendorRoot, "adapter.html")
  const viewerPath = join(vendorRoot, "viewer-static.min.js")
  const manifestPath = join(vendorRoot, "manifest.json")
  const licensePath = join(vendorRoot, "LICENSE")

  for (const file of [adapterPath, viewerPath, manifestPath, licensePath]) {
    if (!existsSync(file)) throw new Error(`Missing vendored draw.io runtime file: ${file}`)
  }

  const adapter = readFileSync(adapterPath, "utf8")
  const viewer = readFileSync(viewerPath, "utf8")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: unknown; license?: unknown }
  const license = readFileSync(licensePath, "utf8")

  requireContains(adapter, "viewer-static.min.js", "adapter must load the vendored viewer runtime")
  requireContains(adapter, "connect-src 'none'", "adapter must keep network disabled")
  requireContains(adapter, "waitForRuntimeReady", "adapter must wait for runtime APIs")
  requireContains(adapter, "selfTestRuntime", "adapter must self-test before init")
  requireContains(adapter, "format === \"png\" || format === \"xmlpng\"", "adapter must export PNG")
  requireContains(adapter, "rootNode.nodeName === \"mxGraphModel\"", "adapter must parse mxGraphModel directly")
  requireContains(adapter, "window.Graph || window.mxGraph", "adapter must have an mxGraph fallback")
  requireContains(adapter, "canUseBaseSvgExport", "adapter must expose the base mxGraph SVG export fallback")
  requireContains(adapter, "drawio.mxfile_requires_editor", "adapter must report mxfile fallback limits")
  requireContains(adapter, 'toDataURL("image/png")', "adapter must rasterize SVG as PNG")
  requireContains(adapter, 'PNG_DATA_URI_PREFIX = "data:image/png;base64,"', "adapter self-test must validate PNG data URIs")
  requireContains(viewer, "Graph.prototype.getSvg", "viewer runtime must contain draw.io Graph SVG export")
  requireContains(viewer, "Editor.extractGraphModel", "viewer runtime must contain mxfile extraction support")
  requireContains(viewer, "function mxGraph", "viewer runtime must contain base mxGraph")
  const inlineRuntime = loadDrawioRuntimeHtml(repoRoot)
  if (inlineRuntime.error) throw new Error(`draw.io inline runtime build failed: ${inlineRuntime.error}`)
  requireContains(inlineRuntime.html, "Graph.prototype.getSvg", "inline draw.io runtime must contain the viewer SVG export")
  requireContains(inlineRuntime.html, "connect-src 'none'", "inline draw.io runtime must keep network disabled")
  requireContains(inlineRuntime.html, "<script>\nwindow.PROXY_URL", "inline draw.io runtime must inline the vendored viewer runtime")
  if (adapter.includes("!window.Graph || !window.Editor || !window.mxUtils || !window.mxCodec")) {
    throw new Error("adapter still contains the brittle Graph/Editor readiness gate")
  }
  if (/embed\.diagrams\.net|viewer\.diagrams\.net/.test(adapter)) {
    throw new Error("adapter must not reference remote draw.io viewers")
  }
  if (!Array.isArray(manifest.files) || !manifest.files.includes("viewer-static.min.js") || !manifest.files.includes("adapter.html")) {
    throw new Error("draw.io manifest must list adapter.html and viewer-static.min.js")
  }
  if (manifest.license !== "Apache-2.0" || !license.includes("Apache License")) {
    throw new Error("draw.io runtime must include Apache-2.0 license metadata")
  }
}

export function verifyDrawioRuntimeBrowser(repoRoot = join(import.meta.dir, ".."), chromePath = findChrome()) {
  if (!chromePath) throw new Error("No Chrome executable found for draw.io browser smoke.")
  const tempRoot = mkdtempSync(join(tmpdir(), "chipmate-drawio-smoke-"))
  try {
    const smokePath = join(tempRoot, "smoke.html")
    const userDataDir = join(tempRoot, "chrome-profile")
    writeFileSync(smokePath, smokeHtml(repoRoot))
    const result = spawnSync(chromePath, [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userDataDir}`,
      "--virtual-time-budget=15000",
      "--dump-dom",
      `file://${smokePath}`,
    ], {
      encoding: "utf8",
      timeout: 30000,
    })
    if (result.error) throw result.error
    const output = `${result.stdout}\n${result.stderr}`
    if (result.status !== 0) throw new Error(`Chrome draw.io smoke failed with exit code ${result.status}.\n${bounded(output)}`)
    if (!/data-status="ok"/.test(result.stdout) || !/data:image\/png;base64,/.test(result.stdout)) {
      throw new Error(`Chrome draw.io smoke did not produce PNG.\n${bounded(output)}`)
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function requireContains(source: string, needle: string, message: string) {
  if (!source.includes(needle)) throw new Error(message)
}

function smokeHtml(repoRoot: string) {
  const adapterPath = join(repoRoot, "media", "vendor", "drawio", "adapter.html")
  const adapterUri = `file://${adapterPath.replace(/#/g, "%23").replace(/\?/g, "%3F")}?offline=1&local=1`
  return `<!doctype html>
<meta charset="utf-8">
<body data-status="pending">pending</body>
<script>
const xml = ${JSON.stringify(MINIMAL_MXGRAPHMODEL)};
const iframe = document.createElement("iframe");
iframe.src = ${JSON.stringify(adapterUri)};
document.body.appendChild(iframe);
const events = [];
function finish(status, detail) {
  document.body.setAttribute("data-status", status);
  document.body.textContent = status + ":" + detail;
}
setTimeout(() => finish("timeout", JSON.stringify(events)), 10000);
window.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.source !== "chipmate-drawio-runtime") return;
  events.push(message.event + ":" + (message.message || message.format || ""));
  if (message.event === "init") {
    iframe.contentWindow.postMessage({ source: "chipmate-chat", requestId: "load-1", action: "load", xml }, "*");
  } else if (message.event === "load") {
    iframe.contentWindow.postMessage({ source: "chipmate-chat", requestId: "export-1", action: "export", format: "xmlpng", scale: 1, border: 4, transparent: true, size: "diagram" }, "*");
  } else if (message.event === "export") {
    const data = String(message.data || "");
    finish(/^data:image\\/png;base64,/.test(data) ? "ok" : "bad-export", data.slice(0, 64));
  } else if (message.event === "error") {
    finish("error", message.code + ":" + message.message);
  }
});
</script>`
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ].filter(Boolean) as string[]
  for (const candidate of candidates) {
    if (candidate.includes("/") && existsSync(candidate)) return candidate
    if (!candidate.includes("/")) {
      const result = spawnSync("which", [candidate], { encoding: "utf8" })
      if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
    }
  }
  return ""
}

function bounded(value: string) {
  return value.trim().slice(-4000)
}

if (import.meta.main) {
  try {
    const runBrowser = process.argv.includes("--browser")
    verifyDrawioRuntimeStatic()
    if (runBrowser) verifyDrawioRuntimeBrowser()
    console.log(`draw.io runtime verification passed${runBrowser ? " with browser smoke" : ""}.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}
