import { describe, expect, test } from "bun:test"
import { buildDerivedIndex, isCurrentCodeGraphIndexVersion } from "../src/codegraph-index"
import { CODEGRAPH_DERIVED_SIDECAR_FIELDS, mergeCodeGraphDerivedSidecar, splitCodeGraphDerivedIndex } from "../src/codegraph-derived-storage"
import { parseCFile } from "../src/codegraph-c-parser"
import type { CodeGraphDerivedIndex, CodeGraphFile } from "../src/codegraph-types"

describe("code graph derived sidecar storage", () => {
  test("stores derived indexes outside the manifest without losing records", () => {
    const derived = buildDerivedIndex(denseFiles())
    const sidecar = splitCodeGraphDerivedIndex(derived)

    const manifestJson = JSON.stringify(sidecar.manifest)
    expect(manifestJson).not.toContain("dense_fn_0")
    expect(manifestJson).not.toContain("dense_token_0_0")
    expect(countPostingsInSidecar(sidecar)).toBe(countPostings(derived))
    expect(mergeCodeGraphDerivedSidecar(sidecar)).toEqual(derived)
  })

  test("uses stable buckets so identical derived indexes save deterministically", () => {
    const derived = buildDerivedIndex(denseFiles())
    const first = splitCodeGraphDerivedIndex(derived, { targetPartBytes: 2048, hardPartBytes: 8192 })
    const second = splitCodeGraphDerivedIndex(derived, { targetPartBytes: 2048, hardPartBytes: 8192 })

    expect(first.manifest).toEqual(second.manifest)
    expect(first.parts).toEqual(second.parts)
  })

  test("splits every derived field through bounded JSON parts without losing records", () => {
    const derived = syntheticDerived()
    const sidecar = splitCodeGraphDerivedIndex(derived, { targetPartBytes: 700, hardPartBytes: 2400 })

    expect(sidecar.manifest.version).toBe(9)
    for (const field of CODEGRAPH_DERIVED_SIDECAR_FIELDS) {
      expect(sidecar.manifest.fields[field].length).toBeGreaterThan(0)
    }
    expect(sidecar.manifest.fields.functionIdsByName.length).toBeGreaterThan(1)
    expect(sidecar.manifest.fields.callerIdsByCallee.length).toBeGreaterThan(1)
    expect(sidecar.manifest.fields.includeTargetsByFile.length).toBeGreaterThan(1)
    expect(sidecar.manifest.fields.filePathsByInclude.length).toBeGreaterThan(1)
    expect(sidecar.manifest.fields.symbolsByName.length).toBeGreaterThan(1)
    expect(sidecar.manifest.fields.symbolsByPath.length).toBeGreaterThan(1)
    expect(sidecar.manifest.fields.postingsByTerm.length).toBeGreaterThan(1)
    expect(Math.max(...sidecar.parts.map((part) => part.estimatedBytes))).toBeLessThanOrEqual(2400)
    expect(mergeCodeGraphDerivedSidecar(sidecar)).toEqual(derived)
  })

  test("splits one huge derived postings term without losing records", () => {
    const derived = syntheticDerived()
    derived.postingsByTerm.huge_term = Array.from({ length: 180 }, (_, index) => ({
      term: "huge_term",
      path: `drivers/dense/file_${index % 4}.c`,
      line: index + 1,
      kind: "identifier",
      weight: 1,
      symbolId: `drivers/dense/file_${index % 4}.c:huge_${index}:1`,
    }))

    const sidecar = splitCodeGraphDerivedIndex(derived, { targetPartBytes: 900, hardPartBytes: 3000 })

    expect(sidecar.manifest.fields.postingsByTerm.length).toBeGreaterThan(1)
    expect(countPostingsInSidecar(sidecar)).toBe(countPostings(derived))
    expect(mergeCodeGraphDerivedSidecar(sidecar)).toEqual(derived)
  })

  test("rejects old persisted code graph versions so fixed builds rebuild from zero", () => {
    expect(isCurrentCodeGraphIndexVersion(9)).toBe(true)
    expect(isCurrentCodeGraphIndexVersion(8)).toBe(false)
    expect(isCurrentCodeGraphIndexVersion(7)).toBe(false)
    expect(isCurrentCodeGraphIndexVersion(6)).toBe(false)
    expect(isCurrentCodeGraphIndexVersion(5)).toBe(false)
    expect(isCurrentCodeGraphIndexVersion(4)).toBe(false)
    expect(isCurrentCodeGraphIndexVersion(2)).toBe(false)
  })
})

function denseFiles(): Record<string, CodeGraphFile> {
  const files: Record<string, CodeGraphFile> = {}
  for (let index = 0; index < 24; index += 1) {
    const path = `drivers/dense/file_${index}.c`
    const tokens = Array.from({ length: 40 }, (_, token) => `dense_token_${index}_${token}`).join(" ")
    const file = parseCFile({
      path,
      hash: `hash-${index}`,
      size: tokens.length,
      text: `
#include "dense_${index}.h"
int dense_fn_${index}(int value) {
  // ${tokens}
  return value + dense_helper_${index}(value);
}
int dense_helper_${index}(int value) {
  return value;
}
`,
    })
    files[file.path] = file
  }
  return files
}

function countPostings(derived: CodeGraphDerivedIndex) {
  return Object.values(derived.postingsByTerm).reduce((count, postings) => count + postings.length, 0)
}

function countPostingsInSidecar(sidecar: ReturnType<typeof splitCodeGraphDerivedIndex>) {
  return sidecar.parts.reduce(
    (count, part) => count + (part.payload.field === "postingsByTerm"
      ? Object.values(part.payload.records).reduce((bucketCount, postings) => bucketCount + (Array.isArray(postings) ? postings.length : 0), 0)
      : 0),
    0,
  )
}

function syntheticDerived(): CodeGraphDerivedIndex {
  const derived: CodeGraphDerivedIndex = {
    functionIdsByName: {},
    callerIdsByCallee: {},
    includeTargetsByFile: {},
    filePathsByInclude: {},
    directoryStats: {},
    symbolsByName: {},
    symbolsByPath: {},
    postingsByTerm: {},
    moduleStats: {},
  }
  for (let index = 0; index < 40; index += 1) {
    const path = `drivers/dense/file_${index}.c`
    const fn = `dense_function_${index}`
    const callee = `dense_callee_${index}`
    derived.functionIdsByName[fn] = [`${path}:${fn}:1`]
    derived.callerIdsByCallee[callee] = [`${path}:${fn}:1`]
    derived.includeTargetsByFile[path] = [`dense_${index}.h`, `shared_${index % 4}.h`]
    derived.filePathsByInclude[`dense_${index}.h`] = [path]
    derived.directoryStats[`drivers/dense/${index}`] = { files: 1, functions: 2, macros: 1, types: 1, globals: 1, bytes: 1024 + index }
    derived.symbolsByName[fn] = [{
      id: `${path}:${fn}:1`,
      kind: "function",
      name: fn,
      path,
      startLine: 1,
      endLine: 4,
      signature: `int ${fn}(int value)`,
      snippet: `int ${fn}(int value) { return value + ${index}; }`,
    }]
    derived.symbolsByPath[path] = [...derived.symbolsByName[fn]]
    derived.postingsByTerm[`dense_token_${index}`] = [{
      term: `dense_token_${index}`,
      path,
      line: 2,
      kind: "identifier",
      weight: 1,
      symbolId: `${path}:${fn}:1`,
    }]
    derived.moduleStats[`drivers/dense/${index}`] = {
      files: 1,
      functions: 2,
      macros: 1,
      types: 1,
      globals: 1,
      bytes: 1024 + index,
      externalCallers: index,
      hotSymbols: [fn, callee],
    }
  }
  return sortSyntheticDerived(derived)
}

function sortSyntheticDerived(derived: CodeGraphDerivedIndex): CodeGraphDerivedIndex {
  return Object.fromEntries(
    CODEGRAPH_DERIVED_SIDECAR_FIELDS.map((field) => [field, sortRecord(derived[field] as Record<string, unknown>)]),
  ) as CodeGraphDerivedIndex
}

function sortRecord<T>(record: Record<string, T>) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))) as Record<string, T>
}
