import { spawn } from "node:child_process"
import { accessSync, constants as fsConstants, statSync } from "node:fs"
import { basename, delimiter, isAbsolute, join, resolve } from "node:path"
import {
  inspectTerminalProjectContext,
  terminalProjectContextSummaryLines,
  type TerminalProjectContext,
} from "./agent-terminal-project-context"
import type {
  DirectAgentClient,
  TerminalCommandPlan,
  TerminalCommandResultSummary,
  TerminalCommandResultSummaryInput,
} from "./direct-agent-client"
import {
  ANSI_BOLD,
  ANSI_CYAN,
  ANSI_DIM,
  ANSI_GREEN,
  ANSI_RED,
  ANSI_YELLOW,
  renderTerminalBox,
  styled,
  terminalBoxWidth,
  visibleWidth,
  type TerminalBoxInput,
  type TerminalBoxTone,
} from "./terminal-ui"

const MAX_ACTIVITY_ITEMS = 18
const MAX_ACTIVITY_CHARS = 10000
const COMMAND_TRANSCRIPT_BYTES = 128 * 1024
const COMMAND_OUTPUT_TAIL_BYTES = 8000
const COMMAND_OUTPUT_ACTIVITY_BYTES = 1200
const MAX_REPAIR_ATTEMPTS = 2
const MAX_CLARIFY_TURNS = 2
const MAX_CONFIRM_PROMPT_COMMAND_CHARS = 96

type AgentTerminalOutput = { appendLine: (message: string) => void }
type DisposableLike = { dispose: () => void }
type EventLike<T> = (listener: (value: T) => void) => DisposableLike
type EventEmitterLike<T> = {
  event: EventLike<T>
  fire: (value: T) => void
  dispose: () => void
}

export type AgentTerminalClient =
  Pick<DirectAgentClient, "planTerminalCommand"> &
  Partial<Pick<DirectAgentClient, "summarizeTerminalCommandResult">>

export type AgentTerminalRoute =
  | { kind: "empty"; reason: string }
  | { kind: "agent"; text: string; reason: string }
  | { kind: "command"; command: string; reason: string }

export type AgentTerminalClassifierOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  resolveCommand?: (token: string, cwd: string) => boolean
}

export type AgentTerminalCommandInput = {
  command: string
  cwd: string
  platform?: NodeJS.Platform
  shell?: string
  shellKind?: AgentTerminalShellKind
  signal?: AbortSignal
  onData: (data: string) => void
}

export type AgentTerminalCommandResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  aborted: boolean
  output: string
  elapsedMs: number
}

export type AgentTerminalCommandRisk = "low" | "medium" | "high"
export type AgentTerminalShellKind = "cmd" | "posix" | "powershell" | "unknown"
type AgentTerminalFailureKind = "exit-code" | "incompatible-command" | "missing-command" | "non-interactive" | "signal" | "spawn"
type AgentTerminalRuntime = {
  platform: NodeJS.Platform
  shell: string
  shellKind: AgentTerminalShellKind
}

export type AgentTerminalConfirmCommandInput = {
  command: string
  cwd: string
  source: "agent" | "direct" | "repair"
  risk: AgentTerminalCommandRisk
  explanation?: string
  title?: string
  purpose?: string
  expectedOutcome?: string
  riskNote?: string
  failureBasis?: string
  attempt: number
}

export type AgentTerminalCommandConfirmation = {
  approved: boolean
  command?: string
  reason?: string
}

export type AgentTerminalCommandRunner = (input: AgentTerminalCommandInput) => Promise<AgentTerminalCommandResult>

export type AgentTerminalPtyDeps = {
  getClient: () => AgentTerminalClient | undefined
  output?: AgentTerminalOutput
  initialCwd?: string
  platform?: NodeJS.Platform
  shell?: string
  shellKind?: AgentTerminalShellKind
  commandRunner?: AgentTerminalCommandRunner
  classifyCommandRisk?: (command: string) => AgentTerminalCommandRisk
  resolveCommand?: (token: string, cwd: string) => boolean
  inspectProjectContext?: (input: { cwd: string; signal?: AbortSignal }) => Promise<TerminalProjectContext>
  env?: NodeJS.ProcessEnv
  createEventEmitter?: <T>() => EventEmitterLike<T>
}

type RunningState = {
  kind: "agent" | "command"
  abort: AbortController
}

type LineInteractionKind = "confirm-command" | "edit-command" | "clarify"

type LineInteraction = {
  kind: LineInteractionKind
  prompt: string
  line: string
  cursor: number
  resolve: (value: string | undefined) => void
}

type CommandExecutionFailure = {
  command: string
  result: AgentTerminalCommandResult
  reason: string
  outputTail: string
  failureKind: AgentTerminalFailureKind
  executed: boolean
  missingCommand?: string
  compatibilityReason?: string
  nonInteractiveReason?: string
}

type ExecuteCommandOptions = {
  command: string
  abort: AbortController
  source: "agent" | "direct" | "repair"
  originalRequest?: string
  explanation?: string
  title?: string
  purpose?: string
  expectedOutcome?: string
  riskNote?: string
  failureBasis?: string
  attempt: number
  requiresConfirmation: boolean
}

type FinishCommandOutputInput = {
  command: string
  cwd: string
  result: AgentTerminalCommandResult
  source: ExecuteCommandOptions["source"]
  originalRequest?: string
  title?: string
  purpose?: string
  expectedOutcome?: string
  risk?: AgentTerminalCommandRisk
  failureBasis?: string
  requiresConfirmation: boolean
}

type LocalCommandResultSummary = TerminalCommandResultSummary & {
  confidence: "specific" | "generic"
}

export class AgentTerminalPty {
  private readonly writeEmitter: EventEmitterLike<string>
  private readonly closeEmitter: EventEmitterLike<number | void>
  readonly onDidWrite: EventLike<string>
  readonly onDidClose: EventLike<number | void>

  private readonly commandRunner: AgentTerminalCommandRunner
  private readonly classifyCommandRisk: (command: string) => AgentTerminalCommandRisk
  private readonly runtime: AgentTerminalRuntime
  private readonly terminalActivity: string[] = []
  private cwd: string
  private line = ""
  private lineCursor = 0
  private history: string[] = []
  private historyIndex: number | undefined
  private running: RunningState | undefined
  private interaction: LineInteraction | undefined
  private activeTask: Promise<void> = Promise.resolve()
  private disposed = false
  private atLineStart = true
  private terminalColumns: number | undefined
  private pendingEscape = ""

  constructor(private readonly deps: AgentTerminalPtyDeps) {
    const createEventEmitter = deps.createEventEmitter ?? createSimpleEventEmitter
    this.writeEmitter = createEventEmitter<string>()
    this.closeEmitter = createEventEmitter<number | void>()
    this.onDidWrite = this.writeEmitter.event
    this.onDidClose = this.closeEmitter.event
    this.cwd = deps.initialCwd ?? workspaceRoot()
    this.runtime = resolveAgentTerminalRuntime(deps)
    this.commandRunner = deps.commandRunner ?? runAgentTerminalCommand
    this.classifyCommandRisk = deps.classifyCommandRisk ?? (() => "medium")
  }

  open(initialDimensions?: { columns?: number }) {
    this.setDimensions(initialDimensions)
    this.writeRaw("\x1b[36mChipMate Agent Terminal\x1b[0m\r\n")
    this.writeRaw("Type shell commands directly. Natural language is planned, confirmed, then executed.\r\n")
    this.writePrompt()
  }

  setDimensions(dimensions?: { columns?: number }) {
    if (dimensions?.columns && Number.isFinite(dimensions.columns)) this.terminalColumns = dimensions.columns
  }

  close() {
    this.disposed = true
    this.cancelRunning()
    this.writeEmitter.dispose()
    this.closeEmitter.dispose()
  }

  handleInput(data: string) {
    if (this.disposed) return
    if (this.interaction) {
      this.handleInteractionInput(data)
      return
    }
    if (this.running && data !== "\x03") {
      this.writeRaw("\r\n[busy] Press Ctrl+C to stop the current ChipMate terminal task.\r\n")
      return
    }

    const chars = Array.from(this.pendingEscape + data)
    this.pendingEscape = ""
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index] ?? ""
      if (char === "\x1b") {
        const sequence = parseTerminalEscapeSequence(chars, index)
        if (!sequence.complete) {
          this.pendingEscape = chars.slice(index).join("")
          break
        }
        this.handleInputEscape(sequence.key)
        index += sequence.length - 1
        continue
      }
      if (char === "\r" || char === "\n") {
        if (char === "\r" && chars[index + 1] === "\n") index += 1
        this.submitLine()
        continue
      }
      if (char === "\x03") {
        this.handleCtrlC()
        continue
      }
      if (char === "\x0c") {
        this.clearScreen()
        continue
      }
      if (char === "\x7f" || char === "\b") {
        this.backspace()
        continue
      }
      if (char >= " ") {
        this.insertInputText(char)
      }
    }
  }

  private handleInteractionInput(data: string) {
    const chars = Array.from(this.pendingEscape + data)
    this.pendingEscape = ""
    for (let index = 0; index < chars.length; index += 1) {
      const interaction = this.interaction
      if (!interaction) return
      const char = chars[index] ?? ""
      if (char === "\x1b") {
        const sequence = parseTerminalEscapeSequence(chars, index)
        if (!sequence.complete) {
          this.pendingEscape = chars.slice(index).join("")
          break
        }
        this.handleInteractionEscape(interaction, sequence.key)
        index += sequence.length - 1
        continue
      }
      if (char === "\r" || char === "\n") {
        if (char === "\r" && chars[index + 1] === "\n") index += 1
        const raw = interaction.line
        this.interaction = undefined
        this.writeRaw("\r\n")
        interaction.resolve(raw)
        continue
      }
      if (char === "\x03") {
        this.handleCtrlC()
        continue
      }
      if (char === "\x0c") {
        this.clearInteractionLine(interaction)
        continue
      }
      if (char === "\x7f" || char === "\b") {
        this.backspaceInteraction(interaction)
        continue
      }
      if (char >= " ") {
        this.insertInteractionText(interaction, char)
      }
    }
  }

  async whenIdle() {
    await this.activeTask
  }

  private submitLine() {
    const raw = this.line
    this.line = ""
    this.lineCursor = 0
    this.historyIndex = undefined
    this.writeRaw("\r\n")
    if (raw.trim()) {
      this.history.push(raw)
      if (this.history.length > 100) this.history = this.history.slice(-100)
    }
    this.activeTask = this.runLine(raw).catch((error) => {
      this.log(`[agent-terminal] line failed: ${formatErrorMessage(error)}`)
      this.writeLine(`[error] ${formatErrorMessage(error)}`)
      this.writePrompt()
    })
  }

  private async runLine(raw: string) {
    const route = classifyAgentTerminalInput(raw, {
      cwd: this.cwd,
      env: this.deps.env,
      resolveCommand: this.deps.resolveCommand,
    })
    this.log(`[agent-terminal] route=${route.kind} reason=${route.reason}${route.kind === "command" ? ` command=${route.command}` : ""}`)
    if (route.kind === "empty") {
      this.writePrompt()
      return
    }
    if (route.kind === "agent") {
      await this.runAgentPlan(route.text, raw)
      this.writePrompt()
      return
    }
    await this.runDirectCommand(route.command, raw)
    this.writePrompt()
  }

  private async runDirectCommand(command: string, rawInput: string) {
    if (!command.trim()) return
    if (this.runBuiltin(command)) return

    const abort = new AbortController()
    this.running = { kind: "command", abort }
    try {
      const execution = await this.executeCommand({
        command,
        abort,
        source: "direct",
        originalRequest: rawInput.trim() || command,
        attempt: 0,
        requiresConfirmation: this.classifyCommandRisk(command) === "high",
      })
      if (execution && !execution.result.aborted && isFailedCommand(execution.result)) {
        await this.repairFailedCommand({
          abort,
          originalRequest: rawInput.trim() || command,
          rawInput,
          failed: execution,
          attemptedCommands: [command],
        })
      }
    } finally {
      this.running = undefined
    }
  }

  private async runAgentPlan(text: string, raw: string) {
    const client = this.deps.getClient()
    if (!client) {
      this.writeTerminalBox({
        title: "ChipMate Agent 未就绪",
        tone: "warning",
        sections: [{ body: "当前 ChipMate agent runtime 还没有准备好，无法规划自然语言请求。" }],
      })
      this.log("[agent-terminal] agent skipped: no client")
      return
    }

    const abort = new AbortController()
    this.running = { kind: "agent", abort }
    this.rememberActivity(`? ${text}`)
    this.log("[agent-terminal] planner start mode=initial")
    try {
      const projectContext = await this.inspectProjectContext(abort.signal)
      if (abort.signal.aborted) return
      this.writeAgentStatus("planning command...")
      const plan = await client.planTerminalCommand({
        mode: "initial",
        cwd: this.cwd,
        userText: text,
        rawInput: raw,
        recentActivity: this.activitySnapshot(),
        projectContext,
        platform: this.runtime.platform,
        shell: this.runtime.shell,
        shellKind: this.runtime.shellKind,
        signal: abort.signal,
      })
      await this.handleAgentPlan({
        plan,
        client,
        abort,
        originalRequest: text,
        rawInput: raw,
        attemptedCommands: [],
        clarifyTurns: 0,
        projectContext,
      })
    } catch (error) {
      if (!abort.signal.aborted) {
        this.writeTerminalBox({
          title: "ChipMate 规划失败",
          tone: "danger",
          sections: [{ label: "错误：", body: formatErrorMessage(error) }],
        })
      }
      this.log(`[agent-terminal] planner failed: ${formatErrorMessage(error)}`)
    } finally {
      this.running = undefined
    }
  }

  private async handleAgentPlan(input: {
    plan: TerminalCommandPlan
    client: AgentTerminalClient
    abort: AbortController
    originalRequest: string
    rawInput: string
    attemptedCommands: string[]
    clarifyTurns: number
    projectContext?: TerminalProjectContext
  }) {
    if (input.plan.kind === "answer") {
      this.writeAgentAnswer(input.plan.message, "ChipMate 回答", input.projectContext)
      return
    }
    if (input.plan.kind === "clarify") {
      if (input.clarifyTurns >= MAX_CLARIFY_TURNS) {
        this.writeTerminalBox({
          title: "需要的信息仍不完整",
          tone: "warning",
          sections: [{ body: "澄清次数已达到上限。请带上缺失信息后重新描述你的请求。" }],
        })
        return
      }
      const answer = await this.askClarification(input.plan.question)
      if (!answer || input.abort.signal.aborted) return
      const clarifiedRequest = `${input.originalRequest}\n\nClarification answer: ${answer}`
      this.writeAgentStatus("planning command...")
      const nextPlan = await input.client.planTerminalCommand({
        mode: "initial",
        cwd: this.cwd,
        userText: clarifiedRequest,
        rawInput: input.rawInput,
        recentActivity: this.activitySnapshot(),
        projectContext: input.projectContext,
        platform: this.runtime.platform,
        shell: this.runtime.shell,
        shellKind: this.runtime.shellKind,
        signal: input.abort.signal,
      })
      await this.handleAgentPlan({
        ...input,
        plan: nextPlan,
        originalRequest: clarifiedRequest,
        clarifyTurns: input.clarifyTurns + 1,
      })
      return
    }

    const plannedCommand = normalizePlannedCommand(input.plan.command)
    const execution = await this.executeCommand({
      command: plannedCommand,
      abort: input.abort,
      source: "agent",
      originalRequest: input.originalRequest,
      explanation: input.plan.explanation,
      title: input.plan.title,
      purpose: input.plan.purpose,
      expectedOutcome: input.plan.expectedOutcome,
      riskNote: input.plan.riskNote,
      attempt: 0,
      requiresConfirmation: true,
    })
    if (!execution || execution.result.aborted || !isFailedCommand(execution.result)) return
    await this.repairFailedCommand({
      client: input.client,
      abort: input.abort,
      originalRequest: input.originalRequest,
      rawInput: input.rawInput,
      failed: execution,
      attemptedCommands: [...input.attemptedCommands, plannedCommand],
      projectContext: input.projectContext,
    })
  }

  private async repairFailedCommand(input: {
    client?: AgentTerminalClient
    abort: AbortController
    originalRequest: string
    rawInput: string
    failed: CommandExecutionFailure
    attemptedCommands: string[]
    projectContext?: TerminalProjectContext
  }) {
    const client = input.client ?? this.deps.getClient()
    if (!client) {
      this.log("[agent-terminal] repair skipped: no client")
      return
    }

    let failed = input.failed
    let originalRequest = input.originalRequest
    let repairClarifyTurns = 0
    const attemptedCommands = [...input.attemptedCommands]
    for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
      if (input.abort.signal.aborted) return
      this.writeFailureSummary(failed)
      this.writeAgentStatus("diagnosing failure...")
      this.log(`[agent-terminal] planner start mode=repair attempt=${attempt} failedCommand=${failed.command}`)
      let plan: TerminalCommandPlan
      try {
        plan = await client.planTerminalCommand({
          mode: "repair",
          cwd: this.cwd,
          userText: originalRequest,
          rawInput: input.rawInput,
          recentActivity: this.activitySnapshot(),
          projectContext: input.projectContext,
          failedCommand: failed.command,
          failureKind: failed.failureKind,
          missingCommand: failed.missingCommand,
          repairPreference: failed.failureKind === "missing-command" ? "prefer-no-install-fallback" : undefined,
          platform: this.runtime.platform,
          shell: this.runtime.shell,
          shellKind: this.runtime.shellKind,
          exitCode: failed.result.exitCode,
          signalName: failed.result.signal,
          outputTail: failed.outputTail,
          attemptedCommands: [...attemptedCommands],
          failureReason: failed.reason,
          nonInteractiveReason: failed.nonInteractiveReason,
          signal: input.abort.signal,
        })
      } catch (error) {
        if (!input.abort.signal.aborted) {
          const message = formatErrorMessage(error)
          this.writeRepairPlanningFailure(isTerminalPlannerTruncated(message))
        }
        this.log(`[agent-terminal] repair planner failed attempt=${attempt}: ${formatErrorMessage(error)}`)
        return
      }

      if (plan.kind === "answer") {
        this.writeAgentAnswer(plan.message, "ChipMate 修复建议", input.projectContext)
        return
      }
      if (plan.kind === "clarify") {
        if (repairClarifyTurns >= MAX_CLARIFY_TURNS) {
          this.writeTerminalBox({
            title: "需要的信息仍不完整",
            tone: "warning",
            sections: [{ body: "修复澄清次数已达到上限。请带上失败输出后重新描述你的请求。" }],
          })
          return
        }
        const answer = await this.askClarification(plan.question)
        if (!answer || input.abort.signal.aborted) return
        originalRequest = `${originalRequest}\n\nClarification answer: ${answer}`
        repairClarifyTurns += 1
        attempt -= 1
        continue
      }

      const repairCommand = normalizePlannedCommand(plan.command)
      attemptedCommands.push(repairCommand)
      const execution = await this.executeCommand({
        command: repairCommand,
        abort: input.abort,
        source: "repair",
        originalRequest,
        explanation: plan.explanation,
        title: plan.title,
        purpose: plan.purpose,
        expectedOutcome: plan.expectedOutcome,
        riskNote: plan.riskNote,
        failureBasis: repairBasisText(failed),
        attempt,
        requiresConfirmation: true,
      })
      if (!execution || execution.result.aborted) return
      if (!isFailedCommand(execution.result)) return
      failed = execution
    }

    if (!input.abort.signal.aborted) {
      this.writeTerminalBox({
        title: "修复尝试已用尽",
        tone: "warning",
        sections: [{ body: `ChipMate 已完成 ${MAX_REPAIR_ATTEMPTS} 次修复尝试，没有继续自动规划新命令。` }],
      })
    }
  }

  private async inspectProjectContext(signal: AbortSignal): Promise<TerminalProjectContext | undefined> {
    this.writeAgentStatus("inspecting project...")
    const inspect = this.deps.inspectProjectContext ?? inspectTerminalProjectContext
    try {
      const context = await inspect({ cwd: this.cwd, signal })
      if (signal.aborted) return undefined
      this.writeProjectInspectionSummary(context)
      this.log(
        `[agent-terminal] project context root=${context.root} rootFiles=${context.rootFiles.length} docs=${context.docs.length} truncated=${context.truncated} errors=${context.errors.length}`,
      )
      return context
    } catch (error) {
      if (signal.aborted) return undefined
      const message = formatErrorMessage(error)
      this.writeTerminalBox({
        title: "项目侦察遇到问题",
        tone: "warning",
        sections: [
          { label: "警告：", body: message },
          { body: "ChipMate 会继续规划，但回答会把这个侦察失败作为限制条件。" },
        ],
      })
      this.log(`[agent-terminal] project context failed: ${message}`)
      return {
        cwd: this.cwd,
        root: this.cwd,
        relativeCwd: ".",
        rootFiles: [],
        buildFiles: [],
        buildDirectories: [],
        docs: [],
        snippets: [],
        hints: [],
        truncated: false,
        errors: [message],
      }
    }
  }

  private async executeCommand(input: ExecuteCommandOptions): Promise<CommandExecutionFailure | undefined> {
    let command = input.command
    let risk = this.classifyCommandRisk(command)
    const unavailable = input.source === "direct" ? undefined : this.plannedCommandAvailabilityFailure(command)
    if (unavailable) {
      this.rememberActivity(`[${unavailable.failureKind}]\n$ ${command}\n${unavailable.outputTail}`)
      return unavailable
    }

    this.writeCommandPreview({
      command,
      source: input.source,
      explanation: input.explanation,
      title: input.title,
      purpose: input.purpose,
      expectedOutcome: input.expectedOutcome,
      riskNote: input.riskNote,
      failureBasis: input.failureBasis,
      attempt: input.attempt,
      risk,
      requiresConfirmation: input.requiresConfirmation,
    })
    if (input.requiresConfirmation) {
      const decision = await this.requestCommandConfirmation({
        command,
        cwd: this.cwd,
        source: input.source,
        risk,
        explanation: input.explanation,
        title: input.title,
        purpose: input.purpose,
        expectedOutcome: input.expectedOutcome,
        riskNote: input.riskNote,
        failureBasis: input.failureBasis,
        attempt: input.attempt,
      })
      if (!decision.approved || input.abort.signal.aborted) return undefined
      command = decision.command ?? command
      risk = this.classifyCommandRisk(command)
      this.log(`[agent-terminal] command approved source=${input.source} risk=${risk}`)
    }

    if (this.runBuiltin(command)) return undefined

    this.rememberActivity(`$ ${command}`)
    const started = Date.now()
    let streamedOutput = ""
    try {
      const result = await this.commandRunner({
        command,
        cwd: this.cwd,
        platform: this.runtime.platform,
        shell: this.runtime.shell,
        shellKind: this.runtime.shellKind,
        signal: input.abort.signal,
        onData: (chunk) => {
          streamedOutput = appendBounded(streamedOutput, chunk, COMMAND_TRANSCRIPT_BYTES)
          this.writeText(chunk)
        },
      })
      const normalizedResult: AgentTerminalCommandResult = {
        ...result,
        output: result.output || streamedOutput,
        elapsedMs: Number.isFinite(result.elapsedMs) ? result.elapsedMs : Date.now() - started,
      }
      await this.finishCommandOutput({
        command,
        cwd: this.cwd,
        result: normalizedResult,
        source: input.source,
        originalRequest: input.originalRequest,
        title: input.title,
        purpose: input.purpose ?? input.explanation,
        expectedOutcome: input.expectedOutcome,
        risk,
        failureBasis: input.failureBasis,
        requiresConfirmation: input.requiresConfirmation,
      })
      return commandFailure(command, normalizedResult)
    } catch (error) {
      if (input.abort.signal.aborted) {
        const aborted: AgentTerminalCommandResult = {
          exitCode: null,
          signal: null,
          aborted: true,
          output: streamedOutput,
          elapsedMs: Date.now() - started,
        }
        await this.finishCommandOutput({
          command,
          cwd: this.cwd,
          result: aborted,
          source: input.source,
          originalRequest: input.originalRequest,
          title: input.title,
          purpose: input.purpose ?? input.explanation,
          expectedOutcome: input.expectedOutcome,
          risk,
          failureBasis: input.failureBasis,
          requiresConfirmation: input.requiresConfirmation,
        })
        return commandFailure(command, aborted)
      }
      const message = formatErrorMessage(error)
      this.writeLine(`[command error] ${message}`)
      const failed: AgentTerminalCommandResult = {
        exitCode: null,
        signal: null,
        aborted: false,
        output: streamedOutput ? `${streamedOutput}\n${message}` : message,
        elapsedMs: Date.now() - started,
      }
      await this.finishCommandOutput({
        command,
        cwd: this.cwd,
        result: failed,
        source: input.source,
        originalRequest: input.originalRequest,
        title: input.title,
        purpose: input.purpose ?? input.explanation,
        expectedOutcome: input.expectedOutcome,
        risk,
        failureBasis: input.failureBasis,
        requiresConfirmation: input.requiresConfirmation,
      })
      this.log(`[agent-terminal] command failed: ${message}`)
      return commandFailure(command, failed)
    }
  }

  private async finishCommandOutput(input: FinishCommandOutputInput) {
    const { command, result } = input
    if (!result.aborted) this.ensureNewLineBeforePrompt()
    if (!result.aborted && result.exitCode && result.exitCode !== 0) {
      this.writeLine(`[exit code ${result.exitCode}]`)
      if (hasUsableNonFatalOutput(command, result) && !shouldSummarizeCommandResult(input)) {
        this.writeTerminalBox({
          title: "命令已输出可用结果",
          tone: "success",
          sections: [{ body: "命令返回非零退出码，但输出中已经包含可用结果，ChipMate 未自动进入修复。" }],
        })
      }
    }
    const failure = commandFailure(command, result)
    if (failure?.nonInteractiveReason) {
      this.writeTerminalBox({
        title: "当前 runner 不支持真实 PTY 交互",
        tone: "warning",
        sections: [{ body: failure.nonInteractiveReason }],
      })
    }
    if (shouldSummarizeCommandResult(input)) {
      await this.writeCommandResultSummary(input)
    }
    this.rememberCommandResult(command, result)
    this.log(
      `[agent-terminal] command completed exitCode=${result.exitCode ?? "unknown"} signal=${result.signal ?? "none"} aborted=${result.aborted} elapsedMs=${result.elapsedMs}`,
    )
  }

  private plannedCommandAvailabilityFailure(command: string): CommandExecutionFailure | undefined {
    const token = firstCommandToken(command)
    if (!token) return undefined
    const compatibilityFailure = plannedCommandCompatibilityFailure(command, this.runtime)
    if (compatibilityFailure) return compatibilityFailure
    if (isShellBuiltinCommand(token, this.runtime.shellKind) || isCommonCommand(token)) return undefined
    const resolveCommand = this.deps.resolveCommand ?? ((candidate, root) => defaultResolveCommand(candidate, root, this.deps.env ?? process.env))
    if (resolveCommand(token, this.cwd)) return undefined
    const missingCommand = unquote(token)
    return missingCommandFailure(command, missingCommand)
  }

  private writeFailureSummary(failure: CommandExecutionFailure) {
    if (!failure.executed) {
      this.writeUnavailablePlanSummary(failure)
      return
    }
    const outputTail = truncateBytes(failure.outputTail.trim(), COMMAND_OUTPUT_ACTIVITY_BYTES)
    const criticalError = extractCriticalErrorLine(failure)
    this.writeTerminalBox({
      title: "命令执行失败",
      tone: "danger",
      sections: [
        { label: "失败命令：", body: `  $ ${failure.command}`, bodyStyle: [ANSI_BOLD, ANSI_CYAN] },
        { label: "状态：", body: `  ${failureStatusText(failure)}` },
        {
          label: "关键错误：",
          body: `  ${criticalError}`,
          bodyStyle: [failure.failureKind === "missing-command" || failure.failureKind === "non-interactive" ? ANSI_YELLOW : ANSI_RED],
        },
        ...(outputTail ? [{ label: "输出尾部：", body: outputTail }] : []),
      ],
      footer: "ChipMate 将基于上面的错误生成修复建议。",
    })
  }

  private writeUnavailablePlanSummary(failure: CommandExecutionFailure) {
    const criticalError = extractCriticalErrorLine(failure)
    this.writeTerminalBox({
      title: "计划命令不可用",
      tone: "warning",
      sections: [
        { label: "未执行的命令：", body: `  $ ${failure.command}`, bodyStyle: [ANSI_BOLD, ANSI_CYAN] },
        {
          label: "原因：",
          body: failure.compatibilityReason
            ? `  ${failure.compatibilityReason}`
            : `  当前环境找不到命令 \`${failure.missingCommand ?? firstCommandToken(failure.command)}\`。`,
        },
        { label: "关键错误：", body: `  ${criticalError}`, bodyStyle: [ANSI_YELLOW] },
      ],
      footer: "ChipMate 不会执行这条计划命令，将基于上面的错误生成修复建议。",
    })
  }

  private writeCommandPreview(input: {
    command: string
    source: "agent" | "direct" | "repair"
    risk: AgentTerminalCommandRisk
    requiresConfirmation: boolean
    explanation?: string
    title?: string
    purpose?: string
    expectedOutcome?: string
    riskNote?: string
    failureBasis?: string
    attempt: number
  }) {
    if (input.source === "direct" && !input.requiresConfirmation) return
    const title = input.title?.trim() || defaultCommandPreviewTitle(input.source, input.attempt)
    const purpose = input.purpose?.trim() || input.explanation?.trim() || defaultCommandPurpose(input.source)
    const expectedOutcome = input.expectedOutcome?.trim() || defaultExpectedOutcome(input.source)
    const riskNote = input.riskNote?.trim() || defaultRiskNote(input.risk)
    const heading = input.source === "repair"
      ? `ChipMate 准备执行修复命令：${title}`
      : input.source === "direct"
        ? `ChipMate 需要确认高风险命令：${title}`
        : `ChipMate 准备执行：${title}`
    const approvalLine = input.source === "repair"
      ? "按 y 后会执行上面这一行修复命令，并在此终端显示输出。"
      : "按 y 后会执行上面这一行命令，并在此终端显示输出。"
    this.writeTerminalBox({
      title: heading,
      tone: commandPreviewTone(input.source, input.risk),
      sections: [
        { label: "将要执行的命令：", body: `  $ ${input.command}`, bodyStyle: [ANSI_BOLD, ANSI_CYAN] },
        { label: "执行位置：", body: `  ${this.cwd}` },
        ...(input.source === "repair" && input.failureBasis ? [{ label: "修复依据：", body: `  ${input.failureBasis}` }] : []),
        { label: "为什么执行：", body: `  ${purpose}` },
        { label: "风险：", body: `  ${input.risk}${riskNote ? ` - ${riskNote}` : ""}`, bodyStyle: [riskAnsi(input.risk)] },
        { label: "预期结果：", body: `  ${expectedOutcome}` },
      ],
      footer: approvalLine,
    })
  }

  private async requestCommandConfirmation(input: AgentTerminalConfirmCommandInput): Promise<AgentTerminalCommandConfirmation> {
    let command = input.command
    let risk = input.risk
    while (true) {
      const answer = (await this.beginLineInteraction("confirm-command", confirmPrompt(command))).trim().toLowerCase()
      if (!answer || answer === "n" || answer === "no") {
        this.writeLine("[cancelled] 未执行命令。")
        this.log(`[agent-terminal] command rejected source=${input.source} risk=${risk} reason=user-declined`)
        return { approved: false, reason: "user-declined" }
      }
      if (answer === "y" || answer === "yes") {
        return { approved: true, command, reason: "approved" }
      }
      if (answer === "e" || answer === "edit") {
        const edited = (await this.beginLineInteraction("edit-command", "编辑命令 > ", command)).trim()
        if (!edited) {
          this.writeLine("[cancelled] 未执行命令。")
          this.log(`[agent-terminal] command edit cleared source=${input.source} risk=${risk}`)
          return { approved: false, reason: "empty-edited-command" }
        }
        command = edited
        risk = this.classifyCommandRisk(command)
        this.writeCommandPreview({
          command,
          source: input.source,
          risk,
          requiresConfirmation: true,
          title: "用户已编辑命令",
          purpose: "按你编辑后的内容执行这一条命令。",
          expectedOutcome: defaultExpectedOutcome(input.source),
          riskNote: defaultRiskNote(risk),
          failureBasis: input.failureBasis,
          attempt: input.attempt,
        })
        continue
      }
      this.writeTerminalBox({
        title: "请输入有效选择",
        tone: "warning",
        sections: [{ body: "请输入 y 执行、e 编辑或 n 取消。" }],
      })
    }
  }

  private async askClarification(question: string) {
    this.writeTerminalBox({
      title: "ChipMate 需要补充信息",
      tone: "info",
      sections: [{ body: question }],
    })
    const answer = (await this.beginLineInteraction("clarify", "answer > ")).trim()
    if (!answer) {
      this.writeLine("[cancelled] 未提供补充信息。")
      this.log("[agent-terminal] clarification cancelled")
      return undefined
    }
    this.rememberActivity(`[clarify] ${question}\n${answer}`)
    return answer
  }

  private beginLineInteraction(kind: LineInteractionKind, prompt: string, initialLine = ""): Promise<string> {
    this.line = ""
    this.lineCursor = 0
    this.historyIndex = undefined
    this.writeRaw(prompt)
    if (initialLine) this.writeRaw(initialLine)
    return new Promise((resolve) => {
      this.interaction = {
        kind,
        prompt,
        line: initialLine,
        cursor: codePointLength(initialLine),
        resolve: (value) => resolve(value ?? ""),
      }
    })
  }

  private runBuiltin(command: string) {
    const args = splitShellLike(command)
    const name = args[0]
    if (!name) return true
    if (name === "pwd") {
      this.writeLine(this.cwd)
      this.rememberActivity("$ pwd")
      this.rememberActivity(this.cwd)
      return true
    }
    if (name === "clear") {
      this.clearScreen(false)
      this.rememberActivity("$ clear")
      return true
    }
    if (name === "exit") {
      this.disposed = true
      this.closeEmitter.fire(0)
      return true
    }
    if (name !== "cd") return false

    const target = expandPath(args[1] ?? homeDir() ?? workspaceRoot(), this.cwd)
    this.rememberActivity(`$ ${command}`)
    try {
      if (!statSync(target).isDirectory()) {
        const message = `cd: not a directory: ${target}`
        this.writeLine(message)
        this.rememberActivity(message)
        return true
      }
      this.cwd = target
      this.rememberActivity(`cwd: ${this.cwd}`)
    } catch {
      const message = `cd: no such file or directory: ${target}`
      this.writeLine(message)
      this.rememberActivity(message)
    }
    return true
  }

  private handleCtrlC() {
    if (this.running) {
      this.writeRaw("^C\r\n")
      this.cancelInteraction()
      this.cancelRunning()
      this.running = undefined
      return
    }
    this.line = ""
    this.lineCursor = 0
    this.historyIndex = undefined
    this.writeRaw("^C\r\n")
    this.writePrompt()
  }

  private cancelRunning() {
    const running = this.running
    if (!running) return
    running.abort.abort()
    this.log(`[agent-terminal] cancelled kind=${running.kind}`)
  }

  private cancelInteraction() {
    const interaction = this.interaction
    if (!interaction) return
    this.interaction = undefined
    interaction.resolve(undefined)
    this.log(`[agent-terminal] cancelled interaction kind=${interaction.kind}`)
  }

  private handleInputEscape(key: TerminalEscapeKey) {
    if (key === "up") {
      this.recallHistory(-1)
      return
    }
    if (key === "down") {
      this.recallHistory(1)
      return
    }
    if (key === "left") {
      this.moveInputCursor(-1)
      return
    }
    if (key === "right") {
      this.moveInputCursor(1)
      return
    }
    if (key === "home") {
      this.lineCursor = 0
      this.redrawInputLine()
      return
    }
    if (key === "end") {
      this.lineCursor = codePointLength(this.line)
      this.redrawInputLine()
      return
    }
    if (key === "delete") this.deleteInputCharacter()
  }

  private handleInteractionEscape(interaction: LineInteraction, key: TerminalEscapeKey) {
    if (key === "left") {
      interaction.cursor = Math.max(0, interaction.cursor - 1)
      this.redrawInteractionLine(interaction)
      return
    }
    if (key === "right") {
      interaction.cursor = Math.min(codePointLength(interaction.line), interaction.cursor + 1)
      this.redrawInteractionLine(interaction)
      return
    }
    if (key === "home") {
      interaction.cursor = 0
      this.redrawInteractionLine(interaction)
      return
    }
    if (key === "end") {
      interaction.cursor = codePointLength(interaction.line)
      this.redrawInteractionLine(interaction)
      return
    }
    if (key === "delete") this.deleteInteractionCharacter(interaction)
  }

  private insertInputText(text: string) {
    const appendAtEnd = this.lineCursor === codePointLength(this.line)
    this.line = insertCodePointText(this.line, this.lineCursor, text)
    this.lineCursor += codePointLength(text)
    this.historyIndex = undefined
    if (appendAtEnd) this.writeRaw(text)
    else this.redrawInputLine()
  }

  private backspace() {
    if (this.lineCursor <= 0) return
    this.line = deleteCodePointBefore(this.line, this.lineCursor)
    this.lineCursor -= 1
    this.redrawInputLine()
  }

  private deleteInputCharacter() {
    if (this.lineCursor >= codePointLength(this.line)) return
    this.line = deleteCodePointAt(this.line, this.lineCursor)
    this.redrawInputLine()
  }

  private moveInputCursor(delta: -1 | 1) {
    const next = Math.max(0, Math.min(codePointLength(this.line), this.lineCursor + delta))
    if (next === this.lineCursor) return
    this.lineCursor = next
    this.redrawInputLine()
  }

  private insertInteractionText(interaction: LineInteraction, text: string) {
    const appendAtEnd = interaction.cursor === codePointLength(interaction.line)
    interaction.line = insertCodePointText(interaction.line, interaction.cursor, text)
    interaction.cursor += codePointLength(text)
    if (appendAtEnd) this.writeRaw(text)
    else this.redrawInteractionLine(interaction)
  }

  private backspaceInteraction(interaction: LineInteraction) {
    if (interaction.cursor <= 0) return
    interaction.line = deleteCodePointBefore(interaction.line, interaction.cursor)
    interaction.cursor -= 1
    this.redrawInteractionLine(interaction)
  }

  private deleteInteractionCharacter(interaction: LineInteraction) {
    if (interaction.cursor >= codePointLength(interaction.line)) return
    interaction.line = deleteCodePointAt(interaction.line, interaction.cursor)
    this.redrawInteractionLine(interaction)
  }

  private recallHistory(direction: -1 | 1) {
    if (this.history.length === 0) return
    if (direction < 0) {
      this.historyIndex = this.historyIndex === undefined
        ? this.history.length - 1
        : Math.max(0, this.historyIndex - 1)
    } else if (this.historyIndex === undefined) {
      return
    } else if (this.historyIndex >= this.history.length - 1) {
      this.historyIndex = undefined
      this.line = ""
      this.lineCursor = 0
      this.redrawInputLine()
      return
    } else {
      this.historyIndex += 1
    }
    this.line = this.historyIndex === undefined ? "" : this.history[this.historyIndex] ?? ""
    this.lineCursor = codePointLength(this.line)
    this.redrawInputLine()
  }

  private redrawInputLine() {
    this.writeRaw(redrawEditableLine(this.promptText(), this.line, this.lineCursor))
    this.atLineStart = false
  }

  private clearScreen(showPrompt = true) {
    this.line = ""
    this.lineCursor = 0
    this.historyIndex = undefined
    this.writeRaw("\x1b[2J\x1b[H")
    this.atLineStart = true
    if (showPrompt) this.writePrompt()
  }

  private clearInteractionLine(interaction: LineInteraction) {
    interaction.line = ""
    interaction.cursor = 0
    this.redrawInteractionLine(interaction)
  }

  private redrawInteractionLine(interaction: LineInteraction) {
    this.writeRaw(redrawEditableLine(interaction.prompt, interaction.line, interaction.cursor))
  }

  private writePrompt() {
    if (this.disposed) return
    this.ensureNewLineBeforePrompt()
    this.writeRaw(this.promptText())
    this.atLineStart = false
  }

  private promptText() {
    return `\x1b[36mchipmate\x1b[0m ${formatCwd(this.cwd)} > `
  }

  private writeAgentStatus(message: string) {
    this.writeRaw(`${styled(`[agent] ${message}`, ANSI_DIM)}\r\n`)
  }

  private writeTerminalBox(input: TerminalBoxInput) {
    this.ensureNewLineBeforePrompt()
    this.writeText(`${renderTerminalBox({
      ...input,
      columns: this.terminalColumns,
      width: input.width ?? terminalBoxWidth(this.terminalColumns),
    })}\n`)
  }

  private writeAgentAnswer(message: string, title: string, projectContext?: TerminalProjectContext) {
    const evidence = projectContext ? projectEvidenceLines(projectContext) : []
    this.writeTerminalBox({
      title,
      tone: "info",
      sections: [
        { body: message },
        ...(evidence.length ? [{ label: "依据：", body: evidence }] : []),
      ],
    })
  }

  private writeProjectInspectionSummary(context: TerminalProjectContext) {
    this.writeTerminalBox({
      title: "项目侦察",
      tone: context.errors.length ? "warning" : "info",
      sections: [{ body: terminalProjectContextSummaryLines(context).map((line) => line.trim()) }],
    })
  }

  private writeRepairPlanningFailure(truncated: boolean) {
    this.writeTerminalBox({
      title: "修复规划失败",
      tone: "warning",
      sections: [
        {
          label: "原因：",
          body: truncated
            ? "planner 输出被 token 上限截断，未返回可执行 JSON。"
            : "模型没有输出可执行修复建议。",
        },
        { label: "下一步：", body: "ChipMate 不会自动执行任何新命令。你可以手动输入替代命令，或换一种说法重试。" },
      ],
    })
  }

  private async writeCommandResultSummary(input: FinishCommandOutputInput) {
    const local = buildLocalCommandResultSummary(input)
    let summary: TerminalCommandResultSummary = local
    const client = this.deps.getClient()
    if (local.confidence === "generic" && client?.summarizeTerminalCommandResult) {
      try {
        summary = await client.summarizeTerminalCommandResult(commandResultSummaryInput(input, local))
      } catch (error) {
        this.log(`[terminal-summary] model summary failed, using local fallback: ${formatErrorMessage(error)}`)
      }
    }
    const resultLines = uniqueNonEmptyLines([summary.headline, ...summary.resultLines])
    this.writeTerminalBox({
      title: commandResultSummaryTitle(summary),
      tone: commandResultSummaryTone(summary),
      sections: [
        { label: "执行命令：", body: `  $ ${input.command}`, bodyStyle: [ANSI_BOLD, ANSI_CYAN] },
        { label: "结果：", body: resultLines },
        ...(summary.warnings.length ? [{ label: "警告：", body: summary.warnings, bodyStyle: [ANSI_YELLOW] }] : []),
        { label: "下一步：", body: summary.nextStep },
      ],
    })
  }

  private ensureNewLineBeforePrompt() {
    if (!this.atLineStart) this.writeRaw("\r\n")
  }

  private writeLine(text: string) {
    this.writeText(`${text}\n`)
  }

  private writeText(text: string) {
    if (!text) return
    this.writeRaw(toTerminalNewlines(text))
  }

  private writeRaw(text: string) {
    this.writeEmitter.fire(text)
    this.atLineStart = endsAtLineStart(text, this.atLineStart)
  }

  private rememberCommandResult(command: string, result: AgentTerminalCommandResult) {
    const status = result.aborted
      ? "aborted"
      : result.signal
        ? `signal ${result.signal}`
        : `exit ${result.exitCode ?? "unknown"}`
    const outputTail = truncateBytes(result.output.trim(), COMMAND_OUTPUT_ACTIVITY_BYTES)
    this.rememberActivity([
      `$ ${command}`,
      `[${status}; ${result.elapsedMs}ms]`,
      outputTail ? `output tail:\n${outputTail}` : "",
    ].filter(Boolean).join("\n"))
  }

  private rememberActivity(text: string) {
    this.terminalActivity.push(text)
    while (this.terminalActivity.length > MAX_ACTIVITY_ITEMS || this.terminalActivity.join("\n").length > MAX_ACTIVITY_CHARS) {
      this.terminalActivity.shift()
    }
  }

  private activitySnapshot() {
    return [...this.terminalActivity]
  }

  private log(message: string) {
    this.deps.output?.appendLine(message)
  }
}

export function classifyAgentTerminalInput(input: string, options: AgentTerminalClassifierOptions = {}): AgentTerminalRoute {
  const trimmed = input.trim()
  if (!trimmed) return { kind: "empty", reason: "empty-input" }

  const forcedAgent = /^(?:\?|ai)\s+(.+)$/i.exec(trimmed)
  if (forcedAgent?.[1]?.trim()) return { kind: "agent", text: forcedAgent[1].trim(), reason: "forced-agent-prefix" }

  const forcedCommand = /^\$\s*(.*)$/.exec(trimmed)
  if (forcedCommand) {
    const command = forcedCommand[1]?.trim() ?? ""
    return command ? { kind: "command", command, reason: "forced-command-prefix" } : { kind: "empty", reason: "empty-command-prefix" }
  }

  const token = firstCommandToken(trimmed)
  const cwd = options.cwd ?? process.cwd()
  const resolveCommand = options.resolveCommand ?? ((candidate, root) => defaultResolveCommand(candidate, root, options.env ?? process.env))
  if (hasExplicitShellSyntax(trimmed)) return { kind: "command", command: trimmed, reason: "shell-syntax" }
  if (token && isCommonCommand(token)) return { kind: "command", command: trimmed, reason: "known-command" }
  if (token && resolveCommand(token, cwd)) return { kind: "command", command: trimmed, reason: "resolvable-command" }
  if (token && looksLikeCommandToken(token) && hasCommandLikeArguments(trimmed)) return { kind: "command", command: trimmed, reason: "command-like-arguments" }
  return { kind: "agent", text: trimmed, reason: "natural-language-fallback" }
}

export function runAgentTerminalCommand(input: AgentTerminalCommandInput): Promise<AgentTerminalCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now()
    const runtime = resolveAgentTerminalRuntime(input)
    const { shell, args } = commandInvocation(input.command, runtime)
    const child = spawn(shell, args, { cwd: input.cwd, shell: false })
    let output = ""
    let settled = false
    const cleanup = () => input.signal?.removeEventListener("abort", onAbort)
    const finish = (result: Omit<AgentTerminalCommandResult, "output" | "elapsedMs">) => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise({
        ...result,
        output,
        elapsedMs: Date.now() - started,
      })
    }
    const onAbort = () => {
      child.kill()
    }
    const onData = (chunk: unknown) => {
      const text = decodeAgentTerminalOutputChunk(chunk, runtime.platform)
      output = appendBounded(output, text, COMMAND_TRANSCRIPT_BYTES)
      input.onData(text)
    }

    if (input.signal?.aborted) {
      child.kill()
    } else {
      input.signal?.addEventListener("abort", onAbort, { once: true })
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.on("error", (error) => {
      if (input.signal?.aborted) {
        finish({ exitCode: null, signal: null, aborted: true })
        return
      }
      cleanup()
      reject(error)
    })
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal, aborted: Boolean(input.signal?.aborted) })
    })
  })
}

export function decodeAgentTerminalOutputChunk(chunk: unknown, platform: NodeJS.Platform = process.platform) {
  if (typeof chunk === "string") return chunk
  if (!isUint8ArrayLike(chunk)) return String(chunk)
  const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk as ArrayLike<number>)
  const utf8 = decodeBytes(bytes, "utf-8")
  if (platform !== "win32" || replacementCharacterCount(utf8) === 0) return utf8
  const fallback = ["gb18030", "gbk"]
    .map((encoding) => decodeBytes(bytes, encoding))
    .sort((left, right) => replacementCharacterCount(left) - replacementCharacterCount(right))[0]
  return fallback && replacementCharacterCount(fallback) < replacementCharacterCount(utf8) ? fallback : utf8
}

function resolveAgentTerminalRuntime(input: { platform?: NodeJS.Platform; shell?: string; shellKind?: AgentTerminalShellKind; env?: NodeJS.ProcessEnv }): AgentTerminalRuntime {
  const platform = input.platform ?? process.platform
  const shell = input.shell || defaultShellForPlatform(platform, input.env ?? process.env)
  return {
    platform,
    shell,
    shellKind: input.shellKind ?? inferShellKind(shell, platform),
  }
}

function defaultShellForPlatform(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  if (platform === "win32") return "powershell.exe"
  return env.SHELL || "/bin/sh"
}

function inferShellKind(shell: string, platform: NodeJS.Platform): AgentTerminalShellKind {
  const name = basename(shell).toLowerCase()
  if (/^(?:pwsh|pwsh\.exe|powershell|powershell\.exe)$/.test(name)) return "powershell"
  if (/^(?:cmd|cmd\.exe)$/.test(name)) return "cmd"
  if (/^(?:bash|bash\.exe|zsh|zsh\.exe|sh|sh\.exe|fish|fish\.exe)$/.test(name)) return "posix"
  return platform === "win32" ? "unknown" : "posix"
}

function commandInvocation(command: string, runtime: AgentTerminalRuntime) {
  if (runtime.shellKind === "powershell") {
    return { shell: runtime.shell, args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command] }
  }
  if (runtime.shellKind === "cmd") {
    return { shell: runtime.shell, args: ["/d", "/s", "/c", command] }
  }
  return { shell: runtime.shell, args: ["-lc", command] }
}

function plannedCommandCompatibilityFailure(command: string, runtime: AgentTerminalRuntime) {
  if (runtime.platform !== "win32") return undefined
  const value = command.trim()
  const shellLabel = runtime.shellKind === "powershell" ? "PowerShell" : runtime.shellKind === "cmd" ? "cmd" : "当前 Windows shell"
  if ((runtime.shellKind === "powershell" || runtime.shellKind === "cmd") && /^find\s+\.\s+.*(?:\s-type\s|\s-name\s)/i.test(value)) {
    return incompatibleCommandFailure(command, `${shellLabel} 中的 find 不是 POSIX/GNU find；请改用 PowerShell 的 Get-ChildItem、显式 Git Bash，或适合 cmd 的 dir 命令。`)
  }
  if (runtime.shellKind === "powershell" && /^dir\s+\/s\s+\/b\b/i.test(value)) {
    return incompatibleCommandFailure(command, "PowerShell 的 dir 是 Get-ChildItem 别名，不支持 cmd 的 /s /b 参数；请改用 Get-ChildItem，或显式使用 cmd /c dir /s /b。")
  }
  if (runtime.shellKind === "cmd" && /^Get-ChildItem\b/i.test(value)) {
    return incompatibleCommandFailure(command, "cmd 不支持 PowerShell 的 Get-ChildItem；请显式使用 powershell.exe，或改用 cmd /c dir。")
  }
  return undefined
}

function isShellBuiltinCommand(token: string, shellKind: AgentTerminalShellKind) {
  const command = unquote(token).toLowerCase()
  if (!command) return false
  if (command === "cmd" || command === "cmd.exe" || command === "powershell" || command === "powershell.exe" || command === "pwsh" || command === "pwsh.exe") return true
  if (shellKind === "powershell") return POWERSHELL_COMMANDS.has(command)
  if (shellKind === "cmd") return CMD_COMMANDS.has(command)
  return false
}

const POWERSHELL_COMMANDS = new Set([
  "cat",
  "cd",
  "clear",
  "copy",
  "del",
  "dir",
  "echo",
  "foreach-object",
  "gci",
  "get-childitem",
  "ls",
  "mkdir",
  "move",
  "pwd",
  "remove-item",
  "where",
  "where-object",
])

const CMD_COMMANDS = new Set([
  "cd",
  "copy",
  "del",
  "dir",
  "echo",
  "erase",
  "for",
  "if",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rmdir",
  "set",
  "type",
  "where",
])

function isUint8ArrayLike(input: unknown): input is ArrayLike<number> {
  return input instanceof Uint8Array || Boolean(input && typeof input === "object" && typeof (input as { length?: unknown }).length === "number")
}

function decodeBytes(bytes: Uint8Array, encoding: string) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes)
  } catch {
    return Buffer.from(bytes).toString("utf8")
  }
}

function replacementCharacterCount(input: string) {
  return input.split("\uFFFD").length - 1
}

function commandFailure(command: string, result: AgentTerminalCommandResult): CommandExecutionFailure | undefined {
  if (!isFailedCommand(result)) return undefined
  if (hasUsableNonFatalOutput(command, result)) return undefined
  const outputTail = textTailByBytes(result.output, COMMAND_OUTPUT_TAIL_BYTES)
  const missingCommand = detectMissingCommand(result.output)
  const nonInteractiveReason = detectNonInteractiveLimitation(result.output)
  const failureKind: AgentTerminalFailureKind = missingCommand
    ? "missing-command"
    : nonInteractiveReason
      ? "non-interactive"
      : result.signal
        ? "signal"
        : result.exitCode === null
          ? "spawn"
          : "exit-code"
  const reason = missingCommand
    ? `missing command: ${missingCommand}`
    : nonInteractiveReason
    ? "non-interactive terminal limitation"
    : result.signal
      ? `terminated by signal ${result.signal}`
      : result.exitCode === null
        ? "command failed before an exit code was reported"
        : `command exited with code ${result.exitCode}`
  return { command, result, reason, outputTail, failureKind, executed: true, missingCommand, nonInteractiveReason }
}

function incompatibleCommandFailure(command: string, compatibilityReason: string): CommandExecutionFailure {
  const output = compatibilityReason
  return {
    command,
    result: {
      exitCode: 2,
      signal: null,
      aborted: false,
      output,
      elapsedMs: 0,
    },
    reason: compatibilityReason,
    outputTail: output,
    failureKind: "incompatible-command",
    executed: false,
    compatibilityReason,
  }
}

function missingCommandFailure(command: string, missingCommand: string): CommandExecutionFailure {
  const output = `command not found: ${missingCommand}`
  return {
    command,
    result: {
      exitCode: 127,
      signal: null,
      aborted: false,
      output,
      elapsedMs: 0,
    },
    reason: `missing command: ${missingCommand}`,
    outputTail: output,
    failureKind: "missing-command",
    executed: false,
    missingCommand,
  }
}

function isFailedCommand(result: AgentTerminalCommandResult) {
  return !result.aborted && (result.signal !== null || result.exitCode === null || result.exitCode !== 0)
}

function hasUsableNonFatalOutput(_command: string, result: AgentTerminalCommandResult) {
  if (result.aborted || result.signal || result.exitCode === null || result.exitCode === 0) return false
  if (!result.output.trim()) return false
  if (fileSearchNoMatchSummary(_command, result.output)) return true
  if (findCriticalErrorLine(result.output)) return false
  return hasUsableResultSummary(result.output)
}

function defaultCommandPreviewTitle(source: AgentTerminalConfirmCommandInput["source"], attempt: number) {
  if (source === "direct") return "用户输入的高风险命令"
  if (source === "repair") return `修复尝试 ${attempt}`
  return "建议命令"
}

function defaultCommandPurpose(source: AgentTerminalConfirmCommandInput["source"]) {
  if (source === "direct") return "这是你直接输入的高风险命令，执行前需要确认。"
  if (source === "repair") return "尝试修复上一条命令的失败。"
  return "执行 ChipMate 根据你的请求生成的命令。"
}

function defaultExpectedOutcome(source: AgentTerminalConfirmCommandInput["source"]) {
  if (source === "repair") return "ChipMate 会在此终端执行这条修复命令，并把输出显示在这里。"
  return "ChipMate 会在此终端执行这条命令，并把输出显示在这里。"
}

function defaultRiskNote(risk: AgentTerminalCommandRisk) {
  if (risk === "low") return "看起来是低风险命令。"
  if (risk === "medium") return "执行前请确认命令符合预期。"
  return "高风险命令，确认前请仔细检查。"
}

function failureStatusText(failure: CommandExecutionFailure) {
  const status = failure.result.signal
    ? `signal ${failure.result.signal}`
    : failure.result.exitCode === null
      ? "no exit code"
      : `exit code ${failure.result.exitCode}`
  const kind = failure.failureKind
  const detail = failureKindDetail(failure)
  return `${status} / ${kind}${detail ? `（${detail}）` : ""}`
}

function failureKindDetail(failure: CommandExecutionFailure) {
  if (failure.failureKind === "incompatible-command") return "命令与当前 shell 不兼容"
  if (failure.failureKind === "missing-command" && failure.missingCommand) return `找不到命令 \`${failure.missingCommand}\``
  if (failure.failureKind === "non-interactive") return "当前 runner 不支持真实 PTY 交互"
  if (failure.failureKind === "signal" && failure.result.signal) return `进程被信号 ${failure.result.signal} 终止`
  if (failure.failureKind === "spawn") return "命令启动失败或未返回退出码"
  if (failure.failureKind === "exit-code") return "命令返回非零退出码"
  return ""
}

function repairBasisText(failure: CommandExecutionFailure) {
  const command = `\`${failure.command}\``
  if (failure.failureKind === "incompatible-command" && failure.compatibilityReason) return `计划命令 ${command} 未执行：${failure.compatibilityReason}`
  if (!failure.executed && failure.missingCommand) return `计划命令 ${command} 未执行：当前环境找不到命令 \`${failure.missingCommand}\`。`
  if (failure.failureKind === "missing-command" && failure.missingCommand) return `上一条命令 ${command} 失败：找不到命令 \`${failure.missingCommand}\`。`
  if (failure.failureKind === "non-interactive") return `上一条命令 ${command} 失败：当前 runner 不支持真实 PTY 交互。`
  return `上一条命令 ${command} 失败：${extractCriticalErrorLine(failure)}`
}

function extractCriticalErrorLine(failure: CommandExecutionFailure) {
  if (failure.nonInteractiveReason) return failure.nonInteractiveReason
  if (failure.compatibilityReason) return failure.compatibilityReason
  if (failure.missingCommand) return `command not found: ${failure.missingCommand}`
  const line = findCriticalErrorLine(failure.outputTail)
  if (line) return line
  const lines = nonEmptyOutputLines(failure.outputTail)
  return lines.at(-1) ?? failure.reason
}

function findCriticalErrorLine(output: string) {
  const lines = nonEmptyOutputLines(output)
  const patterns = [
    /command not found/i,
    /not recognized as an internal or external command/i,
    /\bnot found\b/i,
    /no such file/i,
    /permission denied/i,
    /sudo:|password|tty|terminal is required/i,
    /\berror:/i,
    /\bfatal:/i,
  ]
  for (const pattern of patterns) {
    const line = lines.find((candidate) => pattern.test(candidate))
    if (line) return line
  }
  return undefined
}

function hasUsableResultSummary(output: string) {
  return nonEmptyOutputLines(output).some((line) =>
    /^\s*\d+(?:\s+\d+)*\s+total\s*$/i.test(line)
    || /^\s*total\s*[:=]\s*\d+(?:\b|$)/i.test(line)
  )
}

function fileSearchNoMatchSummary(command: string, output: string) {
  if (!looksLikeFileSearchCommand(command)) return undefined
  const noMatch = nonEmptyOutputLines(output).some((line) =>
    /(?:file not found|could not find files|cannot find the path specified)/i.test(line)
    || /找不到文件|未找到文件|找不到.*文件/.test(line)
  )
  return noMatch ? "未找到匹配文件。" : undefined
}

function looksLikeFileSearchCommand(command: string) {
  const value = command.trim()
  return /\bGet-ChildItem\b/i.test(value)
    || /\bcmd(?:\.exe)?\s+\/[cd]\s+dir\b/i.test(value)
    || /^dir\s+\/s\s+\/b\b/i.test(value)
    || /^find\s+\.\s+.*\b-name\b/i.test(value)
}

function nonEmptyOutputLines(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function confirmPrompt(command: string) {
  return `确认执行 \`${truncateCommandForPrompt(command)}\` ? [y]执行 / [e]编辑 / [n]取消 > `
}

function truncateCommandForPrompt(command: string) {
  const value = command.trim()
  if (value.length <= MAX_CONFIRM_PROMPT_COMMAND_CHARS) return value
  const headLength = MAX_CONFIRM_PROMPT_COMMAND_CHARS - 24
  return `${value.slice(0, headLength)}...${value.slice(-20)}`
}

function riskAnsi(risk: AgentTerminalCommandRisk) {
  if (risk === "high") return ANSI_BOLD + ANSI_RED
  if (risk === "medium") return ANSI_YELLOW
  return ANSI_GREEN
}

function commandPreviewTone(source: AgentTerminalConfirmCommandInput["source"], risk: AgentTerminalCommandRisk): TerminalBoxTone {
  if (risk === "high") return "danger"
  if (source === "repair") return "warning"
  return "info"
}

function shouldSummarizeCommandResult(input: FinishCommandOutputInput) {
  if (input.result.aborted) return false
  return input.source === "agent" || input.source === "repair" || (input.source === "direct" && input.requiresConfirmation)
}

function buildLocalCommandResultSummary(input: FinishCommandOutputInput): LocalCommandResultSummary {
  const status = commandResultSummaryStatus(input.command, input.result)
  const output = input.result.output
  const total = extractTotalSummary(output)
  const cloc = extractClocSummary(output)
  const tests = extractTestSummary(output)
  const apt = extractAptSummary(output)
  const noMatch = fileSearchNoMatchSummary(input.command, output)
  const critical = findCriticalErrorLine(output)
  const warnings = commandResultWarnings(input, output)
  const resultLines: string[] = []
  let headline = ""
  let confidence: LocalCommandResultSummary["confidence"] = "generic"

  if (total) {
    headline = `统计得到 ${total.line}`
    resultLines.push(`统计得到 ${total.line}。`)
    confidence = "specific"
  } else if (cloc) {
    headline = cloc
    resultLines.push(cloc)
    confidence = "specific"
  } else if (tests) {
    headline = tests
    resultLines.push(tests)
    confidence = "specific"
  } else if (apt) {
    headline = apt
    resultLines.push(apt)
    confidence = "specific"
  } else if (noMatch) {
    headline = noMatch
    resultLines.push(noMatch)
    confidence = "specific"
  } else if (status === "failed" && critical) {
    headline = "命令执行失败。"
    resultLines.push(`关键错误：${critical}`)
    confidence = "specific"
  } else {
    headline = defaultCommandResultHeadline(status)
    resultLines.push(defaultCommandResultLine(input, status))
  }

  return {
    status,
    headline,
    resultLines,
    warnings,
    nextStep: commandResultNextStep(input, status, Boolean(total || cloc || tests || apt), warnings),
    confidence,
  }
}

function commandResultSummaryInput(input: FinishCommandOutputInput, local: LocalCommandResultSummary): TerminalCommandResultSummaryInput {
  return {
    cwd: input.cwd,
    command: input.command,
    source: input.source,
    originalRequest: input.originalRequest,
    title: input.title,
    purpose: input.purpose,
    expectedOutcome: input.expectedOutcome,
    risk: input.risk,
    failureBasis: input.failureBasis,
    exitCode: input.result.exitCode,
    signalName: input.result.signal,
    elapsedMs: input.result.elapsedMs,
    outputTail: textTailByBytes(input.result.output, COMMAND_OUTPUT_TAIL_BYTES),
    hasUsableResult: hasUsableNonFatalOutput(input.command, input.result),
    warnings: local.warnings,
  }
}

function commandResultSummaryStatus(command: string, result: AgentTerminalCommandResult): TerminalCommandResultSummary["status"] {
  if (result.aborted) return "aborted"
  if (result.signal || result.exitCode === null) return "failed"
  if (result.exitCode === 0) return "success"
  if (hasUsableNonFatalOutput(command, result)) return "warning"
  return "failed"
}

function commandResultWarnings(input: FinishCommandOutputInput, output: string) {
  const warnings: string[] = []
  const directoryWarnings = nonEmptyOutputLines(output).filter((line) => /^wc: .+: read: Is a directory$/i.test(line))
  if (directoryWarnings.length) {
    warnings.push(`wc 尝试读取 ${directoryWarnings.length} 个目录并报 read: Is a directory；这些目录没有按文件内容计入统计。`)
  }
  const permissionWarnings = nonEmptyOutputLines(output).filter((line) => /permission denied/i.test(line))
  if (permissionWarnings.length) warnings.push(`输出中包含 ${permissionWarnings.length} 条 Permission denied 警告。`)
  if (input.result.exitCode && input.result.exitCode !== 0) {
    warnings.push(`命令退出码是 ${input.result.exitCode}。`)
  }
  if (Buffer.byteLength(output, "utf8") >= COMMAND_TRANSCRIPT_BYTES) {
    warnings.push("命令输出较长，ChipMate 只保留了尾部用于总结。")
  }
  return uniqueNonEmptyLines(warnings)
}

function extractTotalSummary(output: string) {
  const line = [...nonEmptyOutputLines(output)].reverse().find((candidate) => /^\d+(?:\s+\d+)*\s+total$/i.test(candidate))
  if (!line) return undefined
  const count = /^(\d+)/.exec(line)?.[1]
  return count ? { count, line } : undefined
}

function extractClocSummary(output: string) {
  const line = [...nonEmptyOutputLines(output)].reverse().find((candidate) => /^SUM:\s+/i.test(candidate))
  return line ? `cloc 汇总行：${line}` : undefined
}

function extractTestSummary(output: string) {
  const line = [...nonEmptyOutputLines(output)].reverse().find((candidate) =>
    /\b\d+\s+passed\b/i.test(candidate) ||
    /\b\d+\s+failed\b/i.test(candidate) ||
    /tests? passed/i.test(candidate) ||
    /tests? failed/i.test(candidate)
  )
  return line ? `测试结果：${line}` : undefined
}

function extractAptSummary(output: string) {
  const lines = nonEmptyOutputLines(output)
  if (lines.some((line) => /setting up|newly installed|upgraded|already the newest version/i.test(line))) {
    return "软件包命令已完成，终端输出中包含安装或更新结果。"
  }
  return undefined
}

function defaultCommandResultHeadline(status: TerminalCommandResultSummary["status"]) {
  if (status === "success") return "命令执行完成。"
  if (status === "warning") return "命令输出了可用结果，但伴随警告。"
  if (status === "aborted") return "命令已中断。"
  return "命令执行失败。"
}

function defaultCommandResultLine(input: FinishCommandOutputInput, status: TerminalCommandResultSummary["status"]) {
  if (status === "success") return "命令已执行完成。"
  if (status === "warning") return "命令虽然返回非零退出码，但输出中包含可用结果。"
  if (status === "aborted") return "命令被中断，未继续执行。"
  const critical = findCriticalErrorLine(input.result.output)
  return critical ? `关键错误：${critical}` : "命令没有产生可自动提炼的成功结果。"
}

function commandResultNextStep(
  input: FinishCommandOutputInput,
  status: TerminalCommandResultSummary["status"],
  hasSpecificResult: boolean,
  warnings: string[],
) {
  if (status === "failed") return "ChipMate 会根据失败信息继续生成修复建议。"
  if (status === "warning") {
    if (hasSpecificResult) return "虽然有警告，但输出中已经有可用结果，所以 ChipMate 不会继续修复。"
    return "请查看警告；如果结果符合预期，可以继续下一步。"
  }
  if (status === "aborted") return "命令已中断，没有继续执行。"
  if (input.source === "repair") return "这是修复命令的结果。如果结果符合预期，可以继续下一步。"
  if (warnings.length) return "请确认警告不影响你的目标；如果结果符合预期，可以继续下一步。"
  return "如果结果符合预期，可以继续下一步。"
}

function commandResultSummaryTitle(summary: TerminalCommandResultSummary) {
  if (summary.status === "success") return "执行结果总结"
  if (summary.status === "warning") return "执行完成但有警告"
  if (summary.status === "aborted") return "执行已中断"
  return "执行失败"
}

function commandResultSummaryTone(summary: TerminalCommandResultSummary): TerminalBoxTone {
  if (summary.status === "success") return "success"
  if (summary.status === "warning") return "warning"
  if (summary.status === "aborted") return "muted"
  return "danger"
}

function projectEvidenceLines(context: TerminalProjectContext) {
  const lines = terminalProjectContextSummaryLines(context).map((line) => line.trim())
  if (context.root) lines.unshift(`root: ${context.root}`)
  return lines
}

function uniqueNonEmptyLines(lines: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
    if (seen.has(line)) continue
    seen.add(line)
    result.push(line)
  }
  return result
}

function normalizePlannedCommand(command: string) {
  const value = command.trim()
  if (value === "cloc") return "cloc ."
  return value
}

function detectNonInteractiveLimitation(output: string) {
  if (!output) return undefined
  if (/sudo:.*(?:terminal is required|password is required|no tty present)/i.test(output) || /\[sudo\]\s+password/i.test(output)) {
    return "当前 runner 不支持真实 PTY 密码输入。请在普通 VS Code Terminal 中输入 sudo 密码，或配置免交互/免密码方式后再重试。"
  }
  if (/\b(?:Do you want to continue\?|Proceed\?\s*\[[Yy]\/[Nn]\]|Press any key to continue|read .*password)\b/i.test(output)) {
    return "当前 runner 不支持真实 PTY 交互提示。请在安全时使用非交互参数，或在普通 VS Code Terminal 中运行这一步。"
  }
  return undefined
}

function detectMissingCommand(output: string) {
  if (!output) return undefined
  const patterns = [
    /(?:^|\n)[^:\n]+:\d+:\s*command not found:\s*([^\s\r\n]+)/i,
    /(?:^|\n)(?:bash|zsh|sh|fish|[^:\n/]+sh):\s*(?:line\s+\d+:\s*)?([^:\s\r\n]+):\s*command not found/i,
    /(?:^|\n)(?:sh|[^:\n/]+sh):\s*\d+:\s*([^:\s\r\n]+):\s*not found/i,
    /(?:^|\n)([^:\s\r\n]+):\s*command not found/i,
    /(?:^|\n)'?([^'\r\n]+)'?\s+is not recognized as an internal or external command/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(output)
    const command = match?.[1]?.trim().replace(/^["'`]+|["'`]+$/g, "")
    if (command) return command
  }
  return undefined
}

function firstCommandToken(input: string) {
  const tokens = splitShellLike(input)
  let index = 0
  while (tokens[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1
  return tokens[index] ?? ""
}

function hasExplicitShellSyntax(input: string) {
  return /(?:^|\s)(?:&&|\|\||[|;])(?:\s|$)/.test(input)
    || /\s(?:>>?|<)\s*\S/.test(input)
    || /[`$]\(/.test(input)
    || /^[A-Za-z_][A-Za-z0-9_]*=/.test(input)
}

function looksLikeCommandToken(token: string) {
  const command = unquote(token)
  return /^[A-Za-z0-9_.+-]+$/.test(command)
    || /^(?:\.{1,2}[\\/]|[\\/]|~[\\/])/.test(command)
}

function hasCommandLikeArguments(input: string) {
  const tokens = splitShellLike(input)
  if (tokens.length < 2) return false
  return tokens.slice(1).some((token) =>
    token === "."
    || token === ".."
    || /^(?:--?|\.{1,2}\/|\/|~\/)/.test(token)
    || token.includes("/")
    || /\.[A-Za-z0-9_+-]+$/.test(token)
  )
}

function isCommonCommand(token: string) {
  return COMMON_COMMANDS.has(unquote(token))
}

const COMMON_COMMANDS = new Set([
  "awk",
  "bun",
  "cargo",
  "cat",
  "cd",
  "chmod",
  "chown",
  "clear",
  "cmake",
  "code",
  "cp",
  "curl",
  "date",
  "docker",
  "echo",
  "env",
  "exit",
  "export",
  "find",
  "git",
  "go",
  "grep",
  "history",
  "kill",
  "kubectl",
  "ls",
  "make",
  "mkdir",
  "mv",
  "ninja",
  "node",
  "npm",
  "pnpm",
  "pwd",
  "python",
  "python3",
  "rg",
  "rm",
  "sed",
  "source",
  "ssh",
  "sudo",
  "tar",
  "touch",
  "unzip",
  "wget",
  "which",
  "whoami",
  "yarn",
])

function defaultResolveCommand(token: string, cwd: string, env: NodeJS.ProcessEnv) {
  const command = unquote(token)
  if (!command) return false
  if (command.includes("/") || command.includes("\\") || command.startsWith(".") || command.startsWith("~")) {
    return isExecutableFile(expandPath(command, cwd))
  }
  const paths = (env.PATH ?? "").split(delimiter).filter(Boolean)
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""]
  for (const dir of paths) {
    for (const extension of extensions) {
      if (isExecutableFile(join(dir, command + extension.toLowerCase())) || isExecutableFile(join(dir, command + extension.toUpperCase()))) {
        return true
      }
    }
  }
  return false
}

function isExecutableFile(path: string) {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform === "win32") return true
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function splitShellLike(input: string) {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let escaped = false
  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

function expandPath(input: string, cwd: string) {
  const value = unquote(input)
  if (value === "~") return homeDir() ?? value
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homeDir() ?? "~", value.slice(2))
  return isAbsolute(value) ? value : resolve(cwd, value)
}

function unquote(input: string) {
  const trimmed = input.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function createSimpleEventEmitter<T>(): EventEmitterLike<T> {
  const listeners = new Set<(value: T) => void>()
  return {
    event: (listener) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    fire: (value) => {
      for (const listener of listeners) listener(value)
    },
    dispose: () => listeners.clear(),
  }
}

function workspaceRoot() {
  return process.cwd()
}

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE
}

function formatCwd(cwd: string) {
  const home = homeDir()
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) return `~${cwd.slice(home.length)}`
  return cwd
}

function toTerminalNewlines(input: string) {
  return input.replace(/\r?\n/g, "\r\n")
}

function endsAtLineStart(text: string, fallback: boolean) {
  if (!text) return fallback
  return text.endsWith("\n") || text.endsWith("\r")
}

function appendBounded(existing: string, chunk: string, maxBytes: number) {
  const next = `${existing}${chunk}`
  const buffer = Buffer.from(next, "utf8")
  if (buffer.byteLength <= maxBytes) return next
  return buffer.subarray(buffer.byteLength - maxBytes).toString("utf8")
}

function truncateBytes(input: string, maxBytes: number) {
  const buffer = Buffer.from(input, "utf8")
  if (buffer.byteLength <= maxBytes) return input
  return `${buffer.subarray(0, maxBytes).toString("utf8")}...`
}

function textTailByBytes(input: string, maxBytes: number) {
  const buffer = Buffer.from(input, "utf8")
  if (buffer.byteLength <= maxBytes) return input
  return buffer.subarray(buffer.byteLength - maxBytes).toString("utf8")
}

type TerminalEscapeKey = "delete" | "down" | "end" | "home" | "left" | "right" | "unknown" | "up"
type ParsedTerminalEscapeSequence =
  | { complete: true; key: TerminalEscapeKey; length: number }
  | { complete: false }

function parseTerminalEscapeSequence(chars: string[], index: number): ParsedTerminalEscapeSequence {
  const next = chars[index + 1]
  if (!next) return { complete: false }
  if (next === "O") {
    const final = chars[index + 2]
    if (!final) return { complete: false }
    return { complete: true, key: terminalEscapeKey("", final), length: 3 }
  }
  if (next !== "[") return { complete: true, key: "unknown", length: 1 }
  for (let cursor = index + 2; cursor < chars.length; cursor += 1) {
    const char = chars[cursor] ?? ""
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x40 && code <= 0x7e) {
      const params = chars.slice(index + 2, cursor).join("")
      return { complete: true, key: terminalEscapeKey(params, char), length: cursor - index + 1 }
    }
  }
  return { complete: false }
}

function terminalEscapeKey(params: string, final: string): TerminalEscapeKey {
  if (final === "A") return "up"
  if (final === "B") return "down"
  if (final === "C") return "right"
  if (final === "D") return "left"
  if (final === "H") return "home"
  if (final === "F") return "end"
  if (final === "~") {
    const first = params.split(";")[0]
    if (first === "1" || first === "7") return "home"
    if (first === "4" || first === "8") return "end"
    if (first === "3") return "delete"
  }
  return "unknown"
}

function redrawEditableLine(prompt: string, line: string, cursor: number) {
  const safeCursor = Math.max(0, Math.min(codePointLength(line), cursor))
  const tailWidth = visibleWidth(codePointSlice(line, safeCursor))
  return `\r\x1b[2K${prompt}${line}${tailWidth > 0 ? `\x1b[${tailWidth}D` : ""}`
}

function insertCodePointText(input: string, cursor: number, text: string) {
  const chars = Array.from(input)
  chars.splice(Math.max(0, Math.min(chars.length, cursor)), 0, ...Array.from(text))
  return chars.join("")
}

function deleteCodePointBefore(input: string, cursor: number) {
  const chars = Array.from(input)
  const index = Math.max(0, Math.min(chars.length, cursor) - 1)
  if (index < chars.length) chars.splice(index, 1)
  return chars.join("")
}

function deleteCodePointAt(input: string, cursor: number) {
  const chars = Array.from(input)
  const index = Math.max(0, Math.min(chars.length, cursor))
  if (index < chars.length) chars.splice(index, 1)
  return chars.join("")
}

function codePointLength(input: string) {
  return Array.from(input).length
}

function codePointSlice(input: string, start: number, end?: number) {
  return Array.from(input).slice(start, end).join("")
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isTerminalPlannerTruncated(message: string) {
  return /\bfinish_reason=length\b/.test(message)
}
