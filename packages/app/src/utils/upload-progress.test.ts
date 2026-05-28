import { describe, expect, test } from "bun:test"
import { uploadProgress, type UploadProgressEntry } from "./upload-progress"

const entry = (input: Partial<UploadProgressEntry> & { size: number }): UploadProgressEntry => ({
  loaded: 0,
  status: "pending",
  ...input,
})

describe("uploadProgress", () => {
  test("tracks total progress by bytes across multiple files", () => {
    expect(
      uploadProgress([
        entry({ size: 100, status: "done" }),
        entry({ size: 900, status: "uploading", loaded: 350 }),
      ]),
    ).toEqual({ total: 1000, loaded: 450, percent: 45 })
  })

  test("updates while a large current file uploads", () => {
    expect(uploadProgress([entry({ size: 1000, status: "uploading", loaded: 250 })])).toEqual({
      total: 1000,
      loaded: 250,
      percent: 25,
    })
  })

  test("counts failed files as processed so later files can complete progress", () => {
    expect(
      uploadProgress([
        entry({ size: 100, status: "error", loaded: 10 }),
        entry({ size: 100, status: "done" }),
        entry({ size: 100 }),
      ]),
    ).toEqual({ total: 300, loaded: 200, percent: 67 })
  })
})
