"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { PNG } = require("pngjs");

const PORT = Number(process.env.PORT || 6001);
const PACKAGE_ROOT = process.env.PACKAGE_ROOT || "/packages";
const MAX_DOCX_BYTES = Number(process.env.MAX_DOCX_BYTES || 50 * 1024 * 1024);
const MAX_MERMAID_SOURCE_BYTES = Number(process.env.MAX_MERMAID_SOURCE_BYTES || 512 * 1024);
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 120000);
const MAX_RESPONSE_PAGE_BYTES = Number(process.env.MAX_RESPONSE_PAGE_BYTES || 16 * 1024 * 1024);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSED = 3;

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && (request.url === "/" || request.url === "/health")) {
      sendJson(response, 200, healthPayload());
      return;
    }
    if (request.method === "POST" && request.url === "/render/word") {
      await handleRenderWord(request, response);
      return;
    }
    if (request.method === "POST" && request.url === "/render/mermaid") {
      await handleRenderMermaid(request, response);
      return;
    }
    if (request.method === "GET" && request.url && request.url.startsWith("/packages/")) {
      await handlePackageFile(request, response);
      return;
    }
    sendJson(response, 404, { ok: false, issues: [{ severity: "error", code: "not-found", message: "Route not found." }] });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      issues: [{ severity: "error", code: "server-error", message: formatError(error) }],
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`chipmate-word-render listening on 0.0.0.0:${PORT}`);
});

async function handleRenderWord(request, response) {
  const payload = JSON.parse(await readBody(request, MAX_DOCX_BYTES * 2));
  const filename = safeFilename(payload.filename || "document.docx");
  if (!filename.toLowerCase().endsWith(".docx")) throw new Error("filename must end with .docx");
  const docxBytes = decodeBase64(payload.docxBase64, "docxBase64");
  if (docxBytes.length > MAX_DOCX_BYTES) throw new Error(`docx exceeds ${MAX_DOCX_BYTES} bytes`);

  const timeoutMs = clampNumber(payload.timeoutMs, 5000, RENDER_TIMEOUT_MS, RENDER_TIMEOUT_MS);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "chipmate-word-render-"));
  const inDir = path.join(tempRoot, "in");
  const outDir = path.join(tempRoot, "out");
  const pagesDir = path.join(tempRoot, "pages");
  const profileDir = path.join(tempRoot, "lo-profile");
  const homeDir = path.join(tempRoot, "home");
  try {
    await Promise.all([inDir, outDir, pagesDir, profileDir, homeDir].map((dir) => fsp.mkdir(dir, { recursive: true })));
    const docxPath = path.join(inDir, filename);
    await fsp.writeFile(docxPath, docxBytes);

    const sofficePath = commandPath("soffice") || commandPath("libreoffice") || "soffice";
    const convertResult = await runCommand(sofficePath, [
      "--headless",
      "--nologo",
      "--nofirststartwizard",
      `-env:UserInstallation=file://${profileDir}`,
      "--convert-to",
      "pdf",
      "--outdir",
      outDir,
      docxPath,
    ], timeoutMs, { HOME: homeDir });
    if (!convertResult.ok) throw new Error(`LibreOffice failed: ${convertResult.message}`);

    const pdfPath = path.join(outDir, `${path.basename(filename, ".docx")}.pdf`);
    const pdfStat = await fsp.stat(pdfPath).catch(() => undefined);
    if (!pdfStat || pdfStat.size <= 0) throw new Error("LibreOffice did not produce a readable PDF.");

    const pdftoppmPath = commandPath("pdftoppm") || "pdftoppm";
    const prefix = path.join(pagesDir, "page");
    const pngResult = await runCommand(pdftoppmPath, ["-png", "-r", "144", pdfPath, prefix], timeoutMs);
    if (!pngResult.ok) throw new Error(`pdftoppm failed: ${pngResult.message}`);

    const pageFiles = (await fsp.readdir(pagesDir))
      .filter((entry) => /^page-\d+\.png$/i.test(entry))
      .sort((left, right) => pageIndex(left) - pageIndex(right));
    if (pageFiles.length === 0) throw new Error("pdftoppm completed but produced no page PNG files.");

    const pdfBytes = await fsp.readFile(pdfPath);
    const pages = [];
    for (const file of pageFiles) {
      const absolute = path.join(pagesDir, file);
      const pngBytes = await fsp.readFile(absolute);
      if (pngBytes.length > MAX_RESPONSE_PAGE_BYTES) throw new Error(`${file} exceeds ${MAX_RESPONSE_PAGE_BYTES} bytes`);
      const dimensions = pngDimensions(pngBytes);
      const page = pageIndex(file);
      pages.push({
        page,
        contentType: "image/png",
        base64: pngBytes.toString("base64"),
        width: dimensions.width,
        height: dimensions.height,
        visualSummary: pngVisualSummary(page, pngBytes, dimensions.width, dimensions.height),
      });
    }

    sendJson(response, 200, {
      ok: true,
      pageCount: pages.length,
      pdf: { contentType: "application/pdf", base64: pdfBytes.toString("base64") },
      pages,
      issues: [],
      renderer: {
        kind: "remote-opencode",
        docxToPdf: "libreoffice",
        pdfToPng: "pdftoppm",
        sofficePath,
        pdftoppmPath,
      },
    });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function handleRenderMermaid(request, response) {
  const startedAt = Date.now();
  const timeoutMs = clampNumber(undefined, 5000, RENDER_TIMEOUT_MS, 60000);
  let tempRoot;
  let browserPath;
  try {
    const payload = JSON.parse(await readBody(request, MAX_MERMAID_SOURCE_BYTES + 4096));
    const source = typeof payload.source === "string" ? payload.source : "";
    const sourceBytes = Buffer.byteLength(source, "utf8");
    if (!source.trim()) throw renderError("mermaid-source-empty", "source is required");
    if (sourceBytes > MAX_MERMAID_SOURCE_BYTES) throw renderError("mermaid-source-too-large", `source exceeds ${MAX_MERMAID_SOURCE_BYTES} bytes`);
    const requestedTimeoutMs = clampNumber(payload.timeoutMs, 5000, RENDER_TIMEOUT_MS, timeoutMs);
    const scale = clampNumber(payload.scale, 1, 4, 2);
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "chipmate-mermaid-render-"));
    const pagePath = path.join(tempRoot, `${safeFilename(payload.filename || "diagram")}.html`);
    const userDataDir = path.join(tempRoot, "chromium-profile");
    const mermaidPath = path.join(__dirname, "node_modules", "mermaid", "dist", "mermaid.esm.min.mjs");
    const mermaidStat = await fsp.stat(mermaidPath).catch(() => undefined);
    if (!mermaidStat || !mermaidStat.isFile()) throw renderError("mermaid-runtime-missing", `Mermaid runtime missing: ${mermaidPath}`);
    browserPath = commandPath("chromium") || commandPath("chromium-browser") || commandPath("google-chrome") || "chromium";
    await fsp.writeFile(pagePath, renderMermaidHtml(pathToFileHref(mermaidPath), source));
    const rendered = await runChromiumMermaidRender({
      browserPath,
      pageUrl: pathToFileHref(pagePath),
      userDataDir,
      timeoutMs: requestedTimeoutMs,
      scale,
    });
    assertPng(rendered.bytes);
    sendJson(response, 200, {
      ok: true,
      png: {
        contentType: "image/png",
        base64: rendered.bytes.toString("base64"),
      },
      width: rendered.width,
      height: rendered.height,
      pixelWidth: rendered.pixelWidth,
      pixelHeight: rendered.pixelHeight,
      scale: rendered.scale,
      contentBounds: rendered.contentBounds,
      cropBounds: rendered.cropBounds,
      padding: rendered.padding,
      contentCropRatio: rendered.contentCropRatio,
      issues: rendered.issues,
      elapsedMs: Date.now() - startedAt,
      renderer: {
        kind: "remote-opencode",
        diagramToPng: "mermaid-chromium",
        chromiumPath: browserPath,
        mermaidRuntime: "mermaid",
        scale: rendered.scale,
        crop: "svg-content-bounds",
      },
    });
  } catch (error) {
    const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "mermaid-render-failed";
    sendJson(response, 200, {
      ok: false,
      issues: [{ severity: "error", code, message: formatError(error) }],
      elapsedMs: Date.now() - startedAt,
      renderer: {
        kind: "remote-opencode",
        diagramToPng: "mermaid-chromium",
        chromiumPath: browserPath,
        mermaidRuntime: "mermaid",
      },
    });
  } finally {
    if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function handlePackageFile(request, response) {
  const parsed = new URL(request.url, "http://localhost");
  const relative = decodeURIComponent(parsed.pathname.replace(/^\/packages\/+/, ""));
  const target = path.resolve(PACKAGE_ROOT, relative || "manifest.json");
  const root = path.resolve(PACKAGE_ROOT);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    sendJson(response, 403, { ok: false, issues: [{ severity: "error", code: "package-path-forbidden", message: "Forbidden package path." }] });
    return;
  }
  const stat = await fsp.stat(target).catch(() => undefined);
  if (!stat || !stat.isFile()) {
    sendJson(response, 404, { ok: false, issues: [{ severity: "error", code: "package-not-found", message: "Package file not found." }] });
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypeFor(target),
    "content-length": stat.size,
    "cache-control": "no-store",
  });
  fs.createReadStream(target).pipe(response);
}

function healthPayload() {
  return {
    ok: true,
    service: "chipmate-word-render",
    endpoints: ["/render/word", "/render/mermaid", "/packages/manifest.json", "/packages/<file>"],
    tools: {
      node: process.version,
      chromium: commandVersion("chromium") || commandVersion("chromium-browser") || commandVersion("google-chrome"),
      mermaid: packageVersion("mermaid"),
      soffice: commandVersion("soffice") || commandVersion("libreoffice"),
      pdftoppm: commandVersion("pdftoppm"),
      pdfinfo: commandVersion("pdfinfo"),
    },
    capabilities: {
      mermaid: {
        endpoint: "/render/mermaid",
        scale: { min: 1, max: 4, default: 2 },
        cssSizeFields: ["width", "height"],
        pixelSizeFields: ["pixelWidth", "pixelHeight"],
        crop: { mode: "svg-content-bounds", padding: 32, fields: ["contentBounds", "cropBounds"] },
      },
    },
  };
}

async function runChromiumMermaidRender(input) {
  const scale = clampNumber(input.scale, 1, 4, 2);
  await fsp.mkdir(input.userDataDir, { recursive: true });
  const child = spawn(input.browserPath, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--allow-file-access-from-files",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${input.userDataDir}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let processError;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("error", (error) => { processError = error; });
  try {
    const wsUrl = await waitForDevtoolsWsUrl(child, () => `${stderr}\n${stdout}`, () => processError, input.timeoutMs);
    const cdp = await ChromeCdpConnection.open(wsUrl);
    try {
      const target = await cdp.send("Target.createTarget", { url: input.pageUrl });
      const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const sessionId = attached.sessionId;
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Page.enable", {}, sessionId);
      const deadline = Date.now() + input.timeoutMs;
      while (Date.now() < deadline) {
        const status = await evaluateString(cdp, sessionId, "document.body ? (document.body.getAttribute('data-status') || 'pending') : 'pending'");
        const text = await evaluateString(cdp, sessionId, "document.body ? (document.body.textContent || '') : ''");
        if (status === "ok") {
          let bounds = await mermaidScreenshotBounds(cdp, sessionId);
          let viewportWidth = Math.min(12000, Math.max(64, Math.ceil(bounds.cropBounds.x + bounds.cropBounds.width + 4)));
          let viewportHeight = Math.min(12000, Math.max(64, Math.ceil(bounds.cropBounds.y + bounds.cropBounds.height + 4)));
          await cdp.send("Emulation.setDeviceMetricsOverride", { width: viewportWidth, height: viewportHeight, deviceScaleFactor: scale, mobile: false }, sessionId);
          await sleep(100);
          bounds = await mermaidScreenshotBounds(cdp, sessionId);
          viewportWidth = Math.min(12000, Math.max(64, Math.ceil(bounds.cropBounds.x + bounds.cropBounds.width + 4)));
          viewportHeight = Math.min(12000, Math.max(64, Math.ceil(bounds.cropBounds.y + bounds.cropBounds.height + 4)));
          await cdp.send("Emulation.setDeviceMetricsOverride", { width: viewportWidth, height: viewportHeight, deviceScaleFactor: scale, mobile: false }, sessionId);
          await sleep(50);
          const screenshot = await cdp.send("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            clip: { x: bounds.cropBounds.x, y: bounds.cropBounds.y, width: bounds.cropBounds.width, height: bounds.cropBounds.height, scale: 1 },
          }, sessionId);
          const bytes = Buffer.from(screenshot.data, "base64");
          const dimensions = pngDimensions(bytes);
          const issues = [];
          if (bounds.contentCropRatio < 0.2) {
            issues.push({
              severity: "warning",
              code: "mermaid-render-content-bounds-suspicious",
              message: `Mermaid rendered content only occupies ${(bounds.contentCropRatio * 100).toFixed(1)}% of the cropped PNG bounds.`,
            });
          }
          return {
            bytes,
            width: bounds.cropBounds.width,
            height: bounds.cropBounds.height,
            pixelWidth: dimensions.width,
            pixelHeight: dimensions.height,
            scale,
            contentBounds: bounds.contentBounds,
            cropBounds: bounds.cropBounds,
            padding: bounds.padding,
            contentCropRatio: bounds.contentCropRatio,
            issues,
          };
        }
        if (status === "error") throw renderError("mermaid-render-failed", bounded(text));
        if (status === "timeout") throw renderError("mermaid-render-timeout", bounded(text));
        await sleep(250);
      }
      throw renderError("mermaid-render-timeout", bounded(stderr || stdout || "Chromium Mermaid render timed out."));
    } finally {
      await cdp.close().catch(() => undefined);
    }
  } finally {
    await terminateProcess(child);
  }
}

async function mermaidScreenshotBounds(cdp, sessionId) {
  const value = await evaluateJson(cdp, sessionId, mermaidBoundsExpression(32));
  if (!value || value.ok !== true || !value.cropBounds || !value.contentBounds) {
    const reason = value && value.reason ? value.reason : "Mermaid SVG bounds could not be measured.";
    throw renderError("mermaid-render-failed", bounded(reason));
  }
  return {
    padding: value.padding,
    contentBounds: normalizeBounds(value.contentBounds),
    cropBounds: normalizeBounds(value.cropBounds),
    contentCropRatio: Number.isFinite(value.contentCropRatio) ? value.contentCropRatio : 1,
  };
}

function mermaidBoundsExpression(padding) {
  return `(() => {
    const pad = ${Number(padding) || 32};
    const finite = (value) => Number.isFinite(value) && value > 0;
    const bounds = (x, y, width, height) => ({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height))
    });
    const numericAttr = (value) => {
      const match = String(value || "").match(/^-?\\d+(?:\\.\\d+)?/);
      return match ? Number(match[0]) : 0;
    };
    const host = document.getElementById("host");
    const svg = host && host.querySelector("svg");
    if (!svg) return { ok: false, reason: "Mermaid SVG was not found." };
    svg.style.maxWidth = "none";
    const viewBox = svg.viewBox && svg.viewBox.baseVal && finite(svg.viewBox.baseVal.width) && finite(svg.viewBox.baseVal.height)
      ? svg.viewBox.baseVal
      : undefined;
    const intrinsicWidth = viewBox ? viewBox.width : numericAttr(svg.getAttribute("width"));
    const intrinsicHeight = viewBox ? viewBox.height : numericAttr(svg.getAttribute("height"));
    if (finite(intrinsicWidth) && finite(intrinsicHeight)) {
      svg.setAttribute("width", String(Math.ceil(intrinsicWidth)));
      svg.setAttribute("height", String(Math.ceil(intrinsicHeight)));
      svg.style.width = Math.ceil(intrinsicWidth) + "px";
      svg.style.height = Math.ceil(intrinsicHeight) + "px";
    }
    if (host) {
      host.style.display = "inline-block";
      host.style.width = "max-content";
      host.style.height = "max-content";
    }
    document.documentElement.style.width = "max-content";
    document.documentElement.style.height = "max-content";
    document.body.style.display = "inline-block";
    document.body.style.width = "max-content";
    document.body.style.height = "max-content";
    const rect = svg.getBoundingClientRect();
    if (!finite(rect.width) || !finite(rect.height)) return { ok: false, reason: "Mermaid SVG has empty layout bounds." };
    let content = {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height
    };
    try {
      const bbox = svg.getBBox();
      const currentViewBox = svg.viewBox && svg.viewBox.baseVal && finite(svg.viewBox.baseVal.width) && finite(svg.viewBox.baseVal.height)
        ? svg.viewBox.baseVal
        : undefined;
      if (finite(bbox.width) && finite(bbox.height) && currentViewBox) {
        const sx = rect.width / currentViewBox.width;
        const sy = rect.height / currentViewBox.height;
        content = {
          x: rect.left + window.scrollX + ((bbox.x - currentViewBox.x) * sx),
          y: rect.top + window.scrollY + ((bbox.y - currentViewBox.y) * sy),
          width: bbox.width * sx,
          height: bbox.height * sy
        };
      }
    } catch {
      // Fall back to the SVG layout rectangle when getBBox is unavailable.
    }
    const cropLeft = Math.max(0, Math.floor(content.x - pad));
    const cropTop = Math.max(0, Math.floor(content.y - pad));
    const cropRight = Math.ceil(content.x + content.width + pad);
    const cropBottom = Math.ceil(content.y + content.height + pad);
    const crop = bounds(cropLeft, cropTop, Math.min(12000, Math.max(64, cropRight - cropLeft)), Math.min(12000, Math.max(64, cropBottom - cropTop)));
    const normalizedContent = bounds(content.x, content.y, content.width, content.height);
    const contentArea = normalizedContent.width * normalizedContent.height;
    const cropArea = crop.width * crop.height;
    return {
      ok: true,
      padding: pad,
      contentBounds: normalizedContent,
      cropBounds: crop,
      contentCropRatio: cropArea > 0 ? contentArea / cropArea : 1
    };
  })()`;
}

function normalizeBounds(value) {
  return {
    x: Math.max(0, Math.round(Number(value.x) || 0)),
    y: Math.max(0, Math.round(Number(value.y) || 0)),
    width: Math.max(1, Math.round(Number(value.width) || 1)),
    height: Math.max(1, Math.round(Number(value.height) || 1)),
  };
}

async function waitForDevtoolsWsUrl(child, output, processError, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs, 15000);
  while (Date.now() < deadline) {
    const startupError = processError && processError();
    if (startupError) throw renderError("chromium-startup-failed", startupError.message);
    const text = output();
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text);
    if (match && match[1]) return match[1];
    if (child.exitCode !== null) throw renderError("chromium-startup-failed", bounded(text || `exit ${child.exitCode}`));
    await sleep(100);
  }
  throw renderError("chromium-devtools-failed", bounded(output() || "Timed out waiting for Chromium DevTools endpoint."));
}

async function evaluateString(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false }, sessionId);
  return String((result.result && result.result.value) || "");
}

async function evaluateNumber(cdp, sessionId, expression) {
  const value = Number(await evaluateString(cdp, sessionId, expression));
  return Number.isFinite(value) ? value : 0;
}

async function evaluateJson(cdp, sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false }, sessionId);
  return result.result && result.result.value;
}

class ChromeCdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    this.socket.addEventListener("error", () => this.rejectAll(new Error("Chromium DevTools websocket error.")));
    this.socket.addEventListener("close", () => this.rejectAll(new Error("Chromium DevTools websocket closed.")));
  }

  static async open(url) {
    const WebSocketCtor = globalThis.WebSocket || require("ws");
    const socket = new WebSocketCtor(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to Chromium DevTools websocket.")), 10000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Failed to connect to Chromium DevTools websocket."));
      }, { once: true });
    });
    return new ChromeCdpConnection(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(message));
    });
  }

  async close() {
    if (this.socket.readyState === WEBSOCKET_OPEN) {
      await this.send("Browser.close").catch(() => undefined);
    }
    if (this.socket.readyState === WEBSOCKET_CLOSED) return;
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 500);
      this.socket.addEventListener("close", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.socket.close();
    });
    this.rejectAll(new Error("Chromium DevTools websocket closed."));
  }

  handleMessage(data) {
    const message = JSON.parse(data);
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "Chromium DevTools command failed."));
    else pending.resolve(message.result);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error(`request body exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function runCommand(command, args, timeoutMs, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, message: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, message: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || `exit ${code}` });
    });
  });
}

function decodeBase64(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length) throw new Error(`${label} decoded to empty bytes`);
  return bytes;
}

function safeFilename(input) {
  return String(input).replace(/[\\/:*?"<>|]+/g, "-").replace(/^\.+/, "").slice(0, 96) || "document.docx";
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function pageIndex(file) {
  return Number(file.match(/page-(\d+)\.png/i)?.[1] || 0);
}

function pngDimensions(bytes) {
  if (bytes.length >= 24 && bytes.toString("ascii", 1, 4) === "PNG") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  return { width: 1, height: 1 };
}

function assertPng(bytes) {
  if (!bytes || bytes.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw renderError("png-invalid", "Mermaid renderer did not return a valid PNG.");
  }
}

function minimalVisualSummary(page, width, height) {
  return {
    page,
    width,
    height,
    totalPixels: width * height,
    inkPixels: 0,
    inkRatio: 0,
    edgeInk: { top: false, right: false, bottom: false, left: false },
  };
}

function pngVisualSummary(page, bytes, fallbackWidth, fallbackHeight) {
  try {
    const png = PNG.sync.read(bytes);
    return pixelInkSummary(page, png.width || fallbackWidth, png.height || fallbackHeight, png.data);
  } catch (error) {
    return {
      ...minimalVisualSummary(page, fallbackWidth, fallbackHeight),
      summaryError: formatError(error),
    };
  }
}

function pixelInkSummary(page, width, height, rgba) {
  const totalPixels = Math.max(0, width * height);
  let inkPixels = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  const edgeSize = Math.max(2, Math.ceil(Math.min(width, height) * 0.02));
  const edgeInk = { top: false, right: false, bottom: false, left: false };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (!isInkPixel(rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3])) continue;
      inkPixels += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (y < edgeSize) edgeInk.top = true;
      if (y >= height - edgeSize) edgeInk.bottom = true;
      if (x < edgeSize) edgeInk.left = true;
      if (x >= width - edgeSize) edgeInk.right = true;
    }
  }
  const contentBounds = inkPixels > 0
    ? { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 }
    : undefined;
  return {
    page,
    width,
    height,
    totalPixels,
    inkPixels,
    inkRatio: totalPixels > 0 ? inkPixels / totalPixels : 0,
    contentBounds,
    edgeInk,
  };
}

function isInkPixel(r, g, b, a) {
  if ((a ?? 255) <= 16) return false;
  const red = r ?? 255;
  const green = g ?? 255;
  const blue = b ?? 255;
  return !(red >= 246 && green >= 246 && blue >= 246);
}

function commandPath(command) {
  const result = spawnSync("command", ["-v", command], { shell: true, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function commandVersion(command) {
  const pathValue = commandPath(command);
  if (!pathValue) return undefined;
  const result = spawnSync(command, command === "pdftoppm" || command === "pdfinfo" ? ["-v"] : ["--version"], { encoding: "utf8" });
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim().split("\n")[0] || pathValue;
}

function packageVersion(packageName) {
  try {
    return require(path.join(__dirname, "node_modules", packageName, "package.json")).version;
  } catch {
    return undefined;
  }
}

function renderMermaidHtml(mermaidRuntimeUrl, source) {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"/>',
    "<style>",
    "html,body{margin:0;padding:0;background:#fff;color:#111;}",
    "body{display:inline-block;min-width:64px;min-height:64px;font-family:Arial,sans-serif;}",
    "#host{display:inline-block;background:#fff;padding:24px;}",
    "#host svg{display:block;background:#fff;max-width:none;}",
    "</style>",
    "</head><body data-status=\"pending\"><div id=\"host\"></div>",
    '<script type="module">',
    `import mermaid from ${JSON.stringify(mermaidRuntimeUrl)};`,
    `const source = ${JSON.stringify(source)};`,
    "const host = document.getElementById('host');",
    "const fail = (status, value) => { document.body.setAttribute('data-status', status); document.body.textContent = String(value && (value.stack || value.message) || value || 'unknown error'); };",
    "const timeout = setTimeout(() => fail('timeout', 'Mermaid render timed out.'), 30000);",
    "try {",
    "  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', deterministicIds: true, fontFamily: 'Arial, sans-serif' });",
    "  const rendered = await mermaid.render('chipmate_mermaid_render', source);",
    "  host.innerHTML = rendered.svg;",
    "  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));",
    "  clearTimeout(timeout);",
    "  document.body.setAttribute('data-status', 'ok');",
    "} catch (error) {",
    "  clearTimeout(timeout);",
    "  fail('error', error);",
    "}",
    "</script></body></html>",
  ].join("");
}

function pathToFileHref(file) {
  return pathToFileURL(file).href;
}

function renderError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateProcess(child) {
  const waitForClose = new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("close", resolve);
  });
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([waitForClose, sleep(2000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([waitForClose, sleep(1000)]);
  }
  child.stdout.destroy();
  child.stderr.destroy();
}

function contentTypeFor(file) {
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".sha256")) return "text/plain; charset=utf-8";
  if (file.endsWith(".sh")) return "text/x-shellscript; charset=utf-8";
  if (file.endsWith(".gz")) return "application/gzip";
  if (file.endsWith(".tar")) return "application/x-tar";
  return "application/octet-stream";
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function bounded(input) {
  return String(input).replace(/\s+/g, " ").trim().slice(0, 2000);
}
