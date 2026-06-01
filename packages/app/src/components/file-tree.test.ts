import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { createStore, reconcile } from "solid-js/store"

let shouldListRoot: typeof import("./file-tree").shouldListRoot
let shouldListExpanded: typeof import("./file-tree").shouldListExpanded
let dirsToExpand: typeof import("./file-tree").dirsToExpand
let deleteTargets: typeof import("./file-tree").deleteTargets
let nextFileTreeSelection: typeof import("./file-tree").nextFileTreeSelection
let treeNodes: FileNode[] = []
let expandedDirs = new Set<string>()

const passthrough = (props: { children?: unknown }) => props.children

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  mock.module("@/context/file", () => ({
    useFile: () => ({
      normalize: (path: string) => path,
      tree: {
        state: (path: string) => ({ expanded: expandedDirs.has(path) }),
        list: () => Promise.resolve(),
        children: (path: string) => (path === "" ? treeNodes : []),
        expand: (path: string) => expandedDirs.add(path),
        collapse: (path: string) => expandedDirs.delete(path),
        refresh: () => Promise.resolve(),
      },
    }),
  }))
  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string, vars?: Record<string, string | number | boolean>) =>
        vars?.count === undefined ? key : `${key} ${vars.count}`,
    }),
  }))
  mock.module("@/context/sdk", () => ({
    useSDK: () => ({
      url: "http://localhost:13000",
      directory: "/workspace",
    }),
  }))
  mock.module("@opencode-ai/ui/collapsible", () => ({
    Collapsible: Object.assign(passthrough, {
      Trigger: passthrough,
      Content: passthrough,
    }),
  }))
  mock.module("@opencode-ai/ui/context-menu", () => ({
    ContextMenu: Object.assign(passthrough, {
      Trigger: passthrough,
      Portal: passthrough,
      Content: passthrough,
      Item: passthrough,
      ItemLabel: passthrough,
      Separator: () => null,
    }),
  }))
  mock.module("@opencode-ai/ui/file-icon", () => ({ FileIcon: () => null }))
  mock.module("@opencode-ai/ui/icon", () => ({ Icon: () => null }))
  mock.module("@opencode-ai/ui/tooltip", () => ({ Tooltip: (props: { children?: unknown }) => props.children }))
  mock.module("@opencode-ai/ui/toast", () => ({ showToast: () => undefined }))
  const mod = await import("./file-tree")
  shouldListRoot = mod.shouldListRoot
  shouldListExpanded = mod.shouldListExpanded
  dirsToExpand = mod.dirsToExpand
  deleteTargets = mod.deleteTargets
  nextFileTreeSelection = mod.nextFileTreeSelection
})

beforeEach(() => {
  treeNodes = []
  expandedDirs = new Set<string>()
})

describe("file tree fetch discipline", () => {
  test("root lists on mount unless already loaded or loading", () => {
    expect(shouldListRoot({ level: 0 })).toBe(true)
    expect(shouldListRoot({ level: 0, dir: { loaded: true } })).toBe(false)
    expect(shouldListRoot({ level: 0, dir: { loading: true } })).toBe(false)
    expect(shouldListRoot({ level: 1 })).toBe(false)
  })

  test("nested dirs list only when expanded and stale", () => {
    expect(shouldListExpanded({ level: 1 })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: false } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true } })).toBe(true)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loaded: true } })).toBe(false)
    expect(shouldListExpanded({ level: 1, dir: { expanded: true, loading: true } })).toBe(false)
    expect(shouldListExpanded({ level: 0, dir: { expanded: true } })).toBe(false)
  })

  test("allowed auto-expand picks only collapsed dirs", () => {
    const expanded = new Set<string>()
    const filter = { dirs: new Set(["src", "src/components"]) }

    const first = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => expanded.has(dir),
    })

    expect(first).toEqual(["src", "src/components"])

    for (const dir of first) expanded.add(dir)

    const second = dirsToExpand({
      level: 0,
      filter,
      expanded: (dir) => expanded.has(dir),
    })

    expect(second).toEqual([])
    expect(dirsToExpand({ level: 1, filter, expanded: () => false })).toEqual([])
  })
})

describe("file tree selection helpers", () => {
  test("replaces selected node maps when paths are removed", () => {
    const a = { name: "a.ts", path: "a.ts", type: "file" as const }
    const b = { name: "b.ts", path: "b.ts", type: "file" as const }
    const [selection, setSelection] = createStore({ selected: { [a.path]: a, [b.path]: b } })

    setSelection("selected", reconcile({ [a.path]: a }))

    expect(Object.keys(selection.selected)).toEqual(["a.ts"])
    expect(selection.selected["b.ts"]).toBeUndefined()

    setSelection("selected", reconcile({}))

    expect(selection.selected).toEqual({})
  })

  test("toggles and ranges over visible siblings", () => {
    expect(
      nextFileTreeSelection({
        selected: [],
        target: "b.ts",
        visible: ["a.ts", "b.ts", "c.ts"],
        mode: "replace",
      }),
    ).toEqual({ selected: ["b.ts"], anchor: "b.ts" })

    expect(
      nextFileTreeSelection({
        selected: ["b.ts"],
        anchor: "b.ts",
        target: "c.ts",
        visible: ["a.ts", "b.ts", "c.ts"],
        mode: "toggle",
      }),
    ).toEqual({ selected: ["b.ts", "c.ts"], anchor: "c.ts" })

    expect(
      nextFileTreeSelection({
        selected: ["b.ts"],
        anchor: "b.ts",
        target: "a.ts",
        visible: ["a.ts", "b.ts", "c.ts"],
        mode: "range",
      }),
    ).toEqual({ selected: ["b.ts", "a.ts"], anchor: "b.ts" })

    expect(
      nextFileTreeSelection({
        selected: ["a.ts", "b.ts", "c.ts"],
        anchor: "b.ts",
        target: "b.ts",
        visible: ["a.ts", "b.ts", "c.ts"],
        mode: "toggle",
      }),
    ).toEqual({ selected: ["a.ts", "c.ts"], anchor: "a.ts" })

    expect(
      nextFileTreeSelection({
        selected: ["b.ts"],
        anchor: "b.ts",
        target: "b.ts",
        visible: ["a.ts", "b.ts", "c.ts"],
        mode: "toggle",
      }),
    ).toEqual({ selected: [], anchor: undefined })
  })

  test("dedupes child delete targets when a parent directory is selected", () => {
    expect(
      deleteTargets([
        { name: "src", path: "src", type: "directory" },
        { name: "a.ts", path: "src/a.ts", type: "file" },
        { name: "b.ts", path: "src/nested/b.ts", type: "file" },
        { name: "package.json", path: "package.json", type: "file" },
      ]),
    ).toEqual([
      { name: "src", path: "src", type: "directory" },
      { name: "package.json", path: "package.json", type: "file" },
    ])
  })
})
