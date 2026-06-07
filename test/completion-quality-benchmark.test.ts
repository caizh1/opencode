import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  COMPLETION_QUALITY_SCENARIOS,
  loadCompletionQualityFixtures,
  runDirectQwenAblation,
  runCompletionQualityBenchmark,
  validateCompletionQualityFixture,
} from "../scripts/completion-quality-benchmark"

let servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
})

describe("completion quality benchmark fixtures", () => {
  const fixtureRoot = join(import.meta.dir, "completion-fixtures")
  const expectedDomains = ["embedded-driver", "generic-c", "qemu-ufs", "ssd-domain"]

  test("loads JSONL fixtures for all P0 benchmark domains", () => {
    const fixtures = loadCompletionQualityFixtures(fixtureRoot)
    const files = new Set(fixtures.map((fixture) => fixture.file))
    const domains = new Set(expectedDomains.filter((domain) => fixtures.some((fixture) => fixture.name.startsWith(`${domain}-`))))

    expect(fixtures.length).toBeGreaterThanOrEqual(expectedDomains.length * COMPLETION_QUALITY_SCENARIOS.length)
    expect(domains).toEqual(new Set(expectedDomains))
    expect(files.size).toBeGreaterThan(10)
  })

  test("fixtures expose required fields and cover every scenario", () => {
    const fixtures = loadCompletionQualityFixtures(fixtureRoot)
    const names = new Set<string>()
    const scenarios = new Set(fixtures.map((fixture) => fixture.cursorContext.scenario))

    for (const fixture of fixtures) {
      expect(validateCompletionQualityFixture(fixture), fixture.name).toEqual([])
      expect(names.has(fixture.name), `duplicate fixture name ${fixture.name}`).toBe(false)
      names.add(fixture.name)
      expect(fixture.languageId).toMatch(/^(c|cpp)$/)
      expect(fixture.expectedPatterns.length).toBeGreaterThan(0)
      expect(fixture.forbiddenPatterns.length).toBeGreaterThan(0)
      expect(fixture.mustUseExistingSymbols.length).toBeGreaterThan(0)
    }

    for (const scenario of COMPLETION_QUALITY_SCENARIOS) {
      expect(scenarios.has(scenario), `missing scenario ${scenario}`).toBe(true)
    }
  })

  test("mock dry-run emits the P0 metric surface without treating mock as model quality", async () => {
    const root = mkdtempSync(join(tmpdir(), "completion-quality-benchmark-"))
    const fixtureDir = join(root, "generic-c")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(join(fixtureDir, "core.jsonl"), JSON.stringify({
      name: "generic-c-body-statement-smoke",
      languageId: "c",
      file: "src/smoke.c",
      prefix: "int smoke(void)\n{\n    return ",
      suffix: ";\n}\n",
      cursorContext: {
        triggerKind: "manual",
        scenario: "body-statement",
        mockOutput: "0",
      },
      expectedIntent: "body-statement",
      expectedPatterns: ["0"],
      forbiddenPatterns: ["TODO", "```"],
      mustUseExistingSymbols: ["smoke"],
      mustMatchLocalStyle: true,
    }) + "\n")

    const { summary, records } = await runCompletionQualityBenchmark({
      fixtureRoot: root,
      mock: true,
    })

    expect(records).toHaveLength(1)
    expect(summary).toMatchObject({
      run_mode: "mock-dry-run",
      quality_metric_valid: false,
      metric_note: expect.stringContaining("not model quality"),
      visible_rate: expect.any(Number),
      grounded_symbol_rate: expect.any(Number),
      forbidden_rate: expect.any(Number),
      intent_match_rate: expect.any(Number),
      style_match_rate: expect.any(Number),
      retrieval_hit_rate: expect.any(Number),
      prompt_token_count: expect.objectContaining({
        avg: expect.any(Number),
        p50: expect.any(Number),
        p95: expect.any(Number),
      }),
      latency_ms: expect.objectContaining({
        avg: expect.any(Number),
        p50: expect.any(Number),
        p95: expect.any(Number),
      }),
      raw_model_output_sample: "0",
      final_insert_text_sample: "0",
    })
  })

  test("mock dry-run dumps prompts, evidence, and latest report through the provider chain", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "completion-quality-output-"))
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }
    try {
      const { summary, records } = await runCompletionQualityBenchmark({
        fixtureRoot,
        mock: true,
        dumpPrompts: true,
        dumpEvidence: true,
        outputDir,
        sampleSeed: 1234,
        samplePrompts: 10,
      })

      expect(summary.quality_metric_valid).toBe(false)
      expect(records.length).toBeGreaterThanOrEqual(expectedDomains.length * COMPLETION_QUALITY_SCENARIOS.length)

      const promptsDir = join(outputDir, "latest-prompts")
      const evidenceDir = join(outputDir, "latest-evidence")
      const latestReportPath = join(outputDir, "latest-report.json")
      expect(existsSync(promptsDir)).toBe(true)
      expect(existsSync(evidenceDir)).toBe(true)
      expect(existsSync(latestReportPath)).toBe(true)

      const promptFiles = readdirSync(promptsDir).filter((file) => file.endsWith(".txt"))
      const evidenceFiles = readdirSync(evidenceDir).filter((file) => file.endsWith(".json"))
      expect(promptFiles.length).toBeGreaterThan(0)
      expect(evidenceFiles.length).toBeGreaterThan(0)

      const promptText = readFileSync(join(promptsDir, promptFiles[0]!), "utf8")
      expect(promptText).toContain("# fixture:")
      expect(promptText).toMatch(/<\|fim_prefix\|>|<prefix>/)
      const allPromptText = promptFiles.map((file) => readFileSync(join(promptsDir, file), "utf8")).join("\n")
      const allEvidenceText = evidenceFiles.map((file) => readFileSync(join(evidenceDir, file), "utf8")).join("\n")
      expect(allPromptText).toContain("C evidence:")
      expect(allPromptText).not.toContain("<c-embedded-evidence")
      expect(allPromptText).not.toContain("<evidence ")
      for (const evidenceKind of [
        "c-base-type",
        "c-struct-definition",
        "c-same-usage",
        "c-callee-signature",
        "c-call-example",
        "c-initializer-example",
        "c-error-labels",
        "c-cleanup-pattern",
        "c-state-machine",
        "c-register-macro",
        "c-register-access-example",
      ]) {
        expect(allPromptText, `prompt missing ${evidenceKind}`).toContain(evidenceKind)
        expect(allEvidenceText, `evidence dump missing ${evidenceKind}`).toContain(evidenceKind)
      }

      const evidence = JSON.parse(readFileSync(join(evidenceDir, evidenceFiles[0]!), "utf8")) as {
        selectedEvidence?: unknown[]
        cEmbeddedEvidenceTrace?: unknown
        retrievalTrace?: {
          symbolQueries?: unknown[]
          evidenceQueries?: unknown[]
        }
      }
      expect(Array.isArray(evidence.selectedEvidence)).toBe(true)
      expect(evidence.retrievalTrace).toEqual(expect.objectContaining({
        symbolQueries: expect.any(Array),
        evidenceQueries: expect.any(Array),
      }))

      const report = JSON.parse(readFileSync(latestReportPath, "utf8")) as {
        runMode: string
        qualityMetricValid: boolean
        records: Array<Record<string, unknown>>
      }
      expect(summary.qwen_fim.count).toBeGreaterThan(0)
      expect(summary.deterministic_symbol.count).toBeGreaterThanOrEqual(0)
      expect(summary.protocol_artifact_rate).toBe(0)
      expect(report.runMode).toBe("mock-dry-run")
      expect(report.qualityMetricValid).toBe(false)
      expect(report.records[0]).toEqual(expect.objectContaining({
        fixtureName: expect.any(String),
        actualPlanKind: expect.any(String),
        retrievalMode: expect.any(String),
        evidenceKinds: expect.any(Array),
        selectedEvidenceCount: expect.any(Number),
        contextLevel: expect.any(String),
        promptKind: expect.any(String),
        promptTokenEstimate: expect.any(Number),
        finalPromptPath: expect.any(String),
        finalEvidencePath: expect.any(String),
        retrievalPolicy: expect.any(Object),
        domainHints: expect.any(Array),
        evidencePromptBlocks: expect.any(Number),
        evidencePromptTokens: expect.any(Number),
        evidencePromptKinds: expect.any(Array),
        protocolArtifact: expect.any(Boolean),
        mockVisibleCandidate: expect.any(String),
      }))
      expect(report.records.some((record) => record.actualCIntent === "member-access" && Array.isArray(record.evidenceKinds) && record.evidenceKinds.includes("c-base-type"))).toBe(true)
      expect(report.records.some((record) => record.actualCIntent === "call-args" && Array.isArray(record.evidenceKinds) && record.evidenceKinds.includes("c-callee-signature"))).toBe(true)
      expect(report.records.some((record) => record.actualCIntent === "initializer" && Array.isArray(record.evidenceKinds) && record.evidenceKinds.includes("c-initializer-example"))).toBe(true)
      expect(report.records.some((record) => record.actualCIntent === "error-path" && Array.isArray(record.evidenceKinds) && record.evidenceKinds.includes("c-cleanup-pattern"))).toBe(true)
      expect(report.records.some((record) => record.actualCIntent === "state-machine" && Array.isArray(record.evidenceKinds) && record.evidenceKinds.includes("c-state-machine"))).toBe(true)
      expect(report.records.some((record) => record.actualCIntent === "mmio-register" && Array.isArray(record.evidenceKinds) && record.evidenceKinds.includes("c-register-macro"))).toBe(true)

      const commentGuidedRanking = report.records.find((record) => record.fixtureName === "generic-c-comment-guided-nfc-clock-reset-ranking")
      expect(commentGuidedRanking).toEqual(expect.objectContaining({
        actualPlanKind: "comment-guided-c-code",
        actualCIntent: "body-statement",
        promptKind: "qwen-fim",
        correctFunctionInCandidates: true,
        retrievalTimedOut: false,
      }))
      expect(commentGuidedRanking?.normalizedCommentTokens).toEqual(expect.arrayContaining(["wait", "nfc", "clock"]))
      expect(commentGuidedRanking?.evidenceKinds).toEqual(expect.arrayContaining([
        expect.stringMatching(/^c-(comment-semantic-match|similar-function|same-module-flow|helper-usage)$/),
      ]))
      expect(commentGuidedRanking?.selectedSimilarFunctionNames).toContain("nfdrv_wait_nfc_clk_reset")
      expect(commentGuidedRanking?.candidateTokenCoverage?.some((coverage) =>
        coverage.actionTokenCoverage > 0 && coverage.objectTokenCoverage > 0,
      )).toBe(true)
      expect(commentGuidedRanking?.semanticCandidateTopK?.some((candidate) =>
        candidate.name === "nfdrv_wait_nfc_clk_reset",
      )).toBe(true)
      expect(commentGuidedRanking?.qaRetrievalTopK).toEqual(expect.arrayContaining(["nfdrv_wait_nfc_clk_reset"]))
      expect(commentGuidedRanking?.completionRetrievalTopK).toEqual(expect.arrayContaining(["nfdrv_wait_nfc_clk_reset"]))
      expect(commentGuidedRanking?.completionTopCandidate).toEqual(expect.any(String))
      expect(commentGuidedRanking?.alignmentReason).toEqual(expect.stringMatching(/^(aligned|latency-budget|max-evidence|token-budget|rerank-disabled|rag-unavailable|graph-only-fallback|not-in-index|projection-trimmed)$/))
      expect(commentGuidedRanking?.rerankEnabled).toEqual(expect.any(Boolean))
      expect(commentGuidedRanking?.ragAvailable).toEqual(expect.any(Boolean))

      const commentPrompt = readFileSync(join(promptsDir, "generic-c-comment-guided-nfc-clock-reset-ranking.txt"), "utf8")
      const commentEvidence = JSON.parse(readFileSync(join(evidenceDir, "generic-c-comment-guided-nfc-clock-reset-ranking.json"), "utf8")) as {
        selectedEvidence?: Array<{ kind?: string; title?: string; text?: string }>
      }
      expect(commentPrompt).toContain('kind="source-comment"')
      expect(commentPrompt).toContain('kind="current-prefix"')
      expect(commentPrompt).toContain('kind="current-suffix"')
      expect(commentPrompt).toContain("C evidence: c-comment-semantic-match")
      expect(commentPrompt).toContain("nfdrv_wait_nfc_clk_reset")
      expect(commentEvidence.selectedEvidence?.some((block) =>
        block.kind === "target-symbol" && /nfc_aes_for_no_meta_get|nfc_cdma_desc_zero_init/.test(`${block.title ?? ""}\n${block.text ?? ""}`),
      )).toBe(false)

      const joinedLogs = logs.join("\n")
      for (const domain of expectedDomains) {
        expect(joinedLogs).toContain(`(${domain})`)
      }
    } finally {
      console.log = originalLog
    }
  })

  test("direct qwen ablation writes baseline and p2 evidence outputs without leaking API keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "completion-quality-direct-fixtures-"))
    const fixtureDir = join(root, "generic-c")
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(join(fixtureDir, "core.jsonl"), JSON.stringify({
      name: "generic-c-member-access-direct",
      languageId: "c",
      file: "src/parser/session.c",
      prefix: "enum parser_state { PARSER_STATE_IDLE, PARSER_STATE_READY };\nstruct parser_ctx { enum parser_state state; int error_code; };\nint parser_ready(struct parser_ctx *ctx)\n{\n    return ctx->sta",
      suffix: ";\n}\n",
      cursorContext: {
        triggerKind: "automatic",
        scenario: "member-access",
        codeGraphFiles: [{
          file: "src/parser/session_examples.c",
          text: "enum parser_state { PARSER_STATE_IDLE, PARSER_STATE_READY }; struct parser_ctx { enum parser_state state; int error_code; }; int parser_is_ready(struct parser_ctx *ctx) { return ctx->state == PARSER_STATE_READY; }",
        }],
      },
      expectedIntent: "member-access",
      expectedPatterns: ["te"],
      forbiddenPatterns: ["TODO", "```"],
      mustUseExistingSymbols: ["state", "PARSER_STATE_READY"],
      mustMatchLocalStyle: true,
    }) + "\n")
    const outputDir = mkdtempSync(join(tmpdir(), "completion-quality-direct-output-"))
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = []
    const baseUrl = await listenCompletionServer(async (request, response) => {
      const body = await collectJson(request) as Record<string, unknown>
      requests.push({ url: request.url, body })
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        choices: [{ text: "te" }],
      }))
    })

    const result = await runDirectQwenAblation({
      fixtureRoot: root,
      outputDir,
      apiBaseUrl: `${baseUrl}/v1`,
      model: "qwen-coder-turbo",
      apiKey: "super-secret-key",
      transport: "raw-completions",
      maxTokens: 64,
      temperature: 0,
      report: join(outputDir, "ablation-report.md"),
    })

    expect(requests.length).toBe(2)
    expect(requests.every((request) => request.url === "/v1/completions")).toBe(true)
    expect(JSON.stringify(result.summary)).toContain("direct-qwen")

    const baselineRoot = join(outputDir, "direct-baseline")
    const p2Root = join(outputDir, "direct-p2-evidence")
    for (const variantRoot of [baselineRoot, p2Root]) {
      expect(existsSync(join(variantRoot, "latest-prompts"))).toBe(true)
      expect(existsSync(join(variantRoot, "latest-evidence"))).toBe(true)
      expect(existsSync(join(variantRoot, "raw-model-output"))).toBe(true)
      expect(existsSync(join(variantRoot, "final-insert-text"))).toBe(true)
      expect(existsSync(join(variantRoot, "latest-report.json"))).toBe(true)
    }

    const baselinePrompt = readFileSync(join(baselineRoot, "latest-prompts", "generic-c-member-access-direct.txt"), "utf8")
    const p2Prompt = readFileSync(join(p2Root, "latest-prompts", "generic-c-member-access-direct.txt"), "utf8")
    expect(baselinePrompt).not.toContain("c-base-type")
    expect(p2Prompt).toContain("c-base-type")
    expect(p2Prompt).toContain("c-struct-definition")

    const latestReport = readFileSync(join(p2Root, "latest-report.json"), "utf8")
    expect(latestReport).toContain("\"actualCompletionBackend\": \"direct-qwen\"")
    expect(latestReport).toContain("\"transport\": \"raw-completions\"")
    expect(latestReport).not.toContain("super-secret-key")
  })
})

function listenCompletionServer(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>) {
  const server = http.createServer((request, response) => {
    void handler(request, response)
  })
  servers.push(server)
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "object" && address) resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function collectJson(request: http.IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8")
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}
