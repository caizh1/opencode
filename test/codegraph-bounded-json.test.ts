import { describe, expect, test } from "bun:test"
import { encodeBoundedJson, splitRecordIntoBoundedJsonParts } from "../src/codegraph-bounded-json"
import { parseCFile } from "../src/codegraph-c-parser"
import { mergeCodeGraphFileStorageParts, splitCodeGraphFilesForStorage } from "../src/codegraph-file-storage"
import type { CodeGraphFile } from "../src/codegraph-types"

describe("code graph bounded JSON storage", () => {
  test("splits one dense logical file shard into multiple physical parts", () => {
    const files = denseShardFiles()
    const parts = splitCodeGraphFilesForStorage(files, {
      shardKey: "drivers/dense",
      label: "file shard drivers/dense",
      basePath: "shards/v7-test/drivers_dense",
      targetPartBytes: 900,
      hardPartBytes: 5000,
    })

    expect(parts.length).toBeGreaterThan(1)
    expect(Math.max(...parts.map((part) => part.estimatedBytes))).toBeLessThanOrEqual(5000)
    expect(parts.map((part) => part.path)).toEqual(parts.map((part) => `shards/v7-test/drivers_dense/${part.key}.json`))
    expect(mergeCodeGraphFileStorageParts(parts.map((part) => part.payload))).toEqual(files)
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
      basePath: "shards/v7-test/test_llt",
      targetPartBytes: 1800,
      hardPartBytes: 6000,
    })

    expect(parts.length).toBeGreaterThan(1)
    expect(parts.some((part) => part.payload.fileParts.some((filePart) => filePart.kind === "array" && filePart.field === "tokens"))).toBe(true)
    expect(Math.max(...parts.map((part) => part.estimatedBytes))).toBeLessThanOrEqual(6000)
    expect(mergeCodeGraphFileStorageParts(parts.map((part) => part.payload))).toEqual({ [hugeFile.path]: hugeFile })
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
      splitRecordIntoBoundedJsonParts<string, { version: 7; key: string; records: Record<string, string> }>({
        record: { oversized_symbol: "x".repeat(900) },
        label: "derived symbolsByName",
        targetPartBytes: 100,
        hardPartBytes: 300,
        pathForPart: (_partIndex, partKey) => `derived/symbolsByName/${partKey}.json`,
        createPayload: (records, partKey) => ({ version: 7, key: partKey, records }),
      }),
    ).toThrow(/derived symbolsByName record oversized_symbol part 0000.*hard JSON part limit/)
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
