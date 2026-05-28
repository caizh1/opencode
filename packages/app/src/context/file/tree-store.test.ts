import { describe, expect, test } from "bun:test"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { createFileTreeStore } from "./tree-store"

function node(path: string, type: FileNode["type"] = "file"): FileNode {
  return {
    name: path.split("/").pop() ?? path,
    path,
    absolute: `/repo/${path}`,
    type,
    ignored: false,
  }
}

function createTree(lists: Record<string, FileNode[]>, calls: string[]) {
  return createFileTreeStore({
    scope: () => "/repo",
    normalizeDir: (input) => input.replace(/\\/g, "/").replace(/\/+$/, ""),
    list: async (dir) => {
      calls.push(dir)
      return lists[dir] ?? []
    },
    onError: (message) => {
      throw new Error(message)
    },
  })
}

describe("file tree store", () => {
  test("refreshes loaded descendants when refreshing root", async () => {
    const lists = {
      "": [node("src", "directory")],
      src: [node("src/index.ts")],
    }
    const calls: string[] = []
    const tree = createTree(lists, calls)

    await tree.listDir("")
    await tree.listDir("src")
    calls.length = 0
    lists.src = [node("src/index.ts"), node("src/next.ts")]

    await tree.refreshDir("")

    expect(calls).toEqual(["", "src"])
    expect(tree.children("src").map((item) => item.path)).toEqual(["src/index.ts", "src/next.ts"])
  })

  test("cleans removed directory state and descendant nodes", async () => {
    const lists = {
      "": [node("src", "directory")],
      src: [node("src/old", "directory")],
      "src/old": [node("src/old/file.ts")],
    }
    const calls: string[] = []
    const tree = createTree(lists, calls)

    await tree.listDir("")
    await tree.listDir("src")
    await tree.listDir("src/old")
    expect(tree.dirState("src/old")?.loaded).toBe(true)

    lists.src = []
    await tree.refreshDir("src")

    expect(tree.children("src")).toEqual([])
    expect(tree.node("src/old")).toBeUndefined()
    expect(tree.node("src/old/file.ts")).toBeUndefined()
    expect(tree.dirState("src/old")).toBeUndefined()
  })
})
