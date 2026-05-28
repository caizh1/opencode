import type { FileContent } from "@opencode-ai/sdk/v2"
import type { FileState } from "./types"

export const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024

export type FileEditorLanguage =
  | "markdown"
  | "text"
  | "python"
  | "cpp"
  | "javascript"
  | "typescript"
  | "jsx"
  | "tsx"
  | "html"
  | "xml"
  | "css"
  | "json"
  | "yaml"
  | "sql"

export type EditableFileContent = FileContent & { type: "text"; encoding?: undefined }

const textEncoder = new TextEncoder()

export function textByteLength(value: string) {
  return textEncoder.encode(value).byteLength
}

export function editableFileContent(content: FileContent | undefined): content is EditableFileContent {
  if (!content) return false
  if (content.type !== "text") return false
  if (content.encoding === "base64") return false
  return textByteLength(content.content) <= MAX_EDITABLE_FILE_BYTES
}

export function editorLanguageFromPath(file: string | undefined): FileEditorLanguage {
  const name = (file ?? "").split(/[\\/]/).at(-1)?.toLowerCase() ?? ""
  const extension = name.match(/\.([^.]+)$/)?.[1] ?? ""

  if (extension === "md" || extension === "markdown" || extension === "mdx") return "markdown"
  if (extension === "py" || extension === "python") return "python"
  if (["c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx"].includes(extension)) return "cpp"
  if (["js", "mjs", "cjs"].includes(extension)) return "javascript"
  if (extension === "jsx") return "jsx"
  if (["ts", "mts", "cts"].includes(extension)) return "typescript"
  if (extension === "tsx") return "tsx"
  if (extension === "html" || extension === "htm") return "html"
  if (["xml", "xsd", "xsl"].includes(extension)) return "xml"
  if (["css", "scss", "sass", "less"].includes(extension)) return "css"
  if (["json", "jsonc", "json5"].includes(extension)) return "json"
  if (extension === "yaml" || extension === "yml") return "yaml"
  if (extension === "sql") return "sql"
  return "text"
}

export function startFileEditState(state: FileState): FileState {
  if (!editableFileContent(state.content)) return state
  return {
    ...state,
    editing: true,
    draft: state.content.content,
    dirty: false,
    saving: false,
    saveError: undefined,
    staleExternalChange: false,
  }
}

export function updateFileDraftState(state: FileState, draft: string): FileState {
  const dirty = draft !== (state.content?.content ?? "")
  return {
    ...state,
    draft,
    dirty,
    saveError: undefined,
    staleExternalChange: dirty ? state.staleExternalChange : false,
  }
}

export function discardFileEditState(state: FileState): FileState {
  return {
    ...state,
    editing: false,
    draft: state.content?.content ?? "",
    dirty: false,
    saving: false,
    saveError: undefined,
    staleExternalChange: false,
  }
}

export function setFileSavingState(state: FileState): FileState {
  return {
    ...state,
    saving: true,
    saveError: undefined,
  }
}

export function failFileSaveState(state: FileState, message: string): FileState {
  return {
    ...state,
    saving: false,
    saveError: message,
  }
}

export function saveFileDraftState(
  state: FileState,
  savedContent = state.draft ?? state.content?.content ?? "",
): FileState {
  const draft = state.draft ?? savedContent
  return {
    ...state,
    loaded: true,
    loading: false,
    content: {
      type: "text",
      content: savedContent,
      mimeType: state.content?.mimeType,
      charset: state.content?.charset,
    },
    draft,
    dirty: draft !== savedContent,
    saving: false,
    saveError: undefined,
    staleExternalChange: false,
  }
}

export function applyFileContentState(state: FileState, content: FileContent | undefined): FileState {
  if (!state.editing) {
    return {
      ...state,
      loaded: true,
      loading: false,
      content,
    }
  }

  if (state.dirty) {
    return {
      ...state,
      loaded: true,
      loading: false,
      content,
      staleExternalChange: content?.content !== state.content?.content ? true : state.staleExternalChange,
    }
  }

  if (!editableFileContent(content)) {
    return {
      ...state,
      loaded: true,
      loading: false,
      content,
      editing: false,
      draft: undefined,
      dirty: false,
      saving: false,
      saveError: undefined,
      staleExternalChange: false,
    }
  }

  return {
    ...state,
    loaded: true,
    loading: false,
    content,
    draft: content.content,
    dirty: false,
    saveError: undefined,
    staleExternalChange: false,
  }
}
