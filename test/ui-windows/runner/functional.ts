import { collectLogs, delay, recordFunctionalCheck, type FunctionalCheckStatus, type RunContext } from "./environment.js"
import { OutputPage } from "./pages/output.page.js"

export type FunctionalAssertion = {
  area: string
  intent: string
  userAction: string
  expected: string
  observed: string
  evidence: string[]
  status: FunctionalCheckStatus
}

export async function waitForOutput(ctx: RunContext, output: OutputPage, pattern: RegExp, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let text = ""
  do {
    await collectLogs(ctx)
    text = await output.text()
    const match = pattern.exec(text)
    if (match) {
      return {
        matched: true,
        matchedLine: matchingLine(text, match.index),
        text,
      }
    }
    await delay(1000)
  } while (Date.now() < deadline)
  return { matched: false, text }
}

export async function recordFunctionalAssertion(ctx: RunContext, check: FunctionalAssertion) {
  await recordFunctionalCheck(ctx, check)
  if (check.status === "failed") {
    throw new Error(`functional check failed: ${check.intent}\nexpected=${check.expected}\nobserved=${check.observed}\nevidence=${check.evidence.join("; ")}`)
  }
}

export function latestUiEvidence(ctx: RunContext) {
  const step = ctx.uiSteps.at(-1)
  if (!step) return []
  const evidence = [`ui-step:${step.step}${step.commandLabel ? `:${step.commandLabel}` : ""}${step.inputLabel ? `:${step.inputLabel}` : ""}`]
  for (const [name, path] of Object.entries(step.screenshots ?? {})) {
    evidence.push(`screenshot:${name}=${path}`)
  }
  return evidence
}

export function runtimeFailureMarker(text: string) {
  return /(Cannot find module|MODULE_NOT_FOUND|dynamic import callback|tree-sitter.*missing|runtime.*missing|parser.*missing|ENOENT.*(?:tree-sitter|wasm|pdf|docx|xlsx|mammoth|exceljs))/i.exec(text)
}

export function matchingLine(text: string, index: number) {
  const start = text.lastIndexOf("\n", index) + 1
  const end = text.indexOf("\n", index)
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 500)
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
