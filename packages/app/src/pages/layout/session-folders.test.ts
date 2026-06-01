import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  groupSessionsByFolder,
  nextFolderName,
  removeSessionFolder,
  resolveSessionFolderDrop,
  sessionDragID,
  sessionFolderDropID,
  type SessionFolderState,
} from "./session-folders"

const session = (id: string) =>
  ({
    id,
    directory: "/workspace",
    title: id,
    version: "test",
    time: { created: 1, updated: 1 },
  }) as Session

describe("session folders", () => {
  test("keeps historical sessions uncategorized by default", () => {
    const grouped = groupSessionsByFolder([session("a"), session("b")], {
      folders: [{ id: "f1", name: "Work", created: 1 }],
      assignments: { a: "f1" },
    })

    expect(grouped.groups).toEqual([{ folder: { id: "f1", name: "Work", created: 1 }, sessions: [session("a")] }])
    expect(grouped.unfiled).toEqual([session("b")])
  })

  test("treats stale assignments as uncategorized", () => {
    const state: SessionFolderState = {
      folders: [],
      assignments: { a: "deleted-folder" },
    }

    expect(groupSessionsByFolder([session("a")], state).unfiled).toEqual([session("a")])
  })

  test("creates unique default names", () => {
    expect(
      nextFolderName(
        [
          { id: "f1", name: "Folder", created: 1 },
          { id: "f2", name: "Folder 2", created: 2 },
        ],
        "Folder",
      ),
    ).toBe("Folder 3")
  })

  test("removing a folder keeps assigned sessions visible as uncategorized", () => {
    const state = removeSessionFolder(
      {
        folders: [
          { id: "f1", name: "Work", created: 1 },
          { id: "f2", name: "Later", created: 2 },
        ],
        assignments: { a: "f1", b: "f2" },
      },
      "f1",
    )

    const grouped = groupSessionsByFolder([session("a"), session("b")], state)

    expect(grouped.groups).toEqual([{ folder: { id: "f2", name: "Later", created: 2 }, sessions: [session("b")] }])
    expect(grouped.unfiled).toEqual([session("a")])
  })

  test("resolves valid drag drops onto folders", () => {
    expect(
      resolveSessionFolderDrop({
        draggableID: sessionDragID("a"),
        droppableID: sessionFolderDropID("f1"),
        state: {
          folders: [{ id: "f1", name: "Work", created: 1 }],
          assignments: {},
        },
        sessions: [session("a")],
      }),
    ).toEqual({ sessionID: "a", folderID: "f1" })
  })

  test("ignores invalid and redundant folder drops", () => {
    const state: SessionFolderState = {
      folders: [{ id: "f1", name: "Work", created: 1 }],
      assignments: { a: "f1" },
    }

    expect(
      resolveSessionFolderDrop({
        draggableID: "a",
        droppableID: sessionFolderDropID("f1"),
        state,
        sessions: [session("a")],
      }),
    ).toBeUndefined()
    expect(
      resolveSessionFolderDrop({
        draggableID: sessionDragID("missing"),
        droppableID: sessionFolderDropID("f1"),
        state,
        sessions: [session("a")],
      }),
    ).toBeUndefined()
    expect(
      resolveSessionFolderDrop({
        draggableID: sessionDragID("a"),
        droppableID: sessionFolderDropID("f1"),
        state,
        sessions: [session("a")],
      }),
    ).toBeUndefined()
  })
})
