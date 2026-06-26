import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTests } from "@vscode/test-electron"

const MINIMAL_MXGRAPHMODEL = '<mxGraphModel dx="140" dy="90" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="180" pageHeight="110" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="VS Code smoke" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#eaf4ff;strokeColor=#5b8def;fontColor=#172033;" vertex="1" parent="1"><mxGeometry x="20" y="20" width="120" height="44" as="geometry"/></mxCell></root></mxGraphModel>'

async function main() {
  const repoRoot = join(import.meta.dir, "..")
  const chatHtmlModule = join(repoRoot, "dist", "chat-html.js")
  const runtimeModule = join(repoRoot, "dist", "drawio-runtime-html.js")
  if (!existsSync(chatHtmlModule) || !existsSync(runtimeModule)) {
    throw new Error("Compiled draw.io webview smoke dependencies are missing. Run bun run compile first.")
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "chipmate-drawio-webview-"))
  try {
    const testPath = join(tempRoot, "index.js")
    writeFileSync(testPath, extensionTestSource(repoRoot, chatHtmlModule, runtimeModule))
    await runTests({
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: testPath,
      launchArgs: ["--disable-extensions", "--disable-gpu"],
      version: vscodeTestVersion(),
    })
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function extensionTestSource(repoRoot: string, chatHtmlModule: string, runtimeModule: string) {
  return `
const assert = require("node:assert/strict");
const vscode = require("vscode");
const { createChatViewHtml } = require(${JSON.stringify(chatHtmlModule)});
const { loadDrawioRuntimeHtml } = require(${JSON.stringify(runtimeModule)});

async function run() {
  const extension = vscode.extensions.getExtension("local.chipmate");
  assert.ok(extension, "local.chipmate extension should be available");
  await extension.activate();

  const nonce = "DrawioSmokeNonce123";
  const runtime = loadDrawioRuntimeHtml(${JSON.stringify(repoRoot)}, nonce);
  assert.equal(runtime.error, undefined, runtime.error);
  assert.ok(runtime.html.includes("connect-src 'none'"), "runtime must keep connect-src none");
  assert.ok(runtime.html.includes('nonce="' + nonce + '"'), "runtime scripts must use the webview nonce");

  const panel = vscode.window.createWebviewPanel("chipmateDrawioSmoke", "ChipMate draw.io smoke", vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extension.extensionUri, "media")],
    retainContextWhenHidden: true,
  });
  const drawioRuntimeUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extension.extensionUri, "media", "vendor", "drawio", "adapter.html")).toString();
  let html = createChatViewHtml(panel.webview.cspSource, nonce, "", "", "", drawioRuntimeUri, runtime.html);
  html = html.replace("</body>", smokeScript(nonce) + "</body>");

  const result = await new Promise((resolve) => {
    const disposable = panel.webview.onDidReceiveMessage((message) => {
      if (message && message.type === "drawioSmoke") {
        disposable.dispose();
        resolve(message);
      }
    });
    panel.webview.html = html;
    setTimeout(() => resolve({
      type: "drawioSmoke",
      status: "host-timeout",
      detail: "extension host timed out waiting for webview message",
      runtimeUri: drawioRuntimeUri,
      cspSource: panel.webview.cspSource,
    }), 45000);
  });
  panel.dispose();

  console.log("DRAWIO_SMOKE_RESULT " + JSON.stringify(result));
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.match(result.detail || "", /^data:image\\/png;base64,iVBORw0KGgo/);
  assert.equal(result.usesCdn, false, JSON.stringify(result));
  assert.ok(!/vscode-cdn\\.net|file\\+\\.vscode-resource/i.test(result.frameSrc || ""), JSON.stringify(result));
}

function smokeScript(nonce) {
  const xml = ${JSON.stringify(MINIMAL_MXGRAPHMODEL)};
  return '<script nonce="' + nonce + '">' +
    'window.addEventListener("error",function(e){vscode.postMessage({type:"drawioSmoke",status:"window-error",detail:String(e.message||e.error||e),source:e.filename,line:e.lineno});});' +
    'window.addEventListener("unhandledrejection",function(e){vscode.postMessage({type:"drawioSmoke",status:"unhandled",detail:String(e.reason&&e.reason.message||e.reason||e)});});' +
    'setTimeout(function(){try{var host=document.createElement("div");host.id="drawio-smoke-host";document.body.appendChild(host);var block=drawioDiagramBlock("drawio",' + JSON.stringify(xml) + ');host.appendChild(block);var started=Date.now();var timer=setInterval(function(){var frame=document.querySelector("iframe.drawioRuntimeFrame");var frameSrc=frame?(frame.getAttribute("src")||frame.src||"about:srcdoc"):"";var img=host.querySelector("img.drawioImage");var statuses=Array.from(host.querySelectorAll(".diagramStatus")).map(function(e){return e.textContent});if(img){clearInterval(timer);vscode.postMessage({type:"drawioSmoke",status:"ok",detail:String(img.src||"").slice(0,96),frame:!!frame,frameSrc:frameSrc,usesCdn:/(?:vscode-cdn\\\\.net|file\\\\+\\\\.vscode-resource)/i.test(frameSrc)});return;}if(Date.now()-started>30000){clearInterval(timer);vscode.postMessage({type:"drawioSmoke",status:"timeout",detail:JSON.stringify(statuses),frame:!!frame,frameSrc:frameSrc,usesCdn:/(?:vscode-cdn\\\\.net|file\\\\+\\\\.vscode-resource)/i.test(frameSrc)});}},250);}catch(e){vscode.postMessage({type:"drawioSmoke",status:"exception",detail:String(e&&e.stack||e)});}},0);' +
    '</script>';
}

exports.run = run;
`
}

function vscodeTestVersion() {
  const explicit = process.env.VSCODE_TEST_VERSION?.trim()
  if (explicit) return explicit
  const result = spawnSync("code", ["--version"], { encoding: "utf8" })
  if (result.status === 0) {
    const version = result.stdout.split(/\r?\n/)[0]?.trim()
    if (/^\d+\.\d+\.\d+/.test(version)) return version
  }
  return undefined
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  })
}
