import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type RunnerMode = "smoke" | "full" | "offline-smoke"
export type InstallMode = "already-installed"
export type ProfileMode = "direct-real"
export type WindowActivationStrategy = "auto"

export type WindowActivationConfig = {
  strategy: WindowActivationStrategy
  processNameRegex: string
  titleRegex: string
  workspaceTitleHint: string
  timeoutMs: number
}

export type TestConfig = {
  installMode: InstallMode
  profileMode: ProfileMode
  extensionId: string
  codeCmd: string
  realUserDataDir: string
  realExtensionsDir?: string
  workspace: string
  provider: {
    apiBaseUrl: string
    chatModel: string
    apiKey: string
  }
  completion: {
    enabled: boolean
    provider: string
    profile: string
    model: string
  }
  rag: {
    embeddingEndpoint: string
    embeddingModel: string
    rerankEndpoint: string
    rerankModel: string
    allowedHosts: string[]
  }
  mode: RunnerMode | "intranet-full"
  timeouts: {
    startupMs: number
    chatMs: number
    completionMs: number
    indexMs: number
  }
  windowActivation: WindowActivationConfig
}

export type CliOptions = {
  bundleRoot: string
  configPath: string
  mode: RunnerMode
  reportRoot: string
}

export function parseCli(args: string[]): CliOptions {
  const options: Partial<CliOptions> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--bundle-root") {
      options.bundleRoot = readValue(args, ++index, arg)
      continue
    }
    if (arg === "--config") {
      options.configPath = readValue(args, ++index, arg)
      continue
    }
    if (arg === "--mode") {
      options.mode = readMode(readValue(args, ++index, arg))
      continue
    }
    if (arg === "--report-root") {
      options.reportRoot = readValue(args, ++index, arg)
      continue
    }
    throw new Error(`Unexpected argument: ${arg}`)
  }
  const bundleRoot = resolve(options.bundleRoot ?? process.cwd())
  return {
    bundleRoot,
    configPath: resolvePath(bundleRoot, options.configPath ?? join(bundleRoot, "test-config.json")),
    mode: options.mode ?? "smoke",
    reportRoot: resolvePath(bundleRoot, options.reportRoot ?? join(bundleRoot, "reports")),
  }
}

export function readConfig(options: CliOptions): TestConfig {
  if (!existsSync(options.configPath)) {
    throw new Error(`Config file not found: ${options.configPath}. Copy test-config.example.json to test-config.json first.`)
  }
  const raw = JSON.parse(readFileSync(options.configPath, "utf8")) as Partial<TestConfig>
  const apiKey = process.env.CHIPMATE_UI_PROVIDER_API_KEY ?? raw.provider?.apiKey ?? ""
  const installMode = raw.installMode ?? "already-installed"
  const profileMode = raw.profileMode ?? "direct-real"
  const windowActivation = (raw.windowActivation ?? {}) as Partial<WindowActivationConfig>
  if (installMode !== "already-installed") throw new Error(`installMode must be "already-installed", got ${installMode}`)
  if (profileMode !== "direct-real") throw new Error(`profileMode must be "direct-real", got ${profileMode}`)
  if (windowActivation.strategy && windowActivation.strategy !== "auto") throw new Error(`windowActivation.strategy must be "auto", got ${windowActivation.strategy}`)
  validateRegex(windowActivation.processNameRegex ?? "^Code", "windowActivation.processNameRegex")
  if (windowActivation.titleRegex) validateRegex(windowActivation.titleRegex, "windowActivation.titleRegex")
  const config: TestConfig = {
    installMode,
    profileMode,
    extensionId: raw.extensionId?.trim() || "local.chipmate",
    codeCmd: requireString(raw.codeCmd, "codeCmd"),
    realUserDataDir: requireString(raw.realUserDataDir, "realUserDataDir"),
    realExtensionsDir: raw.realExtensionsDir,
    workspace: requireString(raw.workspace, "workspace"),
    provider: {
      apiBaseUrl: raw.provider?.apiBaseUrl ?? "",
      chatModel: raw.provider?.chatModel ?? "",
      apiKey,
    },
    completion: {
      enabled: raw.completion?.enabled !== false,
      provider: raw.completion?.provider ?? "qwen-direct",
      profile: raw.completion?.profile ?? "qwen-coder-fim",
      model: raw.completion?.model ?? "qwen-coder-30b0",
    },
    rag: {
      embeddingEndpoint: raw.rag?.embeddingEndpoint ?? "",
      embeddingModel: raw.rag?.embeddingModel ?? "qwen3-embedding-8b",
      rerankEndpoint: raw.rag?.rerankEndpoint ?? "",
      rerankModel: raw.rag?.rerankModel ?? "qwen3-reranker-8b",
      allowedHosts: Array.isArray(raw.rag?.allowedHosts) ? raw.rag.allowedHosts : [],
    },
    mode: raw.mode ?? options.mode,
    timeouts: {
      startupMs: raw.timeouts?.startupMs ?? 60_000,
      chatMs: raw.timeouts?.chatMs ?? 180_000,
      completionMs: raw.timeouts?.completionMs ?? 90_000,
      indexMs: raw.timeouts?.indexMs ?? 600_000,
    },
    windowActivation: {
      strategy: "auto",
      processNameRegex: windowActivation.processNameRegex ?? "^Code",
      titleRegex: windowActivation.titleRegex ?? "",
      workspaceTitleHint: windowActivation.workspaceTitleHint ?? "",
      timeoutMs: windowActivation.timeoutMs ?? 45_000,
    },
  }
  return config
}

export function resolveWorkspace(bundleRoot: string, configPath: string, workspace: string) {
  if (isAbsolute(workspace)) return workspace
  const fromConfig = resolve(dirname(configPath), workspace)
  if (existsSync(fromConfig)) return fromConfig
  return resolve(bundleRoot, workspace)
}

export function hasProvider(config: TestConfig) {
  return Boolean(config.provider.apiBaseUrl && config.provider.chatModel)
}

function readMode(value: string): RunnerMode {
  if (value === "full" || value === "offline-smoke" || value === "smoke") return value
  throw new Error(`Invalid --mode ${value}`)
}

function readValue(args: string[], index: number, flag: string) {
  const value = args[index]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
  return value
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function validateRegex(pattern: string, label: string) {
  try {
    new RegExp(pattern)
  } catch (error) {
    throw new Error(`${label} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function resolvePath(bundleRoot: string, input: string) {
  return isAbsolute(input) ? input : resolve(bundleRoot, input)
}
