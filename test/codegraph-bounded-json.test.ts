import { describe, expect, test } from "bun:test"
import { encodeBoundedJson, splitArrayValueIntoBoundedChunks, splitRecordIntoBoundedJsonParts } from "../src/codegraph-bounded-json"
import { parseCFile } from "../src/codegraph-c-parser"
import { mergeCodeGraphFileStorageParts, splitCodeGraphFilesForStorage } from "../src/codegraph-file-storage"
import type { CodeGraphFile } from "../src/codegraph-types"

describe("code graph bounded JSON storage", () => {
  test("splits one dense logical file shard into multiple physical parts", () => {
    const files = denseShardFiles()
    const parts = splitCodeGraphFilesForStorage(files, {
      shardKey: "drivers/dense",
      label: "file shard drivers/dense",
      basePath: "shards/v8-test/drivers_dense",
      targetPartBytes: 900,
      hardPartBytes: 5000,
    })

    expect(parts.length).toBeGreaterThan(1)
    expect(Math.max(...parts.map((part) => part.estimatedBytes))).toBeLessThanOrEqual(5000)
    expect(parts.map((part) => part.path)).toEqual(parts.map((part) => `shards/v8-test/drivers_dense/${part.key}.json`))
    expect(mergeCodeGraphFileStorageParts(parts.map((part) => part.payload))).toEqual(files)
  })

  test("stores ordinary files as whole records instead of splitting every array", () => {
    const [file] = Object.values(denseShardFiles())
    const parts = splitCodeGraphFilesForStorage({ [file.path]: file }, {
      shardKey: "drivers/dense",
      label: "file shard drivers/dense",
      basePath: "shards/v8-test/drivers_dense",
      targetPartBytes: 1024 * 1024,
      hardPartBytes: 2 * 1024 * 1024,
    })

    expect(parts).toHaveLength(1)
    expect(parts[0].payload.fileParts).toEqual([{ kind: "whole", path: file.path, file }])
    expect(mergeCodeGraphFileStorageParts(parts.map((part) => part.payload))).toEqual({ [file.path]: file })
  })

  test("splits a single oversized file record without losing tokens", () => {
    const file = parseCFile({
      path: "test/llt/dt/dtcenter_v7_2_0/include/boost/typeof/vector100.hpp",
      hash: "boost-vector100",
      size: 1024,
      text: "int boost_vector100(void) { return 0; }\n",
    })
    const hugeFile: CodeGraphFile = {
      ...file,
      tokens: Array.from({ length: 220 }, (_, index) => ({
        term: `boost_typeof_vector100_generated_token_${index}_${"x".repeat(80)}`,
        kind: "identifier",
        line: index + 1,
      })),
    }

    const parts = splitCodeGraphFilesForStorage({ [hugeFile.path]: hugeFile }, {
      shardKey: "test/llt",
      label: "file shard test/llt",
      basePath: "shards/v8-test/test_llt",
      targetPartBytes: 1800,
      hardPartBytes: 6000,
    })

    expect(parts.length).toBeGreaterThan(1)
    expect(parts.some((part) => part.payload.fileParts.some((filePart) => filePart.kind === "array" && filePart.field === "tokens"))).toBe(true)
    expect(Math.max(...parts.map((part) => part.estimatedBytes))).toBeLessThanOrEqual(6000)
    expect(mergeCodeGraphFileStorageParts(parts.map((part) => part.payload))).toEqual({ [hugeFile.path]: hugeFile })
  })

  test("splits large arrays with linear stringify calls", () => {
    let stringifyCalls = 0
    const values = Array.from({ length: 256 }, (_, index) => ({ term: `vector100_${index}_${"x".repeat(40)}`, line: index }))

    const chunks = splitArrayValueIntoBoundedChunks({
      values,
      label: "file shard test/llt file vector100.hpp tokens",
      targetPartBytes: 1600,
      hardPartBytes: 6000,
      stringify: (value) => {
        stringifyCalls += 1
        return JSON.stringify(value)
      },
      createPayload: (items) => ({ items }),
    })

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.flat()).toEqual(values)
    expect(stringifyCalls).toBeLessThan(values.length * 3)
  })

  test("adds label and part details when JSON serialization throws RangeError", () => {
    expect(() =>
      encodeBoundedJson(
        { postingsByTerm: {} },
        {
          label: "derived postingsByTerm",
          part: "0007",
          stringify: () => {
            throw new RangeError("Invalid string length")
          },
        },
      ),
    ).toThrow(/derived postingsByTerm part 0007.*Invalid string length/)
  })

  test("rejects a single record that exceeds the hard JSON part limit", () => {
    expect(() =>
      splitRecordIntoBoundedJsonParts<string, { version: 8; key: string; records: Record<string, string> }>({
        record: { oversized_symbol: "x".repeat(900) },
        label: "derived symbolsByName",
        targetPartBytes: 100,
        hardPartBytes: 300,
        pathForPart: (_partIndex, partKey) => `derived/symbolsByName/${partKey}.json`,
        createPayload: (records, partKey) => ({ version: 8, key: partKey, records }),
      }),
    ).toThrow(/derived symbolsByName record oversized_symbol part 0000.*hard JSON part limit/)
  })

  test("labels a single oversized array item with its item index", () => {
    expect(() =>
      splitArrayValueIntoBoundedChunks({
        values: [{ term: "x".repeat(900), line: 1 }],
        label: "file shard test/llt file vector100.hpp tokens",
        targetPartBytes: 100,
        hardPartBytes: 300,
        createPayload: (items) => ({ items }),
      }),
    ).toThrow(/file shard test\/llt file vector100\.hpp tokens item 0.*hard JSON part limit/)
  })
})

function denseShardFiles(): Record<string, CodeGraphFile> {
  const files: Record<string, CodeGraphFile> = {}
  for (let index = 0; index < 16; index += 1) {
    const file = parseCFile({
      path: `drivers/dense/file_${index}.c`,
      hash: `hash-${index}`,
      size: 256,
      text: `
#include "dense_${index}.h"
int dense_fn_${index}(int value) {
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
