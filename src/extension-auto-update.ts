import { createHash } from "node:crypto"
import * as path from "node:path"
import * as vscode from "vscode"
import { compareExtensionVersions } from "./extension-version"

const AUTO_UPDATE_LAST_CHECK_AT_KEY = "chipmate.autoUpdate.lastCheckAt"
const AUTO_UPDATE_NEXT_PROMPT_AT_KEY = "chipmate.autoUpdate.nextPromptAt"
const AUTO_UPDATE_DECLINED_VERSION_KEY = "chipmate.autoUpdate.declinedVersion"
const AUTO_UPDATE_INSTALLING_VERSION_KEY = "chipmate.autoUpdate.installingVersion"
const DEFAULT_CHECK_INTERVAL_HOURS = 24
const MIN_CHECK_INTERVAL_HOURS = 1
const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
const MANIFEST_TIMEOUT_MS = 10000
const DOWNLOAD_TIMEOUT_MS = 120000
const FIRST_CHECK_DELAY_MS = 5000
const INSTALL_VERIFY_RETRIES = 20
const INSTALL_VERIFY_DELAY_MS = 500
const UPGRADE_ACTION = "升级"
const LATER_ACTION = "明天再说"

export interface ExtensionUpdateReloadController {
  check(reason: string): void
}

interface AutoUpdateSettings {
  enabled: boolean
  manifestUrl: string
  checkIntervalHours: number
  maxDownloadBytes: number
}

interface UpdatePackageInfo {
  extensionId: string
  publisher: string
  name: string
  version: string
  filename: string
  url: string
  sha256: string
  sizeBytes: number
  mtimeMs: number
}

interface UpdateCandidate {
  latest: UpdatePackageInfo
  downloadUrl: string
}

interface RegisterAutoUpdateInput {
  context: vscode.ExtensionContext
  output: vscode.OutputChannel
  reloadController: ExtensionUpdateReloadController
}

export function registerExtensionAutoUpdate(input: RegisterAutoUpdateInput) {
  const { context, output, reloadController } = input
  let timer: ReturnType<typeof setTimeout> | undefined
  let checkInFlight: Promise<void> | undefined
  const log = (message: string) => output.appendLine(`[auto-update] ${message}`)
  const extensionId = context.extension.id || "local.chipmate"
  const runningVersion = readPackageJsonVersion(context.extension.packageJSON)

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  const schedule = (delayMs: number) => {
    clearTimer()
    timer = setTimeout(() => {
      timer = undefined
      runCheck("timer")
    }, delayMs)
  }
  const scheduleNextFromSettings = () => {
    const settings = readAutoUpdateSettings()
    const delayMs = Math.max(MIN_CHECK_INTERVAL_HOURS, settings.checkIntervalHours) * 60 * 60 * 1000
    schedule(delayMs)
  }
  const runCheck = (reason: string) => {
    if (checkInFlight) return
    checkInFlight = checkForUpdate({
      context,
      extensionId,
      runningVersion,
      log,
      reloadController,
      reason,
    }).finally(() => {
      checkInFlight = undefined
      scheduleNextFromSettings()
    })
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("chipmate.updates") && !event.affectsConfiguration("chipmate.wordRender.remoteEndpoint")) return
      log("event=config-changed")
      clearTimer()
      runCheck("configuration")
    }),
    new vscode.Disposable(clearTimer),
  )

  if (!runningVersion) {
    log(`event=disabled skipReason=no-running-version extensionId=${extensionId}`)
    return
  }

  log(`event=registered extensionId=${extensionId} runningVersion=${runningVersion}`)
  schedule(FIRST_CHECK_DELAY_MS)
}

async function checkForUpdate(input: {
  context: vscode.ExtensionContext
  extensionId: string
  runningVersion: string | undefined
  reason: string
  log: (message: string) => void
  reloadController: ExtensionUpdateReloadController
}) {
  const { context, extensionId, runningVersion, log, reason, reloadController } = input
  const settings = readAutoUpdateSettings()
  const manifestUrl = deriveManifestUrl(settings.manifestUrl, readWordRenderRemoteEndpoint())
  log(`event=check-start reason=${reason} enabled=${settings.enabled} manifest=${manifestUrl ? safeUrlForLog(manifestUrl) : "none"}`)
  if (!settings.enabled) {
    log(`event=check-result reason=${reason} decision=skip skipReason=disabled`)
    return
  }
  if (!runningVersion) {
    log(`event=check-result reason=${reason} decision=skip skipReason=no-running-version`)
    return
  }
  if (!manifestUrl) {
    log(`event=check-result reason=${reason} decision=skip skipReason=no-render-service`)
    return
  }

  const now = Date.now()
  const lastCheckAt = context.globalState.get<number>(AUTO_UPDATE_LAST_CHECK_AT_KEY, 0)
  const minIntervalMs = Math.max(MIN_CHECK_INTERVAL_HOURS, settings.checkIntervalHours) * 60 * 60 * 1000
  if (reason === "timer" && lastCheckAt > 0 && now - lastCheckAt < minIntervalMs) {
    log(`event=check-result reason=${reason} decision=skip skipReason=interval lastCheckAt=${lastCheckAt}`)
    return
  }
  await context.globalState.update(AUTO_UPDATE_LAST_CHECK_AT_KEY, now)

  let candidate: UpdateCandidate
  try {
    const raw = await fetchJson(manifestUrl, MANIFEST_TIMEOUT_MS)
    candidate = validateUpdateManifest(raw, { manifestUrl, extensionId, runningVersion })
  } catch (error) {
    log(`event=check-failed reason=${reason} stage=manifest message=${formatError(error)}`)
    return
  }

  const declinedVersion = context.globalState.get<string>(AUTO_UPDATE_DECLINED_VERSION_KEY)
  const nextPromptAt = context.globalState.get<number>(AUTO_UPDATE_NEXT_PROMPT_AT_KEY, 0)
  if (shouldSuppressPrompt(candidate.latest.version, declinedVersion, nextPromptAt, now)) {
    log(`event=check-result reason=${reason} decision=skip skipReason=declined version=${candidate.latest.version} nextPromptAt=${nextPromptAt}`)
    return
  }

  const selected = await vscode.window.showInformationMessage(`发现 ChipMate 新版本 ${candidate.latest.version}，是否现在升级？`, UPGRADE_ACTION, LATER_ACTION)
  if (selected !== UPGRADE_ACTION) {
    await context.globalState.update(AUTO_UPDATE_DECLINED_VERSION_KEY, candidate.latest.version)
    await context.globalState.update(AUTO_UPDATE_NEXT_PROMPT_AT_KEY, now + 24 * 60 * 60 * 1000)
    log(`event=prompt-selection reason=${reason} version=${candidate.latest.version} selected=later`)
    return
  }

  await context.globalState.update(AUTO_UPDATE_INSTALLING_VERSION_KEY, candidate.latest.version)
  try {
    const vsixUri = await downloadUpdatePackage(context, candidate, settings.maxDownloadBytes, log)
    await vscode.commands.executeCommand("workbench.extensions.installExtension", vsixUri)
    await waitForInstalledVersion(extensionId, candidate.latest.version)
    await context.globalState.update(AUTO_UPDATE_DECLINED_VERSION_KEY, undefined)
    await context.globalState.update(AUTO_UPDATE_NEXT_PROMPT_AT_KEY, undefined)
    log(`event=install-complete version=${candidate.latest.version} filename=${candidate.latest.filename}`)
    reloadController.check("auto-update-installed")
  } catch (error) {
    log(`event=install-failed version=${candidate.latest.version} filename=${candidate.latest.filename} message=${formatError(error)}`)
    void vscode.window.showErrorMessage("ChipMate 自动升级失败，请查看 ChipMate Output")
  } finally {
    await context.globalState.update(AUTO_UPDATE_INSTALLING_VERSION_KEY, undefined)
  }
}

export function readAutoUpdateSettings(configuration = vscode.workspace.getConfiguration("chipmate")): AutoUpdateSettings {
  const checkIntervalHours = clampInteger(configuration.get<number>("updates.checkIntervalHours", DEFAULT_CHECK_INTERVAL_HOURS), MIN_CHECK_INTERVAL_HOURS, 24 * 30)
  const maxDownloadBytes = clampInteger(configuration.get<number>("updates.maxDownloadBytes", DEFAULT_MAX_DOWNLOAD_BYTES), 1024 * 1024, 2 * 1024 * 1024 * 1024)
  return {
    enabled: configuration.get<boolean>("updates.enabled", true),
    manifestUrl: configuration.get<string>("updates.manifestUrl", "").trim(),
    checkIntervalHours,
    maxDownloadBytes,
  }
}

export function deriveManifestUrl(configuredManifestUrl: string, wordRenderEndpoint: string) {
  const configured = configuredManifestUrl.trim()
  if (configured) return normalizeHttpUrl(configured)
  const base = normalizeRenderServiceBaseUrl(wordRenderEndpoint)
  if (!base) return undefined
  return new URL("/packages/manifest.json", base).toString()
}

export function validateUpdateManifest(raw: unknown, input: { manifestUrl: string; extensionId: string; runningVersion: string }): UpdateCandidate {
  if (!isRecord(raw) || raw.ok !== true || raw.schemaVersion !== 1) throw new Error("manifest schema is invalid")
  const latest = raw.latest
  if (!isRecord(latest)) throw new Error("manifest latest package is missing")
  const candidate: UpdatePackageInfo = {
    extensionId: requireString(latest.extensionId, "latest.extensionId"),
    publisher: requireString(latest.publisher, "latest.publisher"),
    name: requireString(latest.name, "latest.name"),
    version: requireString(latest.version, "latest.version"),
    filename: requireString(latest.filename, "latest.filename"),
    url: requireString(latest.url, "latest.url"),
    sha256: requireSha256(latest.sha256),
    sizeBytes: requirePositiveNumber(latest.sizeBytes, "latest.sizeBytes"),
    mtimeMs: requirePositiveNumber(latest.mtimeMs, "latest.mtimeMs"),
  }
  if (candidate.extensionId !== input.extensionId) throw new Error("manifest latest extensionId does not match current extension")
  if (compareExtensionVersions(candidate.version, input.runningVersion) <= 0) throw new Error("manifest latest version is not newer")
  const downloadUrl = resolvePackageDownloadUrl(input.manifestUrl, candidate.url)
  return { latest: candidate, downloadUrl }
}

export function shouldSuppressPrompt(version: string, declinedVersion: string | undefined, nextPromptAt: number | undefined, now: number) {
  return declinedVersion === version && typeof nextPromptAt === "number" && now < nextPromptAt
}

export function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function fetchJson(url: string, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function downloadUpdatePackage(context: vscode.ExtensionContext, candidate: UpdateCandidate, maxDownloadBytes: number, log: (message: string) => void) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(candidate.downloadUrl, { signal: controller.signal })
    if (!response.ok) throw new Error(`download HTTP ${response.status}`)
    const contentLength = Number(response.headers.get("content-length") || "0")
    if (contentLength > maxDownloadBytes) throw new Error(`download content-length exceeds ${maxDownloadBytes}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxDownloadBytes) throw new Error(`download size exceeds ${maxDownloadBytes}`)
    const actualSha256 = sha256Hex(bytes)
    if (actualSha256 !== candidate.latest.sha256) throw new Error("download sha256 mismatch")
    const updatesDir = vscode.Uri.joinPath(context.globalStorageUri, "updates")
    await vscode.workspace.fs.createDirectory(updatesDir)
    const filename = safeDownloadFilename(candidate.latest.filename)
    const vsixUri = vscode.Uri.joinPath(updatesDir, filename)
    await vscode.workspace.fs.writeFile(vsixUri, bytes)
    log(`event=download-complete version=${candidate.latest.version} filename=${filename} bytes=${bytes.byteLength}`)
    return vscode.Uri.file(vsixUri.fsPath)
  } finally {
    clearTimeout(timer)
  }
}

async function waitForInstalledVersion(extensionId: string, version: string) {
  for (let index = 0; index < INSTALL_VERIFY_RETRIES; index += 1) {
    const installedVersion = readPackageJsonVersion(vscode.extensions.getExtension(extensionId)?.packageJSON)
    if (installedVersion === version) return
    await new Promise((resolve) => setTimeout(resolve, INSTALL_VERIFY_DELAY_MS))
  }
  throw new Error(`installed extension metadata did not reach ${version}`)
}

function readWordRenderRemoteEndpoint() {
  return vscode.workspace.getConfiguration("chipmate").get<string>("wordRender.remoteEndpoint", "").trim()
}

function normalizeRenderServiceBaseUrl(endpoint: string) {
  const trimmed = endpoint.trim()
  if (!trimmed) return undefined
  const normalized = normalizeHttpUrl(trimmed)
  if (!normalized) return undefined
  const parsed = new URL(normalized)
  parsed.pathname = parsed.pathname.replace(/\/render\/(?:word|mermaid)\/?$/i, "")
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/"
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString()
}

function normalizeHttpUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function resolvePackageDownloadUrl(manifestUrl: string, packageUrl: string) {
  const manifest = new URL(manifestUrl)
  const resolved = new URL(packageUrl, manifest)
  if (resolved.origin !== manifest.origin) throw new Error("package url must use the manifest origin")
  if (!resolved.pathname.startsWith("/packages/")) throw new Error("package url must stay under /packages/")
  return resolved.toString()
}

function safeDownloadFilename(filename: string) {
  return path.basename(filename).replace(/[^0-9A-Za-z._-]/g, "_")
}

function safeUrlForLog(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return "invalid"
  }
}

function readPackageJsonVersion(packageJSON: unknown) {
  if (!packageJSON || typeof packageJSON !== "object" || !("version" in packageJSON)) return undefined
  const version = (packageJSON as { version?: unknown }).version
  return typeof version === "string" && version.trim() ? version.trim() : undefined
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function requireSha256(value: unknown) {
  const text = requireString(value, "latest.sha256")
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error("latest.sha256 must be a sha256 hex string")
  return text.toLowerCase()
}

function requirePositiveNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`)
  return value
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
