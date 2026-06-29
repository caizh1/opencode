import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, win32 as pathWin32 } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"

export type MermaidPngRenderInput = {
  source: string
  repoRoot?: string
  outputPath?: string
  chromeDiscoveryOptions?: ChromeDiscoveryOptions
}

export type MermaidPngRenderResult = {
  bytes: Uint8Array
  width: number
  height: number
  artifactPath?: string
  renderProvider?: "remote-opencode" | "local-chrome"
  fallbackUsed?: boolean
  remoteFailure?: MermaidPngRenderDiagnostic
  localFailure?: MermaidPngRenderDiagnostic
}

export type MermaidPngRenderErrorCode =
  | "mermaid-runtime-missing"
  | "chrome-not-found"
  | "chrome-startup-failed"
  | "chrome-devtools-failed"
  | "mermaid-render-failed"
  | "mermaid-render-timeout"
  | "png-invalid"
  | "artifact-write-failed"
  | "remote-unconfigured"
  | "remote-unavailable"
  | "remote-invalid-response"
  | "remote-render-failed"
  | "remote-timeout"

export type MermaidPngRenderDiagnostic = {
  errorCode: MermaidPngRenderErrorCode
  message: string
  checkedChromeCandidates?: string[]
  chromePath?: string
  platform: NodeJS.Platform
  cwd: string
  nodeVersion: string
  stderrSnippet?: string
  stdoutSnippet?: string
  remoteEndpoint?: string
  httpStatus?: number
  issues?: Array<{ severity?: string; code?: string; message?: string }>
  remoteFailure?: MermaidPngRenderDiagnostic
  localFailure?: MermaidPngRenderDiagnostic
}

export type MermaidPngRemoteFirstInput = MermaidPngRenderInput & {
  remoteEndpoint?: string
  filename?: string
  timeoutMs?: number
  log?: (message: string) => void
  signal?: AbortSignal
}

export class MermaidPngRenderError extends Error {
  readonly diagnostic: MermaidPngRenderDiagnostic

  constructor(diagnostic: MermaidPngRenderDiagnostic) {
    super(diagnostic.message)
    this.name = "MermaidPngRenderError"
    this.diagnostic = diagnostic
  }
}

type WebSocketEvent = { data?: unknown }

type WebSocketLike = {
  readonly readyState: number
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: WebSocketEvent) => void, options?: { once?: boolean }): void
  send(data: string): void
  close(): void
}

type WebSocketConstructor = new (url: string) => WebSocketLike
type ChromeDiscoveryCommandResult = { status: number | null; stdout?: string | Buffer | null }
type ChromeDiscoveryCandidate = {
  kind: "path" | "command"
  source: string
  value: string
  found?: string
}
export type ChromeDiscoveryOptions = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
  runCommand?: (command: string, args: string[]) => ChromeDiscoveryCommandResult
}
export type ChromeDiscoveryResult = {
  path: string
  checked: ChromeDiscoveryCandidate[]
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const WEBSOCKET_OPEN = 1
const WEBSOCKET_CLOSED = 3
const REMOTE_ERROR_CODES = new Set<MermaidPngRenderErrorCode>([
  "remote-unavailable",
  "remote-invalid-response",
  "remote-render-failed",
  "remote-timeout",
  "mermaid-runtime-missing",
  "mermaid-render-failed",
  "mermaid-render-timeout",
  "png-invalid",
])
let renderMermaidToPngForTest: ((input: MermaidPngRenderInput) => Promise<MermaidPngRenderResult>) | undefined

export function setMermaidPngRendererForTest(renderer: ((input: MermaidPngRenderInput) => Promise<MermaidPngRenderResult>) | undefined) {
  renderMermaidToPngForTest = renderer
}

export async function renderMermaidToPngRemoteFirst(input: MermaidPngRemoteFirstInput): Promise<MermaidPngRenderResult> {
  const endpoint = normalizeRemoteMermaidEndpoint(input.remoteEndpoint)
  let remoteFailure: MermaidPngRenderDiagnostic | undefined
  if (endpoint) {
    input.log?.(`[mermaid-render] remote start endpoint=${redactedEndpoint(endpoint)}`)
    try {
      const remote = await renderMermaidToPngRemote({
        source: input.source,
        endpoint,
        filename: input.filename,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      })
      assertPng(remote.bytes)
      try {
        if (input.outputPath) await writeFile(input.outputPath, remote.bytes)
      } catch (error) {
        throw mermaidRenderError("artifact-write-failed", `Failed to write Mermaid PNG artifact: ${formatErrorMessage(error)}`, { remoteEndpoint: endpoint })
      }
      input.log?.(`[mermaid-render] remote completed endpoint=${redactedEndpoint(endpoint)} size=${remote.width}x${remote.height}`)
      return {
        ...remote,
        artifactPath: input.outputPath,
        renderProvider: "remote-opencode",
        fallbackUsed: false,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      remoteFailure = diagnosticFromError(error, {
        errorCode: "remote-unavailable",
        message: formatErrorMessage(error),
        remoteEndpoint: endpoint,
      })
      input.log?.(`[mermaid-render] remote failed code=${remoteFailure.errorCode} endpoint=${redactedEndpoint(endpoint)} message=${remoteFailure.message}`)
    }
  }

  if (remoteFailure) input.log?.("[mermaid-render] fallback local start")
  try {
    const local = await renderMermaidToPng(input)
    if (remoteFailure) input.log?.(`[mermaid-render] fallback local completed size=${local.width}x${local.height}`)
    return {
      ...local,
      renderProvider: "local-chrome",
      fallbackUsed: Boolean(remoteFailure),
      remoteFailure,
    }
  } catch (error) {
    if (input.signal?.aborted) throw error
    const localFailure = diagnosticFromError(error, {
      errorCode: "mermaid-render-failed",
      message: formatErrorMessage(error),
    })
    if (remoteFailure) {
      input.log?.(`[mermaid-render] failed remote+local remoteCode=${remoteFailure.errorCode} localCode=${localFailure.errorCode}`)
      throw new MermaidPngRenderError({
        ...localFailure,
        message: `Remote Mermaid render failed and local fallback failed: remote=${remoteFailure.message}; local=${localFailure.message}`,
        remoteFailure,
        localFailure,
      })
    }
    throw error
  }
}

export async function renderMermaidToPng(input: MermaidPngRenderInput): Promise<MermaidPngRenderResult> {
  if (renderMermaidToPngForTest) return renderMermaidToPngForTest(input)
  if (!input.source.trim()) throw new Error("Mermaid source is empty.")
  const repoRoot = input.repoRoot ?? resolve(__dirname, "..")
  const mermaidPath = join(repoRoot, "node_modules", "mermaid", "dist", "mermaid.esm.min.mjs")
  if (!existsSync(mermaidPath)) {
    throw mermaidRenderError("mermaid-runtime-missing", `Missing local Mermaid runtime: ${mermaidPath}`)
  }
  const chromeDiscovery = discoverChrome(input.chromeDiscoveryOptions)
  const chromePath = chromeDiscovery.path
  if (!chromePath) {
    throw mermaidRenderError("chrome-not-found", formatChromeDiscoveryFailure(chromeDiscovery), {
      checkedChromeCandidates: formatCheckedChromeCandidates(chromeDiscovery.checked),
    })
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "chipmate-mermaid-render-"))
  try {
    const pagePath = join(tempRoot, "render-mermaid.html")
    const userDataDir = join(tempRoot, "chrome-profile")
    await writeFile(pagePath, renderMermaidHtml(pathToFileURL(mermaidPath).href, input.source))
    let result: MermaidPngRenderResult
    try {
      result = await runChromeMermaidRender({
        chromePath,
        userDataDir,
        pageUrl: pathToFileURL(pagePath).href,
      })
    } catch (error) {
      if (error instanceof MermaidPngRenderError) {
        throw withChromePath(error, chromePath)
      }
      if (isChromeStartupFailure(error)) {
        throw mermaidRenderError("chrome-startup-failed", `Found Chrome/Edge executable at ${chromePath}, but headless rendering could not start: ${formatErrorMessage(error)}`, {
          chromePath,
          ...diagnosticSnippets(error),
        })
      }
      throw mermaidRenderError("mermaid-render-failed", formatErrorMessage(error), {
        chromePath,
        ...diagnosticSnippets(error),
      })
    }
    try {
      assertPng(result.bytes)
    } catch (error) {
      throw mermaidRenderError("png-invalid", formatErrorMessage(error), { chromePath })
    }
    try {
      if (input.outputPath) await writeFile(input.outputPath, result.bytes)
    } catch (error) {
      throw mermaidRenderError("artifact-write-failed", `Failed to write Mermaid PNG artifact: ${formatErrorMessage(error)}`, { chromePath })
    }
    return {
      ...result,
      artifactPath: input.outputPath,
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function runChromeMermaidRender(input: { chromePath: string; userDataDir: string; pageUrl: string }) {
  let chrome: ChildProcessWithoutNullStreams
  try {
    chrome = spawn(input.chromePath, [
      "--headless=new",
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
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (error) {
    throw mermaidRenderError("chrome-startup-failed", `Failed to start Chrome/Edge executable: ${formatErrorMessage(error)}`, {
      chromePath: input.chromePath,
      ...diagnosticSnippets(error),
    })
  }
  let stderr = ""
  let stdout = ""
  let processError: Error | undefined
  chrome.stderr.setEncoding("utf8")
  chrome.stdout.setEncoding("utf8")
  chrome.stderr.on("data", (chunk) => { stderr += String(chunk) })
  chrome.stdout.on("data", (chunk) => { stdout += String(chunk) })
  chrome.once("error", (error) => { processError = error })
  try {
    const wsUrl = await waitForDevtoolsWsUrl(chrome, () => `${stderr}\n${stdout}`, () => processError)
    const cdp = await ChromeCdpConnection.open(wsUrl)
    try {
      const target = await cdp.send<{ targetId: string }>("Target.createTarget", { url: input.pageUrl })
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true })
      const sessionId = attached.sessionId
      await cdp.send("Runtime.enable", {}, sessionId)
      await cdp.send("Page.enable", {}, sessionId)
      const deadline = Date.now() + 45000
      while (Date.now() < deadline) {
        const status = await evaluateString(cdp, sessionId, "document.body ? (document.body.getAttribute('data-status') || 'pending') : 'pending'")
        const text = await evaluateString(cdp, sessionId, "document.body ? (document.body.textContent || '') : ''")
        if (status === "ok") {
          const width = Math.min(12000, Math.max(64, await evaluateNumber(cdp, sessionId, "Math.ceil(document.documentElement.scrollWidth || document.body.scrollWidth || 800)")))
          const height = Math.min(12000, Math.max(64, await evaluateNumber(cdp, sessionId, "Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 600)")))
          await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false }, sessionId)
          await delay(100)
          const screenshot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            clip: { x: 0, y: 0, width, height, scale: 1 },
          }, sessionId)
          const bytes = Uint8Array.from(Buffer.from(screenshot.data, "base64"))
          return { bytes, width, height }
        }
        if (status === "error" || status === "timeout") {
          throw mermaidRenderError(status === "timeout" ? "mermaid-render-timeout" : "mermaid-render-failed", `Chrome Mermaid render failed status=${status}: ${bounded(text)}`, {
            chromePath: input.chromePath,
            stderrSnippet: bounded(stderr),
            stdoutSnippet: bounded(stdout),
          })
        }
        await delay(250)
      }
      throw mermaidRenderError("mermaid-render-timeout", "Chrome Mermaid render timed out.", {
        chromePath: input.chromePath,
        stderrSnippet: bounded(stderr),
        stdoutSnippet: bounded(stdout),
      })
    } finally {
      await cdp.close().catch(() => undefined)
    }
  } finally {
    await terminateChrome(chrome)
  }
}

async function waitForDevtoolsWsUrl(chrome: ChildProcessWithoutNullStreams, output: () => string, processError?: () => Error | undefined) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const startupError = processError?.()
    if (startupError) throw mermaidRenderError("chrome-startup-failed", `Chrome process failed to start: ${formatErrorMessage(startupError)}`, diagnosticSnippets(startupError))
    const text = output()
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text)
    if (match?.[1]) return match[1]
    if (chrome.exitCode !== null) throw mermaidRenderError("chrome-startup-failed", "Chrome exited before DevTools was ready.", diagnosticSnippets(text))
    await delay(100)
  }
  throw mermaidRenderError("chrome-devtools-failed", "Timed out waiting for Chrome DevTools endpoint.", diagnosticSnippets(output()))
}

async function evaluateString(cdp: ChromeCdpConnection, sessionId: string, expression: string) {
  const result = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false,
  }, sessionId)
  return String(result.result?.value ?? "")
}

async function evaluateNumber(cdp: ChromeCdpConnection, sessionId: string, expression: string) {
  const value = Number(await evaluateString(cdp, sessionId, expression))
  return Number.isFinite(value) ? value : 0
}

async function terminateChrome(chrome: ChildProcessWithoutNullStreams) {
  const waitForClose = new Promise<void>((resolveClose) => {
    if (chrome.exitCode !== null) {
      resolveClose()
      return
    }
    chrome.once("close", () => resolveClose())
  })
  if (chrome.exitCode === null) chrome.kill("SIGTERM")
  await Promise.race([waitForClose, delay(2000)])
  if (chrome.exitCode === null) {
    chrome.kill("SIGKILL")
    await Promise.race([waitForClose, delay(1000)])
  }
  chrome.stdout.destroy()
  chrome.stderr.destroy()
}

async function renderMermaidToPngRemote(input: {
  endpoint: string
  source: string
  filename?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<MermaidPngRenderResult> {
  if (!input.source.trim()) throw mermaidRenderError("mermaid-render-failed", "Mermaid source is empty.", { remoteEndpoint: input.endpoint })
  const timeoutMs = Math.max(5000, Math.min(Number(input.timeoutMs) || 60000, 120000))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  input.signal?.addEventListener("abort", abort, { once: true })
  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: input.source,
        filename: input.filename || "diagram.mmd",
        timeoutMs,
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(text) as Record<string, unknown>
    } catch (error) {
      throw mermaidRenderError("remote-invalid-response", `Remote Mermaid render response was not valid JSON: ${formatErrorMessage(error)}`, {
        remoteEndpoint: input.endpoint,
        httpStatus: response.status,
        stdoutSnippet: bounded(text),
      })
    }
    if (!response.ok) {
      throw remoteMermaidError(payload, "remote-unavailable", `HTTP ${response.status}: ${text.slice(0, 1000) || response.statusText}`, input.endpoint, response.status)
    }
    if (payload.ok !== true) {
      throw remoteMermaidError(payload, "remote-render-failed", "Remote Mermaid render returned ok=false.", input.endpoint, response.status)
    }
    const png = recordValue(payload.png)
    if (stringValue(png.contentType) !== "image/png") {
      throw remoteMermaidError(payload, "remote-invalid-response", `Remote Mermaid render returned unsupported png.contentType: ${stringValue(png.contentType) || "(missing)"}`, input.endpoint, response.status)
    }
    const bytes = Buffer.from(stringValue(png.base64), "base64")
    if (!bytes.length) {
      throw remoteMermaidError(payload, "remote-invalid-response", "Remote Mermaid render response png.base64 is empty.", input.endpoint, response.status)
    }
    const dimensions = pngDimensions(bytes)
    return {
      bytes: Uint8Array.from(bytes),
      width: positiveInteger(payload.width) ?? dimensions.width,
      height: positiveInteger(payload.height) ?? dimensions.height,
    }
  } catch (error) {
    if (input.signal?.aborted) throw error
    if (error instanceof MermaidPngRenderError) throw error
    const code = error instanceof Error && error.name === "AbortError" ? "remote-timeout" : "remote-unavailable"
    throw mermaidRenderError(code, formatErrorMessage(error), { remoteEndpoint: input.endpoint })
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abort)
  }
}

function remoteMermaidError(payload: Record<string, unknown>, fallbackCode: MermaidPngRenderErrorCode, fallbackMessage: string, endpoint: string, httpStatus?: number) {
  const issues = arrayRecords(payload.issues).map((item) => ({
    severity: stringValue(item.severity),
    code: stringValue(item.code),
    message: stringValue(item.message),
  }))
  const firstIssue = issues.find((item) => item.message)
  const issueCode = firstIssue?.code
  const errorCode: MermaidPngRenderErrorCode = issueCode && REMOTE_ERROR_CODES.has(issueCode as MermaidPngRenderErrorCode) ? issueCode as MermaidPngRenderErrorCode : fallbackCode
  return mermaidRenderError(errorCode, firstIssue?.message || fallbackMessage, {
    remoteEndpoint: endpoint,
    httpStatus,
    issues,
  })
}

class ChromeCdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  private constructor(private readonly socket: WebSocketLike) {
    this.socket.addEventListener("message", (event) => this.handleMessage(String(event.data)))
    this.socket.addEventListener("error", () => this.rejectAll(new Error("Chrome DevTools websocket error.")))
    this.socket.addEventListener("close", () => this.rejectAll(new Error("Chrome DevTools websocket closed.")))
  }

  static async open(url: string) {
    const WebSocketCtor = (globalThis as typeof globalThis & { WebSocket?: WebSocketConstructor }).WebSocket
    if (!WebSocketCtor) throw new Error("Global WebSocket is unavailable; cannot connect to Chrome DevTools.")
    const socket = new WebSocketCtor(url)
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error("Timed out connecting to Chrome DevTools websocket.")), 10000)
      socket.addEventListener("open", () => {
        clearTimeout(timeout)
        resolveOpen()
      }, { once: true })
      socket.addEventListener("error", () => {
        clearTimeout(timeout)
        rejectOpen(new Error("Failed to connect to Chrome DevTools websocket."))
      }, { once: true })
    })
    return new ChromeCdpConnection(socket)
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params }
    return new Promise<T>((resolveSend, rejectSend) => {
      this.pending.set(id, {
        resolve: (value) => resolveSend(value as T),
        reject: rejectSend,
      })
      this.socket.send(JSON.stringify(message))
    })
  }

  async close() {
    if (this.socket.readyState === WEBSOCKET_OPEN) {
      await this.send("Browser.close").catch(() => undefined)
    }
    if (this.socket.readyState === WEBSOCKET_CLOSED) return
    await new Promise<void>((resolveClose) => {
      const timeout = setTimeout(resolveClose, 500)
      this.socket.addEventListener("close", () => {
        clearTimeout(timeout)
        resolveClose()
      }, { once: true })
      this.socket.close()
    })
    this.rejectAll(new Error("Chrome DevTools websocket closed."))
  }

  private handleMessage(data: string) {
    const message = JSON.parse(data) as { id?: number; result?: unknown; error?: { message?: string } }
    if (message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message || "Chrome DevTools command failed."))
    else pending.resolve(message.result)
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export function findChrome(options: ChromeDiscoveryOptions = {}) {
  return discoverChrome(options).path
}

export function discoverChrome(options: ChromeDiscoveryOptions = {}): ChromeDiscoveryResult {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const runCommand = options.runCommand ?? runDiscoveryCommand
  const checked: ChromeDiscoveryCandidate[] = []

  for (const candidate of chromePathCandidates(env, platform)) {
    checked.push(candidate)
    if (candidate.value && exists(candidate.value)) return { path: candidate.value, checked }
  }

  for (const command of chromeCommandCandidates(env, platform)) {
    const source = platform === "win32" ? `where.exe ${command}` : `which ${command}`
    const result = runCommand(platform === "win32" ? "where.exe" : "which", [command])
    const found = firstCommandPath(result.stdout)
    const candidate: ChromeDiscoveryCandidate = { kind: "command", source, value: command, found }
    checked.push(candidate)
    if (result.status === 0 && found) return { path: found, checked }
  }

  return { path: "", checked }
}

export function formatChromeDiscoveryFailure(result: ChromeDiscoveryResult) {
  const checked = result.checked.map(formatCheckedChromeCandidate).join("; ")
  return [
    "No Chrome/Edge executable found for Mermaid PNG rendering.",
    checked ? `Checked: ${checked}.` : "No Chrome/Edge candidates were checked.",
    "Install Chrome or Edge, or set CHROME_PATH only when the browser lives in a non-standard location.",
  ].join(" ")
}

function chromePathCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ChromeDiscoveryCandidate[] {
  const candidates: ChromeDiscoveryCandidate[] = []
  const chromePath = normalizeChromePath(env.CHROME_PATH)
  if (chromePath) candidates.push({ kind: "path", source: "CHROME_PATH", value: chromePath })
  if (platform === "darwin") {
    candidates.push(
      { kind: "path", source: "macOS Google Chrome", value: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { kind: "path", source: "macOS Chromium", value: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
      { kind: "path", source: "macOS Microsoft Edge", value: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
    )
  }
  if (platform === "win32") {
    const programFiles = envValue(env, "ProgramFiles", "PROGRAMFILES")
    const programFilesX86 = envValue(env, "ProgramFiles(x86)", "PROGRAMFILES(X86)")
    const localAppData = envValue(env, "LOCALAPPDATA", "LocalAppData")
    if (programFiles) {
      candidates.push(
        { kind: "path", source: "%ProgramFiles% Google Chrome", value: pathWin32.join(programFiles, "Google", "Chrome", "Application", "chrome.exe") },
        { kind: "path", source: "%ProgramFiles% Microsoft Edge", value: pathWin32.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe") },
      )
    }
    if (programFilesX86) {
      candidates.push(
        { kind: "path", source: "%ProgramFiles(x86)% Google Chrome", value: pathWin32.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe") },
        { kind: "path", source: "%ProgramFiles(x86)% Microsoft Edge", value: pathWin32.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe") },
      )
    }
    if (localAppData) {
      candidates.push(
        { kind: "path", source: "%LOCALAPPDATA% Google Chrome", value: pathWin32.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") },
        { kind: "path", source: "%LOCALAPPDATA% Microsoft Edge", value: pathWin32.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe") },
      )
    }
  }
  return candidates
}

function chromeCommandCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const commands: string[] = []
  const chromePath = normalizeChromePath(env.CHROME_PATH)
  if (chromePath && !hasPathSeparator(chromePath) && !hasWindowsDrivePrefix(chromePath)) commands.push(chromePath)
  if (platform === "win32") commands.push("chrome.exe", "msedge.exe", "chromium.exe")
  else commands.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")
  return [...new Set(commands)]
}

function normalizeChromePath(value: string | undefined) {
  let current = value?.trim() ?? ""
  for (let index = 0; index < 2; index += 1) {
    if ((current.startsWith('"') && current.endsWith('"')) || (current.startsWith("'") && current.endsWith("'"))) {
      current = current.slice(1, -1).trim()
    }
  }
  return current
}

function envValue(env: NodeJS.ProcessEnv, ...keys: string[]) {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return ""
}

function hasPathSeparator(value: string) {
  return value.includes("/") || value.includes("\\")
}

function hasWindowsDrivePrefix(value: string) {
  return /^[a-zA-Z]:/.test(value)
}

function firstCommandPath(stdout: string | Buffer | null | undefined) {
  const text = String(stdout ?? "")
  return text.split(/\r?\n/).map((line) => normalizeChromePath(line)).find(Boolean) ?? ""
}

function runDiscoveryCommand(command: string, args: string[]): ChromeDiscoveryCommandResult {
  return spawnSync(command, args, { encoding: "utf8" })
}

function formatCheckedChromeCandidate(candidate: ChromeDiscoveryCandidate) {
  if (candidate.kind === "command") return candidate.found ? `${candidate.source} -> ${candidate.found}` : candidate.source
  return `${candidate.source}: ${candidate.value}`
}

function formatCheckedChromeCandidates(candidates: ChromeDiscoveryCandidate[]) {
  return candidates.map(formatCheckedChromeCandidate)
}

function isChromeStartupFailure(error: unknown) {
  const message = formatErrorMessage(error)
  return /DevTools|headless|Chrome exited|Browser\.close|websocket|remote debugging/i.test(message)
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function mermaidRenderError(errorCode: MermaidPngRenderErrorCode, message: string, detail: Partial<MermaidPngRenderDiagnostic> = {}) {
  return new MermaidPngRenderError({
    errorCode,
    message: bounded(message),
    platform: process.platform,
    cwd: process.cwd(),
    nodeVersion: process.version,
    checkedChromeCandidates: detail.checkedChromeCandidates,
    chromePath: detail.chromePath,
    stderrSnippet: detail.stderrSnippet ? bounded(detail.stderrSnippet) : undefined,
    stdoutSnippet: detail.stdoutSnippet ? bounded(detail.stdoutSnippet) : undefined,
    remoteEndpoint: detail.remoteEndpoint,
    httpStatus: detail.httpStatus,
    issues: detail.issues,
    remoteFailure: detail.remoteFailure,
    localFailure: detail.localFailure,
  })
}

function diagnosticFromError(error: unknown, fallback: Partial<MermaidPngRenderDiagnostic> & { errorCode: MermaidPngRenderErrorCode; message: string }) {
  if (error instanceof MermaidPngRenderError) return error.diagnostic
  return mermaidRenderError(fallback.errorCode, fallback.message, fallback).diagnostic
}

function withChromePath(error: MermaidPngRenderError, chromePath: string) {
  if (error.diagnostic.chromePath) return error
  return new MermaidPngRenderError({ ...error.diagnostic, chromePath })
}

function diagnosticSnippets(input: unknown): Partial<MermaidPngRenderDiagnostic> {
  if (typeof input === "string") return { stderrSnippet: bounded(input) }
  const message = formatErrorMessage(input)
  return { stderrSnippet: bounded(message) }
}

function renderMermaidHtml(mermaidRuntimeUrl: string, source: string) {
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
    "const timeout = setTimeout(() => fail('timeout', 'Mermaid render timed out in webview page.'), 30000);",
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
  ].join("")
}

function assertPng(bytes: Uint8Array) {
  if (bytes.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new Error("Mermaid renderer did not return a valid PNG.")
  }
}

function bounded(input: string) {
  return input.replace(/\s+/g, " ").trim().slice(0, 2000)
}

function normalizeRemoteMermaidEndpoint(input: string | undefined) {
  const trimmed = input?.trim().replace(/\/+$/, "") ?? ""
  if (!trimmed) return ""
  if (/\/render\/mermaid$/i.test(trimmed)) return trimmed
  if (/\/render\/word$/i.test(trimmed)) return trimmed.replace(/\/render\/word$/i, "/render/mermaid")
  return `${trimmed}/render/mermaid`
}

function redactedEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint)
    url.username = ""
    url.password = ""
    return url.toString()
  } catch {
    return endpoint
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(recordValue).filter((item) => Object.keys(item).length > 0) : []
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : ""
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function pngDimensions(bytes: Uint8Array | Buffer) {
  if (bytes.length >= 24 && bytes[0] === PNG_SIGNATURE[0] && bytes[1] === PNG_SIGNATURE[1] && bytes[2] === PNG_SIGNATURE[2] && bytes[3] === PNG_SIGNATURE[3]) {
    return {
      width: Number(Buffer.from(bytes).readUInt32BE(16)),
      height: Number(Buffer.from(bytes).readUInt32BE(20)),
    }
  }
  return { width: 1, height: 1 }
}
