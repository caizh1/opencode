import { describe, expect, test } from "bun:test"
import type { Part, PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { planExitQuestionRequest, todoState } from "./session-composer-state-helpers"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
  }) as PermissionRequest

const question = (id: string, sessionID: string, tool?: QuestionRequest["tool"]) =>
  ({
    id,
    sessionID,
    questions: [],
    tool,
  }) as QuestionRequest

const toolPart = (input: { messageID: string; callID: string; tool?: string }) =>
  ({
    id: `prt_${input.callID}`,
    messageID: input.messageID,
    sessionID: "root",
    type: "tool",
    callID: input.callID,
    tool: input.tool ?? "plan_exit",
    state: {
      status: "completed",
      input: {},
      output: "",
      title: "",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }) as Part

describe("sessionPermissionRequest", () => {
  test("prefers the current session permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-root")
  })

  test("returns a nested child permission", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
      session({ id: "other" }),
    ]
    const permissions = {
      grand: [permission("perm-grand", "grand")],
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-grand")
  })

  test("returns undefined without a matching tree permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")).toBeUndefined()
  })

  test("skips filtered permissions in the current tree", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", (item) => item.id !== "perm-root"))?.toMatchObject({
      id: "perm-child",
    })
  })

  test("returns undefined when all tree permissions are filtered out", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", () => false)).toBeUndefined()
  })
})

describe("sessionQuestionRequest", () => {
  test("prefers the current session question", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const questions = {
      root: [question("q-root", "root")],
      child: [question("q-child", "child")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-root")
  })

  test("returns a nested child question", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
    ]
    const questions = {
      grand: [question("q-grand", "grand")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-grand")
  })
})

describe("planExitQuestionRequest", () => {
  test("returns a request that belongs to a plan_exit tool call", () => {
    const request = question("q-plan", "root", { messageID: "msg_1", callID: "call_1" })

    expect(
      planExitQuestionRequest(request, {
        msg_1: [toolPart({ messageID: "msg_1", callID: "call_1" })],
      }),
    ).toBe(request)
  })

  test("ignores questions without tool metadata", () => {
    expect(planExitQuestionRequest(question("q-normal", "root"), {})).toBeUndefined()
  })

  test("ignores requests when the tool part is missing", () => {
    const request = question("q-plan", "root", { messageID: "msg_1", callID: "call_1" })

    expect(planExitQuestionRequest(request, {})).toBeUndefined()
  })

  test("ignores requests when the call id does not match", () => {
    const request = question("q-plan", "root", { messageID: "msg_1", callID: "call_1" })

    expect(
      planExitQuestionRequest(request, {
        msg_1: [toolPart({ messageID: "msg_1", callID: "call_2" })],
      }),
    ).toBeUndefined()
  })

  test("ignores non-plan_exit tool requests", () => {
    const request = question("q-plan", "root", { messageID: "msg_1", callID: "call_1" })

    expect(
      planExitQuestionRequest(request, {
        msg_1: [toolPart({ messageID: "msg_1", callID: "call_1", tool: "question" })],
      }),
    ).toBeUndefined()
  })
})

describe("todoState", () => {
  test("hides when there are no todos", () => {
    expect(todoState({ count: 0, done: false, live: true })).toBe("hide")
  })

  test("opens while the session is still working", () => {
    expect(todoState({ count: 2, done: false, live: true })).toBe("open")
  })

  test("closes completed todos after a running turn", () => {
    expect(todoState({ count: 2, done: true, live: true })).toBe("close")
  })

  test("hides stale todos when the turn ends", () => {
    expect(todoState({ count: 2, done: false, live: false })).toBe("hide")
  })

  test("hides completed todos when the session is no longer live", () => {
    expect(todoState({ count: 2, done: true, live: false })).toBe("hide")
  })

  test("hides preserved stale todos during a later live turn", () => {
    expect(todoState({ count: 2, done: false, live: true, stale: true })).toBe("hide")
  })
})
