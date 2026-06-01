import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { Timeline } from "./message-timeline.data"

const user = {
  id: "msg_user",
  role: "user",
  sessionID: "ses_1",
  time: { created: 1 },
} as UserMessage

const assistant = {
  id: "msg_assistant",
  role: "assistant",
  parentID: user.id,
  sessionID: user.sessionID,
  time: { created: 2, completed: 3 },
} as AssistantMessage

function todoPart(id: string, status: string): Part {
  return {
    id,
    type: "tool",
    tool: "todowrite",
    callID: id,
    sessionID: user.sessionID,
    messageID: assistant.id,
    state: {
      status: "completed",
      input: {
        todos: [{ id: `${id}_item`, content: id, status, priority: "medium" }],
      },
      output: "",
      title: "todos",
      metadata: {
        todos: [{ id: `${id}_item`, content: id, status, priority: "medium" }],
      },
      time: { start: 1, end: 2 },
    },
  } as Part
}

describe("Timeline.constructMessageRows", () => {
  test("keeps only the latest todowrite snapshot for a turn", () => {
    const rows = Timeline.constructMessageRows(
      user,
      (messageID) =>
        ({
          [user.id]: [],
          [assistant.id]: [
            todoPart("prt_todo_1", "in_progress"),
            todoPart("prt_todo_2", "completed"),
            {
              id: "prt_text",
              type: "text",
              sessionID: user.sessionID,
              messageID: assistant.id,
              text: "done",
            } as Part,
          ],
        })[messageID] ?? [],
      [assistant],
      0,
      true,
      "idle",
      false,
    )

    const partIDs = rows.flatMap((row) =>
      row._tag === "AssistantPart" && row.group.type === "part" ? [row.group.ref.partID] : [],
    )

    expect(partIDs).toEqual(["prt_todo_2", "prt_text"])
  })
})
