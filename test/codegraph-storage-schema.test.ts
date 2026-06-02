import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import { hydrateCodeGraphIndex } from "../src/codegraph-index"
import { CODEGRAPH_SQLITE_SCHEMA, createCodeGraphStorageEdges, createCodeGraphStorageManifest, snapshotRowForFile } from "../src/codegraph-storage-schema"
import type { StateMachine } from "../src/analysis-types"

describe("code graph storage schema", () => {
  test("defines sqlite-compatible tables for large-repo persistent analysis", () => {
    const ddl = CODEGRAPH_SQLITE_SCHEMA.join("\n")
    for (const table of ["files", "symbols", "edges", "postings", "modules", "state_machines", "summaries", "rag_chunks", "rag_vectors", "rag_runs", "rerank_cache", "snapshots", "schema_version"]) {
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
  })

  test("builds manifest counts from a hydrated index", () => {
    const file = parseCFile({
      path: "drivers/nand/nand.c",
      hash: "abc",
      size: 10,
      text: `
#include "nand.h"
int ecc_check(void) { return 0; }
int nand_read_page(void) { return ecc_check(); }
`,
    })
    const index = hydrateCodeGraphIndex({
      version: 1,
      rootPath: "/repo",
      rootName: "repo",
      updatedAt: 1,
      truncated: false,
      files: { [file.path]: file },
    })
    const manifest = createCodeGraphStorageManifest(index)

    expect(manifest.backend).toBe("json-sharded-sqlite-compatible")
    expect(manifest.tableCounts.files).toBe(1)
    expect(manifest.tableCounts.symbols).toBeGreaterThanOrEqual(2)
    expect(manifest.tableCounts.edges).toBeGreaterThanOrEqual(2)
    expect(manifest.tableCounts.postings).toBeGreaterThan(0)
    expect(manifest.edgeKinds).toContain("state-transition")
    expect(snapshotRowForFile({ ...file, sha256: "sha", mtime: 123 })).toMatchObject({ path: file.path, module: "drivers/nand", sha256: "sha", mtime: 123, shard: "drivers/nand" })
    const machine: StateMachine = {
      id: "machine:boot",
      name: "boot",
      module: "drivers/nand",
      rootSymbols: ["nand_read_page"],
      stateVar: "state",
      language: "c",
      confidence: 0.8,
      states: [],
      transitions: [{
        id: "transition:boot:init-ready",
        machineId: "machine:boot",
        fromState: "INIT",
        toState: "READY",
        evidence: { file: file.path, startLine: 3, endLine: 3, snippetHash: "hash", parserKind: "test" },
        confidence: 0.9,
        lowConfidence: false,
      }],
      candidateTransitions: [],
      paths: [],
      query: { reachable: [], deadStates: [], cycles: [], errorPaths: [] },
      evidence: [],
      metrics: [],
      mermaid: "",
      dot: "",
    }
    const edgeKinds = createCodeGraphStorageEdges(index, [machine]).map((edge) => edge.edgeKind)
    expect(edgeKinds).toContain("call")
    expect(edgeKinds).toContain("import")
    expect(edgeKinds).toContain("state-transition")
  })
})
