import { describe, expect, test } from "bun:test"
import type { FileContent } from "@opencode-ai/sdk/v2"
import {
  applyFileContentState,
  discardFileEditState,
  editableFileContent,
  editorLanguageFromPath,
  failFileSaveState,
  MAX_EDITABLE_FILE_BYTES,
  saveFileDraftState,
  setFileSavingState,
  startFileEditState,
  textByteLength,
  updateFileDraftState,
} from "./edit"
import type { FileState } from "./types"

const text = (content: string): FileContent => ({ type: "text", content })

describe("file edit helpers", () => {
  test("allows plain text content under the editor size limit", () => {
    expect(editableFileContent(text("hello"))).toBe(true)
    expect(editableFileContent({ type: "text", content: "中文", charset: "gb18030" })).toBe(true)
  })

  test("rejects binary, base64, and oversized content", () => {
    expect(editableFileContent({ type: "binary", content: "" })).toBe(false)
    expect(editableFileContent({ type: "text", content: "UEsDBA==", encoding: "base64" })).toBe(false)
    expect(editableFileContent(text("a".repeat(MAX_EDITABLE_FILE_BYTES + 1)))).toBe(false)
  })

  test("counts UTF-8 bytes for the size limit", () => {
    expect(textByteLength("汉字")).toBe(6)
  })

  test("maps common file extensions to CodeMirror languages", () => {
    expect(editorLanguageFromPath("README.md")).toBe("markdown")
    expect(editorLanguageFromPath("script.py")).toBe("python")
    expect(editorLanguageFromPath("src/main.c")).toBe("cpp")
    expect(editorLanguageFromPath("include/main.h")).toBe("cpp")
    expect(editorLanguageFromPath("app.tsx")).toBe("tsx")
    expect(editorLanguageFromPath("config.jsonc")).toBe("json")
    expect(editorLanguageFromPath("workflow.yaml")).toBe("yaml")
    expect(editorLanguageFromPath("query.sql")).toBe("sql")
    expect(editorLanguageFromPath("unknown.filetype")).toBe("text")
  })

  test("tracks dirty state against the latest file content", () => {
    const editing = startFileEditState({ path: "note.md", name: "note.md", content: text("base") })
    const dirty = updateFileDraftState(editing, "changed")
    const clean = updateFileDraftState(dirty, "base")

    expect(editing.editing).toBe(true)
    expect(dirty.dirty).toBe(true)
    expect(clean.dirty).toBe(false)
  })

  test("discard resets edit metadata", () => {
    const state = discardFileEditState({
      path: "note.md",
      name: "note.md",
      content: text("base"),
      editing: true,
      draft: "changed",
      dirty: true,
      saving: true,
      saveError: "nope",
      staleExternalChange: true,
    })

    expect(state.editing).toBe(false)
    expect(state.draft).toBe("base")
    expect(state.dirty).toBe(false)
    expect(state.saveError).toBeUndefined()
    expect(state.staleExternalChange).toBe(false)
  })

  test("save success promotes draft to content and clears dirty state", () => {
    const state = saveFileDraftState({
      path: "note.md",
      name: "note.md",
      content: { ...text("base"), charset: "gb18030" },
      editing: true,
      draft: "changed",
      dirty: true,
      saving: true,
      staleExternalChange: true,
    })

    expect(state.content?.content).toBe("changed")
    expect(state.content?.charset).toBe("gb18030")
    expect(state.draft).toBe("changed")
    expect(state.dirty).toBe(false)
    expect(state.saving).toBe(false)
    expect(state.staleExternalChange).toBe(false)
  })

  test("save failure keeps the draft intact", () => {
    const state = failFileSaveState(
      setFileSavingState({
        path: "note.md",
        name: "note.md",
        content: text("base"),
        editing: true,
        draft: "changed",
        dirty: true,
      }),
      "permission denied",
    )

    expect(state.draft).toBe("changed")
    expect(state.dirty).toBe(true)
    expect(state.saving).toBe(false)
    expect(state.saveError).toBe("permission denied")
  })

  test("external changes do not overwrite a dirty draft", () => {
    const state: FileState = {
      path: "note.md",
      name: "note.md",
      content: text("base"),
      editing: true,
      draft: "changed",
      dirty: true,
    }
    const next = applyFileContentState(state, text("external"))

    expect(next.content?.content).toBe("external")
    expect(next.draft).toBe("changed")
    expect(next.staleExternalChange).toBe(true)
  })
})
