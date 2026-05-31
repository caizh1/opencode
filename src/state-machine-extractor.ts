import { moduleKey } from "./codegraph-index"
import type { CodeGraphFile, CodeGraphFunction, CodeGraphIndex } from "./codegraph-types"
import {
  hashSnippet,
  type EvidenceRef,
  type StateMachine,
  type StateMachineMetric,
  type StateMachinePath,
  type StateMachineQuery,
  type StateMachineState,
  type StateMachineTransition,
} from "./analysis-types"

type CandidateState = {
  name: string
  value?: string
  evidence?: EvidenceRef
  confidence: number
}

type CandidateVariable = {
  name: string
  evidence?: EvidenceRef
  confidence: number
}

type ExtractionBucket = {
  file: CodeGraphFile
  files: CodeGraphFile[]
  module: string
  variables: Map<string, CandidateVariable>
  states: Map<string, CandidateState>
  transitions: StateMachineTransition[]
  metrics: StateMachineMetric[]
}

type FunctionLine = {
  text: string
  line: number
}

const STATE_VAR_PATTERN = /(?:[A-Za-z_]\w*(?:->|\.))?(?:state|status|mode|phase|stage|event)\b/i
const STATE_TOKEN_PATTERN = /\b[A-Z][A-Z0-9_]*(?:STATE|STATUS|MODE|PHASE|STAGE|EVENT|IDLE|INIT|READY|RUNNING|ERROR|FAILED|DONE|COMPLETE|START|STOP|OPEN|CLOSE)[A-Z0-9_]*\b|\b[A-Z]+_[A-Z0-9_]+\b/g
const MUTATOR_NAMES = ["set_state", "update_state", "transition_to", "set_status", "update_status", "set_mode", "set_phase", "set_stage"]
const LOW_CONFIDENCE_THRESHOLD = 0.58

export function extractStateMachines(index: CodeGraphIndex, options: { maxTransitions?: number } = {}): StateMachine[] {
  const started = Date.now()
  const buckets = new Map<string, ExtractionBucket>()
  const scanStarted = Date.now()

  for (const file of Object.values(index.files)) {
    const module = moduleKey(file.path)
    const bucket = buckets.get(module) ?? {
      file,
      files: [],
      module,
      variables: new Map<string, CandidateVariable>(),
      states: new Map<string, CandidateState>(),
      transitions: [],
      metrics: [],
    }
    scanTypes(file, bucket)
    scanMacros(file, bucket)
    scanFunctionsForCandidates(file, bucket)
    bucket.files.push(file)
    buckets.set(module, bucket)
  }

  const scanElapsed = Date.now() - scanStarted
  const machines: StateMachine[] = []
  for (const bucket of buckets.values()) {
    const extractStarted = Date.now()
    for (const file of bucket.files) {
      for (const fn of file.functions) {
        scanFunctionForTransitions(file, fn, bucket)
      }
    }
    expandCrossFunctionTransitions(bucket)
    bucket.metrics.push({
      phase: "scanCandidates",
      elapsedMs: scanElapsed,
      candidates: bucket.variables.size + bucket.states.size,
    })
    bucket.metrics.push({
      phase: "extractTransitions",
      elapsedMs: Date.now() - extractStarted,
      candidates: bucket.transitions.length,
    })

    const machine = buildMachine(bucket, options.maxTransitions ?? 500)
    if (machine) {
      machine.metrics.unshift({
        phase: "linkCrossFunction",
        elapsedMs: Math.max(0, Date.now() - started - scanElapsed),
        candidates: machine.paths.length,
      })
      machine.metrics.push({
        phase: "verifyEvidence",
        elapsedMs: 0,
        candidates: machine.transitions.filter((item) => item.evidence).length,
      })
      machines.push(machine)
    }
  }

  return machines.sort((left, right) => right.confidence - left.confidence || left.module.localeCompare(right.module))
}

export function findStatePath(machine: StateMachine, startState: string, endState: string, maxPaths = 5): StateMachinePath[] {
  const start = normalizeStateName(startState)
  const end = normalizeStateName(endState)
  const transitions = machine.transitions.filter((transition) => !transition.lowConfidence)
  const outgoing = new Map<string, StateMachineTransition[]>()
  for (const transition of transitions) {
    const key = normalizeStateName(transition.fromState)
    const values = outgoing.get(key) ?? []
    values.push(transition)
    outgoing.set(key, values)
  }

  const result: StateMachinePath[] = []
  const queue: StateMachineTransition[][] = []
  for (const transition of outgoing.get(start) ?? []) queue.push([transition])
  while (queue.length > 0 && result.length < maxPaths) {
    const path = queue.shift() ?? []
    const last = path[path.length - 1]
    if (!last) continue
    if (normalizeStateName(last.toState) === end) {
      result.push(pathFromTransitions(machine.id, startState, endState, path))
      continue
    }
    if (path.length >= 8) continue
    const visited = new Set(path.map((transition) => `${normalizeStateName(transition.fromState)}>${normalizeStateName(transition.toState)}`))
    for (const next of outgoing.get(normalizeStateName(last.toState)) ?? []) {
      const edge = `${normalizeStateName(next.fromState)}>${normalizeStateName(next.toState)}`
      if (visited.has(edge)) continue
      queue.push([...path, next])
    }
  }
  return result
}

export function stateMachineToTransitionTable(machine: StateMachine) {
  return machine.transitions.map((transition) => ({
    from_state: transition.fromState,
    to_state: transition.toState,
    event: transition.event ?? "",
    guard: transition.guard ?? "",
    action: transition.action ?? "",
    confidence: transition.confidence,
    evidence: `${transition.evidence.file}:${transition.evidence.startLine}-${transition.evidence.endLine}`,
  }))
}

function scanTypes(file: CodeGraphFile, bucket: ExtractionBucket) {
  for (const type of file.types) {
    if (type.kind !== "enum") continue
    const enumBody = type.snippet.slice(type.snippet.indexOf("{") + 1, type.snippet.lastIndexOf("}"))
    for (const rawMember of enumBody.split(",")) {
      const member = rawMember.trim().match(/^([A-Za-z_]\w*)\s*(?:=\s*([^,\s/]+))?/)?.slice(1)
      if (!member?.[0]) continue
      addState(bucket, {
        name: member[0],
        value: member[1],
        confidence: 0.96,
        evidence: evidence(file.path, type.startLine, type.endLine, type.snippet, "enum"),
      })
    }
  }
}

function scanMacros(file: CodeGraphFile, bucket: ExtractionBucket) {
  for (const macro of file.macros) {
    if (!looksLikeStateToken(macro.name)) continue
    const value = macro.snippet?.match(/^\s*#\s*define\s+\w+\s+(.+)$/)?.[1]?.trim()
    addState(bucket, {
      name: macro.name,
      value,
      confidence: 0.72,
      evidence: evidence(file.path, macro.line, macro.line, macro.snippet ?? macro.name, "macro"),
    })
  }
}

function scanFunctionsForCandidates(file: CodeGraphFile, bucket: ExtractionBucket) {
  for (const fn of file.functions) {
    for (const line of functionLines(fn)) {
      const variables = variableCandidates(line.text)
      for (const name of variables) {
        addVariable(bucket, {
          name,
          confidence: confidenceForVariable(name),
          evidence: evidence(file.path, line.line, line.line, line.text, "state-var"),
        })
      }
      for (const token of stateTokens(line.text)) {
        addState(bucket, {
          name: token,
          confidence: looksLikeStateToken(token) ? 0.68 : 0.5,
          evidence: evidence(file.path, line.line, line.line, line.text, "state-token"),
        })
      }
      for (const literal of stringStateLiterals(line.text)) {
        addState(bucket, {
          name: literal,
          value: literal,
          confidence: 0.55,
          evidence: evidence(file.path, line.line, line.line, line.text, "string-state"),
        })
      }
    }
  }
}

function scanFunctionForTransitions(file: CodeGraphFile, fn: CodeGraphFunction, bucket: ExtractionBucket) {
  let currentFrom = "unknown"
  let lastGuard = ""
  let lastEvent = ""
  let previousCalls: string[] = []
  const lines = functionLines(fn)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const caseState = line.text.match(/\bcase\s+([A-Za-z_]\w*|[-]?\d+)\s*:/)?.[1]
    if (caseState) {
      currentFrom = caseState
      addState(bucket, { name: caseState, confidence: 0.78, evidence: evidence(file.path, line.line, line.line, line.text, "case") })
      lastGuard = `case ${caseState}`
      continue
    }

    const stateGuard = line.text.match(/\bif\s*\(([^)]*(?:==|!=)[^)]*)\)/)?.[1]
    if (stateGuard) {
      lastGuard = cleanInline(stateGuard)
      const guardedState = stateGuard.match(/\b(?:state|status|mode|phase|stage|event)\b\s*(?:==|!=)\s*([A-Za-z_]\w*|[-]?\d+|"[^"]+")/i)?.[1]
        ?? stateGuard.match(/\b([A-Za-z_]\w*|[-]?\d+|"[^"]+")\s*(?:==|!=)\s*\b(?:state|status|mode|phase|stage|event)\b/i)?.[1]
      if (guardedState) {
        currentFrom = stripQuotes(guardedState)
        addState(bucket, { name: currentFrom, confidence: 0.7, evidence: evidence(file.path, line.line, line.line, line.text, "guard") })
      }
      lastEvent = eventFromText(line.text) ?? ""
    }

    if (/\bswitch\s*\(([^)]*)\)/.test(line.text)) {
      lastGuard = cleanInline(line.text.match(/\bswitch\s*\(([^)]*)\)/)?.[1] ?? "switch")
      lastEvent = eventFromText(line.text) ?? ""
    }

    const calls = fn.calls.filter((call) => call.line === line.line).map((call) => call.name)
    const assignment = transitionAssignment(line.text)
    const mutator = transitionMutator(line.text)
    const returnState = transitionReturnValue(line.text)
    const transitionTarget = assignment?.target ?? mutator?.target ?? returnState?.target
    if (transitionTarget) {
      const stateVar = assignment?.stateVar ?? mutator?.stateVar ?? returnState?.stateVar ?? bestVariable(bucket)
      addVariable(bucket, {
        name: stateVar,
        confidence: confidenceForVariable(stateVar),
        evidence: evidence(file.path, line.line, line.line, line.text, "transition-var"),
      })
      addState(bucket, {
        name: transitionTarget,
        confidence: 0.74,
        evidence: evidence(file.path, line.line, line.line, line.text, assignment ? "assignment-target" : "mutator-target"),
      })
      const action = actionAround(previousCalls, calls, lines.slice(index + 1, index + 3), fn)
      const guard = lastGuard || (currentFrom !== "unknown" ? `current ${stateVar} is ${currentFrom}` : undefined)
      const confidence = transitionConfidence(currentFrom, transitionTarget, guard, action, assignment ? 0.82 : returnState ? 0.64 : 0.72)
      bucket.transitions.push({
        id: `${file.path}:${fn.name}:${line.line}:${currentFrom}->${transitionTarget}`,
        machineId: "",
        fromState: currentFrom,
        toState: transitionTarget,
        event: lastEvent || eventFromText(line.text),
        guard,
        action: returnState ? `returns ${transitionTarget}${action ? `; ${action}` : ""}` : action,
        evidence: evidence(file.path, line.line, line.line, line.text, assignment ? "assignment" : returnState ? "return-state" : "mutator"),
        functionId: fn.id,
        confidence,
        lowConfidence: confidence < LOW_CONFIDENCE_THRESHOLD,
      })
    }

    previousCalls = calls.length > 0 ? calls : previousCalls
  }
}

function buildMachine(bucket: ExtractionBucket, maxTransitions: number): StateMachine | undefined {
  if (bucket.transitions.length === 0 && bucket.states.size < 2) return undefined
  const stateVar = bestVariable(bucket)
  const machineId = `sm:${bucket.module}:${normalizeStateName(stateVar)}`
  const states = [...bucket.states.values()]
    .sort((left, right) => right.confidence - left.confidence || left.name.localeCompare(right.name))
    .slice(0, 200)
    .map((state): StateMachineState => ({
      machineId,
      stateId: normalizeStateName(state.name),
      name: state.name,
      value: state.value,
      definitionRange: state.evidence,
      confidence: state.confidence,
    }))
  const stateIds = new Set(states.map((state) => state.stateId))
  for (const transition of bucket.transitions) {
    if (!stateIds.has(normalizeStateName(transition.fromState)) && transition.fromState !== "unknown") {
      states.push({
        machineId,
        stateId: normalizeStateName(transition.fromState),
        name: transition.fromState,
        confidence: 0.55,
        definitionRange: transition.evidence,
      })
      stateIds.add(normalizeStateName(transition.fromState))
    }
    if (!stateIds.has(normalizeStateName(transition.toState))) {
      states.push({
        machineId,
        stateId: normalizeStateName(transition.toState),
        name: transition.toState,
        confidence: 0.58,
        definitionRange: transition.evidence,
      })
      stateIds.add(normalizeStateName(transition.toState))
    }
  }

  const deduped = dedupeTransitions(bucket.transitions)
  const primaryTransitions = deduped.filter((transition) => !transition.lowConfidence).slice(0, maxTransitions)
  const candidateTransitions = deduped.filter((transition) => transition.lowConfidence).slice(0, maxTransitions)
  const withIds = [...primaryTransitions, ...candidateTransitions].map((transition) => ({ ...transition, machineId }))
  const primary = withIds.filter((transition) => !transition.lowConfidence)
  const candidates = withIds.filter((transition) => transition.lowConfidence)
  const query = buildQueries(machineId, states, primary)
  const machine: StateMachine = {
    id: machineId,
    name: `${bucket.module} ${stateVar} state machine`,
    module: bucket.module,
    rootSymbols: unique(primary.flatMap((transition) => [transition.functionId ?? ""]).filter(Boolean)).slice(0, 20),
    stateVar,
    language: bucket.file.language,
    confidence: machineConfidence(states, primary),
    states,
    transitions: primary,
    candidateTransitions: candidates,
    paths: query.reachable,
    query,
    evidence: uniqueEvidence([...states.flatMap((state) => state.definitionRange ? [state.definitionRange] : []), ...withIds.map((transition) => transition.evidence)]),
    metrics: bucket.metrics,
    mermaid: "",
    dot: "",
  }
  machine.mermaid = toMermaid(machine)
  machine.dot = toDot(machine)
  return machine
}

function expandCrossFunctionTransitions(bucket: ExtractionBucket) {
  const transitionsByFunctionName = new Map<string, StateMachineTransition[]>()
  for (const transition of bucket.transitions) {
    const functionId = transition.functionId
    if (!functionId) continue
    const name = functionId.split(":").at(-2)
    if (!name) continue
    const rows = transitionsByFunctionName.get(name) ?? []
    rows.push(transition)
    transitionsByFunctionName.set(name, rows)
  }
  if (transitionsByFunctionName.size === 0) return

  const propagated: StateMachineTransition[] = []
  for (const file of bucket.files) {
    for (const fn of file.functions) {
      for (const call of fn.calls) {
        const calleeTransitions = transitionsByFunctionName.get(call.name)
        if (!calleeTransitions) continue
        for (const transition of calleeTransitions.slice(0, 5)) {
          if (transition.functionId === fn.id) continue
          propagated.push({
            ...transition,
            id: `${file.path}:${fn.name}:${call.line}:via:${call.name}:${transition.fromState}->${transition.toState}`,
            event: transition.event ?? entryEvent(fn.name),
            action: `calls ${call.name}${transition.action ? `; ${transition.action}` : ""}`,
            evidence: evidence(file.path, call.line, call.line, `${fn.name} calls ${call.name}`, "cross-function-call"),
            functionId: fn.id,
            confidence: Math.min(transition.confidence, 0.68),
            lowConfidence: false,
          })
        }
      }
    }
  }
  bucket.transitions.push(...propagated)
}

function buildQueries(machineId: string, states: StateMachineState[], transitions: StateMachineTransition[]): StateMachineQuery {
  const incoming = new Set(transitions.map((transition) => normalizeStateName(transition.toState)))
  const outgoing = new Set(transitions.map((transition) => normalizeStateName(transition.fromState)))
  const deadStates = states.filter((state) => !outgoing.has(state.stateId) && incoming.has(state.stateId))
  const reachable = transitions.slice(0, 40).map((transition) => pathFromTransitions(machineId, transition.fromState, transition.toState, [transition]))
  const cycles = findCycles(machineId, transitions)
  const errorPaths = transitions
    .filter((transition) => /err|fail|fault|abort|timeout/i.test(`${transition.toState} ${transition.event ?? ""} ${transition.guard ?? ""}`))
    .slice(0, 20)
    .map((transition) => pathFromTransitions(machineId, transition.fromState, transition.toState, [transition]))
  return { reachable, deadStates, cycles, errorPaths }
}

function findCycles(machineId: string, transitions: StateMachineTransition[]) {
  const cycles: StateMachinePath[] = []
  const byFrom = new Map<string, StateMachineTransition[]>()
  for (const transition of transitions) {
    const from = normalizeStateName(transition.fromState)
    const rows = byFrom.get(from) ?? []
    rows.push(transition)
    byFrom.set(from, rows)
  }
  for (const transition of transitions) {
    const start = normalizeStateName(transition.fromState)
    const target = normalizeStateName(transition.toState)
    if (start === target) {
      cycles.push(pathFromTransitions(machineId, transition.fromState, transition.toState, [transition]))
      continue
    }
    const back = (byFrom.get(target) ?? []).find((candidate) => normalizeStateName(candidate.toState) === start)
    if (back) cycles.push(pathFromTransitions(machineId, transition.fromState, transition.fromState, [transition, back]))
    if (cycles.length >= 20) break
  }
  return cycles
}

function pathFromTransitions(machineId: string, startState: string, endState: string, transitions: StateMachineTransition[]): StateMachinePath {
  const confidence = transitions.length === 0
    ? 0
    : transitions.reduce((sum, transition) => sum + transition.confidence, 0) / transitions.length
  return {
    machineId,
    startState,
    endState,
    transitions,
    conditions: unique(transitions.flatMap((transition) => [transition.event ?? "", transition.guard ?? ""].filter(Boolean))),
    confidence,
  }
}

function toMermaid(machine: StateMachine) {
  const rows = ["stateDiagram-v2"]
  for (const transition of machine.transitions) {
    const label = [transition.event, transition.guard, transition.action].filter(Boolean).join(" / ")
    rows.push(`  ${mermaidId(transition.fromState)} --> ${mermaidId(transition.toState)}${label ? `: ${label.replace(/\n/g, " ")}` : ""}`)
  }
  if (rows.length === 1) rows.push("  [*] --> unknown")
  return rows.join("\n")
}

function toDot(machine: StateMachine) {
  const rows = [`digraph "${machine.id}" {`, "  rankdir=LR;"]
  for (const state of machine.states) rows.push(`  "${dotText(state.name)}";`)
  for (const transition of machine.transitions) {
    const label = [transition.event, transition.guard, transition.action].filter(Boolean).join(" / ")
    rows.push(`  "${dotText(transition.fromState)}" -> "${dotText(transition.toState)}"${label ? ` [label="${dotText(label)}"]` : ""};`)
  }
  rows.push("}")
  return rows.join("\n")
}

function functionLines(fn: CodeGraphFunction): FunctionLine[] {
  return fn.snippet.split(/\r?\n/).map((text, offset) => ({ text, line: fn.startLine + offset }))
}

function variableCandidates(text: string) {
  const values = new Set<string>()
  const simple = text.match(/\b(?:state|status|mode|phase|stage|event)\b/i)?.[0]
  if (simple) values.add(simple)
  for (const match of text.matchAll(/\b([A-Za-z_]\w*(?:->|\.)(?:state|status|mode|phase|stage|event))\b/gi)) values.add(match[1])
  for (const match of text.matchAll(/\b([A-Za-z_]\w*(?:State|Status|Mode|Phase|Stage|Event))\b/g)) values.add(match[1])
  return [...values]
}

function stateTokens(text: string) {
  return [...text.matchAll(STATE_TOKEN_PATTERN)].map((match) => match[0])
}

function stringStateLiterals(text: string) {
  return [...text.matchAll(/=\s*"([A-Za-z][A-Za-z0-9_-]{1,40})"/g)]
    .map((match) => match[1])
    .filter((value) => /state|status|mode|phase|stage|event|idle|ready|error|done|running/i.test(value))
}

function transitionAssignment(text: string) {
  const match = text.match(/\b([A-Za-z_]\w*(?:->|\.))?(state|status|mode|phase|stage|event)\b\s*=\s*([A-Za-z_]\w*|[-]?\d+|"[^"]+")/i)
  if (!match) return undefined
  return {
    stateVar: `${match[1] ?? ""}${match[2]}`,
    target: stripQuotes(match[3]),
  }
}

function transitionMutator(text: string) {
  for (const name of MUTATOR_NAMES) {
    const pattern = new RegExp(`\\b${name}\\s*\\(([^)]*)\\)`, "i")
    const match = text.match(pattern)
    if (!match) continue
    const args = match[1].split(",").map((arg) => stripQuotes(arg.trim())).filter(Boolean)
    if (args.length === 0) continue
    return {
      stateVar: name.includes("mode") ? "mode" : name.includes("status") ? "status" : "state",
      target: args[args.length - 1],
    }
  }
  return undefined
}

function transitionReturnValue(text: string) {
  const match = text.match(/\breturn\s+([A-Za-z_]\w*|[-]?\d+)\s*;/)
  if (!match) return undefined
  const target = match[1]
  if (!looksLikeStateToken(target) && !/^-?\d+$/.test(target)) return undefined
  return {
    stateVar: "return",
    target,
  }
}

function actionAround(previousCalls: string[], currentCalls: string[], nextLines: FunctionLine[], fn: CodeGraphFunction) {
  const nextCalls = nextLines.flatMap((line) => fn.calls.filter((call) => call.line === line.line).map((call) => call.name))
  const actions = unique([...previousCalls, ...currentCalls, ...nextCalls].filter((name) => !MUTATOR_NAMES.includes(name.toLowerCase())))
  return actions.slice(0, 4).join(", ") || undefined
}

function eventFromText(text: string) {
  const match = text.match(/\b(event|msg|message|opcode|cmd|error|err|status|type)\b[^=<>!]*[=<>!]+\s*([A-Za-z_]\w*|[-]?\d+|"[^"]+")/i)
  if (match) return `${match[1]} ${stripQuotes(match[2])}`
  const token = stateTokens(text).find((value) => /EVENT|MSG|MESSAGE|ERROR|ERR|CMD|TYPE/.test(value))
  return token
}

function entryEvent(functionName: string) {
  if (/handler|callback|cb|irq|event|message|msg|task|loop|step|tick/i.test(functionName)) return `entry ${functionName}`
  return `call ${functionName}`
}

function transitionConfidence(from: string, to: string, guard: string | undefined, action: string | undefined, base: number) {
  let score = base
  if (from !== "unknown") score += 0.08
  if (looksLikeStateToken(to)) score += 0.04
  if (guard) score += 0.04
  if (action) score += 0.02
  return Math.min(0.98, score)
}

function confidenceForVariable(name: string) {
  if (/^(state|status|mode|phase|stage|event)$/i.test(name)) return 0.78
  if (/->|\./.test(name)) return 0.84
  return 0.66
}

function machineConfidence(states: StateMachineState[], transitions: StateMachineTransition[]) {
  if (transitions.length === 0) return Math.min(0.6, states.length / 10)
  const transitionScore = transitions.reduce((sum, transition) => sum + transition.confidence, 0) / transitions.length
  return Math.min(0.96, transitionScore * 0.8 + Math.min(0.16, states.length / 100))
}

function bestVariable(bucket: ExtractionBucket) {
  const sorted = [...bucket.variables.values()].sort((left, right) => right.confidence - left.confidence || left.name.length - right.name.length)
  return sorted[0]?.name ?? "state"
}

function addState(bucket: ExtractionBucket, state: CandidateState) {
  const key = normalizeStateName(state.name)
  if (!key) return
  const existing = bucket.states.get(key)
  if (!existing || state.confidence > existing.confidence) bucket.states.set(key, state)
}

function addVariable(bucket: ExtractionBucket, variable: CandidateVariable) {
  if (!STATE_VAR_PATTERN.test(variable.name)) return
  const key = variable.name.toLowerCase()
  const existing = bucket.variables.get(key)
  if (!existing || variable.confidence > existing.confidence) bucket.variables.set(key, variable)
}

function dedupeTransitions(transitions: StateMachineTransition[]) {
  const seen = new Map<string, StateMachineTransition>()
  for (const transition of transitions) {
    const key = [
      normalizeStateName(transition.fromState),
      normalizeStateName(transition.toState),
      transition.event ?? "",
      transition.guard ?? "",
      transition.action ?? "",
    ].join("|")
    const existing = seen.get(key)
    if (!existing || transition.confidence > existing.confidence) seen.set(key, transition)
  }
  return [...seen.values()].sort((left, right) => right.confidence - left.confidence || left.evidence.file.localeCompare(right.evidence.file))
}

function uniqueEvidence(values: EvidenceRef[]) {
  const seen = new Set<string>()
  const result: EvidenceRef[] = []
  for (const value of values) {
    const key = `${value.file}:${value.startLine}:${value.endLine}:${value.snippetHash}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function evidence(file: string, startLine: number, endLine: number, snippet: string, parserKind: string): EvidenceRef {
  return {
    file,
    startLine,
    endLine,
    snippetHash: hashSnippet(snippet),
    parserKind,
    snippet: snippet.trim(),
  }
}

function normalizeStateName(name: string) {
  return stripQuotes(name).trim().replace(/[^A-Za-z0-9_:-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown"
}

function stripQuotes(value: string) {
  return value.replace(/^["']|["']$/g, "")
}

function cleanInline(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180)
}

function looksLikeStateToken(value: string) {
  return /STATE|STATUS|MODE|PHASE|STAGE|EVENT|IDLE|INIT|READY|RUNNING|ERROR|FAILED|DONE|COMPLETE|START|STOP|OPEN|CLOSE/i.test(value)
}

function mermaidId(value: string) {
  const id = normalizeStateName(value)
  return /^[A-Za-z_]\w*$/.test(id) ? id : `"${id}"`
}

function dotText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}
