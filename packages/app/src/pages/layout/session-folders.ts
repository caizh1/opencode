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

const SESSION_DRAG_PREFIX = "session:"
const SESSION_FOLDER_DROP_PREFIX = "session-folder:"

export function sessionDragID(sessionID: string) {
  return `${SESSION_DRAG_PREFIX}${sessionID}`
}

export function sessionFolderDropID(folderID: string) {
  return `${SESSION_FOLDER_DROP_PREFIX}${folderID}`
}

function parsePrefixedID(id: unknown, prefix: string) {
  if (typeof id !== "string") return
  if (!id.startsWith(prefix)) return
  const value = id.slice(prefix.length)
  if (!value) return
  return value
}

export function parseSessionDragID(id: unknown) {
  return parsePrefixedID(id, SESSION_DRAG_PREFIX)
}

export function parseSessionFolderDropID(id: unknown) {
  return parsePrefixedID(id, SESSION_FOLDER_DROP_PREFIX)
}

export function resolveSessionFolderDrop(input: {
  draggableID: unknown
  droppableID: unknown
  state: SessionFolderState
  sessions?: readonly Session[]
}) {
  const sessionID = parseSessionDragID(input.draggableID)
  const folderID = parseSessionFolderDropID(input.droppableID)
  if (!sessionID || !folderID) return
  if (input.sessions && !input.sessions.some((session) => session.id === sessionID)) return
  if (!input.state.folders.some((folder) => folder.id === folderID)) return
  if (input.state.assignments[sessionID] === folderID) return
  return { sessionID, folderID }
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

export function removeSessionFolder(state: SessionFolderState, folderID: string) {
  return {
    folders: state.folders.filter((folder) => folder.id !== folderID),
    assignments: Object.fromEntries(
      Object.entries(state.assignments).filter((entry) => entry[1] !== folderID),
    ) as SessionFolderState["assignments"],
  }
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
      const next = removeSessionFolder(state, id)
      setState("folders", next.folders)
      setState("assignments", next.assignments)
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
