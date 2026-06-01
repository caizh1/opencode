import { createMemo, type Accessor } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"

export type SessionFolder = {
  id: string
  name: string
  created: number
  expanded?: boolean
}

export type SessionFolderState = {
  folders: SessionFolder[]
  assignments: Record<string, string | undefined>
}

export type SessionFolderGroup = {
  folder: SessionFolder
  sessions: Session[]
}

export function groupSessionsByFolder(sessions: readonly Session[], state: SessionFolderState) {
  const folders = state.folders
  const ids = new Set(folders.map((folder) => folder.id))
  const groups = folders.map((folder) => ({
    folder,
    sessions: sessions.filter((session) => state.assignments[session.id] === folder.id),
  }))
  const unfiled = sessions.filter((session) => !ids.has(state.assignments[session.id] ?? ""))
  return { groups, unfiled }
}

export function nextFolderName(folders: readonly SessionFolder[], base: string) {
  const used = new Set(folders.map((folder) => folder.name))
  if (!used.has(base)) return base

  let index = 2
  while (used.has(`${base} ${index}`)) index += 1
  return `${base} ${index}`
}

function createFolderID() {
  const random = Math.random().toString(36).slice(2, 8)
  return `sf_${Date.now().toString(36)}_${random}`
}

export function createSessionFolderStore(directory: string, defaultName: Accessor<string>) {
  const [state, setState] = persisted(
    Persist.workspace(directory, "session-folders"),
    createStore<SessionFolderState>({
      folders: [],
      assignments: {},
    }),
  )

  const folders = createMemo(() => state.folders)
  const snapshot = createMemo(() => ({ folders: state.folders, assignments: state.assignments }))
  const hasFolder = (id: string | undefined) => !!id && state.folders.some((folder) => folder.id === id)

  return {
    state: snapshot,
    folders,
    folderID(sessionID: string) {
      const id = state.assignments[sessionID]
      if (!hasFolder(id)) return
      return id
    },
    create(name?: string) {
      const folder = {
        id: createFolderID(),
        name: nextFolderName(state.folders, name?.trim() || defaultName()),
        created: Date.now(),
        expanded: true,
      }
      setState("folders", state.folders.length, folder)
      return folder.id
    },
    rename(id: string, name: string) {
      const trimmed = name.trim()
      if (!trimmed) return
      const index = state.folders.findIndex((folder) => folder.id === id)
      if (index === -1) return
      setState("folders", index, "name", nextFolderName(state.folders.filter((folder) => folder.id !== id), trimmed))
    },
    remove(id: string) {
      setState(
        produce((draft) => {
          draft.folders = draft.folders.filter((folder) => folder.id !== id)
          for (const [sessionID, folderID] of Object.entries(draft.assignments)) {
            if (folderID === id) delete draft.assignments[sessionID]
          }
        }),
      )
    },
    move(sessionID: string, folderID: string | undefined) {
      if (!hasFolder(folderID)) {
        setState(
          "assignments",
          produce((draft) => {
            delete draft[sessionID]
          }),
        )
        return
      }
      setState("assignments", sessionID, folderID)
    },
    setExpanded(id: string, expanded: boolean) {
      const index = state.folders.findIndex((folder) => folder.id === id)
      if (index === -1) return
      setState("folders", index, "expanded", expanded)
    },
  }
}
