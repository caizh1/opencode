import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import { hydrateCodeGraphIndex } from "../src/codegraph-index"
import { retrieveEvidence } from "../src/codegraph-query"
import type { CodeGraphFile, CodeGraphIndex } from "../src/codegraph-types"

describe("code graph synthetic benchmark", () => {
  test("indexes and queries a 1k-file synthetic C repository", () => {
    const startedParse = Date.now()
    const files = syntheticFiles(1000)
    const parseMs = Date.now() - startedParse

    const startedIndex = Date.now()
    const index = hydrateCodeGraphIndex({
      version: 1,
      rootPath: "/synthetic",
      rootName: "synthetic",
      updatedAt: 1,
      truncated: false,
      files,
    })
    const indexMs = Date.now() - startedIndex

    const result = retrieveEvidence({
      index,
      question: "改 synthetic_target_777 会影响哪里",
      maxBytes: 60000,
      maxDepth: 2,
      maxFanout: 40,
    })

    expect(Object.keys(index.files)).toHaveLength(1000)
    expect(index.stats?.functions).toBeGreaterThanOrEqual(3000)
    expect(index.derived?.postingsByTerm.synthetic.length).toBeGreaterThan(0)
    expect(result?.mode).toBe("impact")
    expect(result?.evidence.some((item) => item.snippet.includes("synthetic_target_777"))).toBe(true)
    expect(result?.candidateCount).toBeGreaterThan(0)
    expect(result?.elapsedMs).toBeLessThan(1000)
    expect(parseMs + indexMs).toBeLessThan(5000)
  })
})

function syntheticFiles(count: number): Record<string, CodeGraphFile> {
  const files: CodeGraphFile[] = []
  for (let index = 0; index < count; index++) {
    const module = index % 2 === 0 ? "drivers/nand" : "kernel/io"
    files.push(
      parseCFile({
        path: `${module}/synthetic_${index}.c`,
        hash: String(index),
        size: 1,
        text: syntheticFileText(index),
      }),
    )
  }
  return Object.fromEntries(files.map((file) => [file.path, file]))
}

function syntheticFileText(index: number) {
  const next = Math.max(0, index - 1)
  return `
#include "synthetic_${next}.h"
#define SYNTHETIC_FEATURE_${index} ${index}
typedef unsigned int synthetic_type_${index};
struct synthetic_state_${index} { int ready; };
// synthetic benchmark module ${index} carries retrieval keyword synthetic_target_${index}
int synthetic_leaf_${index}(void) { return ${index}; }
int synthetic_target_${index}(void) { return synthetic_leaf_${index}(); }
int synthetic_entry_${index}(void) { return synthetic_target_${index}() + synthetic_target_${next}(); }
`
}
