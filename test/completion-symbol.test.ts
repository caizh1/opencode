import { describe, expect, test } from "bun:test"
import {
  isAbbrev,
  resolveSymbols,
  scoreSymbol,
  symbolCandidateFromRetrievedSnippet,
  type SymbolCandidate,
} from "../src/completion-symbol"

describe("completion symbol resolver", () => {
  test("ranks exact matches ahead of prefix matches", () => {
    const [selected] = resolveSymbols({
      query: "epr_ppn_raw_write_cb_dfx",
      candidates: [
        candidate("epr_ppn_raw_write_cb_dfx_extra"),
        candidate("epr_ppn_raw_write_cb_dfx"),
      ],
    })

    expect(selected).toMatchObject({
      name: "epr_ppn_raw_write_cb_dfx",
      reasons: expect.arrayContaining(["exact"]),
    })
    expect(selected.score).toBeGreaterThan(9000)
  })

  test("ranks prefix matches with scores", () => {
    const result = resolveSymbols({
      query: "epr_ppn_raw_wri",
      candidates: [
        candidate("epr_ppn_raw_read"),
        candidate("epr_ppn_raw_write_with_cb_dfx"),
      ],
    })

    expect(result[0]).toMatchObject({
      name: "epr_ppn_raw_write_with_cb_dfx",
      score: expect.any(Number),
      reasons: expect.arrayContaining(["prefix"]),
    })
  })

  test("expands snake-case abbreviation without hardcoding project symbols", () => {
    const result = resolveSymbols({
      query: "epr_ppn_raw_wr",
      relatedPath: "src/epr/epr_ppn_raw_test.c",
      unitTestTarget: true,
      candidates: [
        candidate("epr_ppn_raw_write_with_cb_dfx", { filePath: "src/epr/epr_ppn_raw.c" }),
        candidate("epr_ppn_raw_write_cb_dfx", { filePath: "src/epr/epr_ppn_raw.c" }),
        candidate("epr_ppn_raw_read", { filePath: "src/epr/epr_ppn_raw.c" }),
      ],
    })

    expect(result[0]).toMatchObject({
      name: "epr_ppn_raw_write_with_cb_dfx",
      kind: "function",
    })
    expect(result[0].reasons.join(",")).toContain("prefix")
  })

  test("supports token and whole-name subsequence abbreviations", () => {
    expect(isAbbrev("cb", "callback")).toBe(true)
    expect(scoreSymbol("erwr", "epr_ppn_raw_write_with_cb_dfx")).toMatchObject({
      score: expect.any(Number),
      reasons: ["subsequence"],
    })
  })

  test("returns ambiguous top candidates with stable scores", () => {
    const result = resolveSymbols({
      query: "storage_wr",
      candidates: [
        candidate("storage_write"),
        candidate("storage_write_async"),
        candidate("storage_read"),
      ],
      limit: 2,
    })

    expect(result.map((item) => item.name)).toEqual(["storage_write", "storage_write_async"])
    expect(result.every((item) => item.score > 0)).toBe(true)
  })

  test("does not fabricate symbols when no candidate matches", () => {
    expect(resolveSymbols({
      query: "missing_symbol",
      candidates: [
        candidate("storage_write"),
        candidate("epr_ppn_raw_read"),
      ],
    })).toEqual([])
  })

  test("prefers function and method candidates for unit-test targets", () => {
    const result = resolveSymbols({
      query: "epr_ppn_raw_wr",
      unitTestTarget: true,
      candidates: [
        candidate("epr_ppn_raw_write_with_cb_dfx", { kind: "variable" }),
        candidate("epr_ppn_raw_write_with_cb_dfx", { kind: "function" }),
      ],
    })

    expect(result[0]).toMatchObject({
      name: "epr_ppn_raw_write_with_cb_dfx",
      kind: "function",
    })
  })

  test("can resolve candidates derived from retrieved snippets", () => {
    const snippetCandidate = symbolCandidateFromRetrievedSnippet({
      kind: "function",
      path: "src/epr/epr_ppn_raw.c",
      line: 10,
      name: "epr_ppn_raw_write_with_cb_dfx",
      text: "int epr_ppn_raw_write_with_cb_dfx(void)",
      score: 12,
    })

    expect(resolveSymbols({
      query: "epr_ppn_raw_wr",
      candidates: snippetCandidate ? [snippetCandidate] : [],
    })[0]).toMatchObject({
      name: "epr_ppn_raw_write_with_cb_dfx",
      source: "retrievedSnippet",
    })
  })
})

function candidate(name: string, overrides: Partial<SymbolCandidate> = {}): SymbolCandidate {
  return {
    name,
    kind: "function",
    score: 0,
    source: "workspace",
    ...overrides,
  }
}
