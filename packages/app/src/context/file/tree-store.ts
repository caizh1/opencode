import { createStore, produce, reconcile } from "solid-js/store"
import { batch } from "solid-js"
import type { FileNode } from "@opencode-ai/sdk/v2"

type DirectoryState = {
  expanded: boolean
  loaded?: boolean
  loading?: boolean
  error?: string
  children?: string[]
}

type TreeStoreOptions = {
  scope: () => string
  normalizeDir: (input: string) => string
  list: (input: string) => Promise<FileNode[]>
  onError: (message: string) => void
}

export function createFileTreeStore(options: TreeStoreOptions) {
  const [tree, setTree] = createStore<{
    node: Record<string, FileNode>
    dir: Record<string, DirectoryState>
  }>({
    node: {},
    dir: { "": { expanded: true } },
  })

  const inflight = new Map<string, Promise<void>>()

  const reset = () => {
    inflight.clear()
    setTree("node", reconcile({}))
    setTree("dir", reconcile({}))
    setTree("dir", "", { expanded: true })
  }

  const ensureDir = (path: string) => {
    if (tree.dir[path]) return
    setTree("dir", path, { expanded: false })
  }

  const withinDir = (path: string, dir: string) => dir === "" || path === dir || path.startsWith(dir + "/")

  const loadedDirs = (dir: string) =>
    Object.entries(tree.dir)
      .filter(([path, state]) => state.loaded && withinDir(path, dir))
      .map(([path]) => path)

  const listDir = (input: string, opts?: { force?: boolean }) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)

    const current = tree.dir[dir]
    if (!opts?.force && current?.loaded) return Promise.resolve()

    if (opts?.force) inflight.delete(dir)

    const pending = inflight.get(dir)
    if (pending) return pending

    setTree(
      "dir",
      dir,
      produce((draft) => {
        draft.loading = true
        draft.error = undefined
      }),
    )

    const directory = options.scope()

    const promise = options
      .list(dir)
      .then((items) => {
        if (options.scope() !== directory) return
        const nodes = items.map((node) => ({ ...node, path: options.normalizeDir(node.path) }))
        const prevChildren = tree.dir[dir]?.children ?? []
        const nextChildren = nodes.map((node) => node.path)
        const nextSet = new Set(nextChildren)
        const nextNodes = new Map(nodes.map((node) => [node.path, node]))
        const removedDirs = prevChildren.filter((child) => {
          const existing = tree.node[child]
          if (existing?.type !== "directory") return false
          return nextNodes.get(child)?.type !== "directory"
        })

        setTree(
          "node",
          produce((draft) => {
            for (const child of prevChildren) {
              if (nextSet.has(child)) continue
              delete draft[child]
            }

            if (removedDirs.length > 0) {
              const keys = Object.keys(draft)
              for (const key of keys) {
                for (const removed of removedDirs) {
                  if (!key.startsWith(removed + "/")) continue
                  delete draft[key]
                  break
                }
              }
            }

            for (const node of nodes) {
              draft[node.path] = node
            }
          }),
        )

        batch(() => {
          if (removedDirs.length > 0) {
            setTree(
              "dir",
              produce((draft) => {
                for (const key of Object.keys(draft)) {
                  if (!removedDirs.some((removed) => withinDir(key, removed))) continue
                  delete draft[key]
                }
              }),
            )
          }
          setTree("dir", dir, "loaded", true)
          setTree("dir", dir, "loading", false)
          setTree("dir", dir, "children", nextChildren)
        })
      })
      .catch((e) => {
        if (options.scope() !== directory) return
        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loading = false
            draft.error = e.message
          }),
        )
        options.onError(e.message)
      })
      .finally(() => {
        inflight.delete(dir)
      })

    inflight.set(dir, promise)
    return promise
  }

  const refreshDir = async (input: string) => {
    const dir = options.normalizeDir(input)
    const directory = options.scope()
    const dirs = loadedDirs(dir)

    await listDir(dir, { force: true })
    if (options.scope() !== directory) return

    for (const child of dirs.toSorted((a, b) => a.split("/").length - b.split("/").length)) {
      if (child === dir) continue
      if (options.scope() !== directory) return
      if (!tree.dir[child]?.loaded) continue
      if (tree.node[child]?.type !== "directory") continue
      await listDir(child, { force: true })
    }
  }

  const expandDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", true)
    void listDir(dir)
  }

  const collapseDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", false)
  }

  const dirState = (input: string) => {
    const dir = options.normalizeDir(input)
    return tree.dir[dir]
  }

  const children = (input: string) => {
    const dir = options.normalizeDir(input)
    const ids = tree.dir[dir]?.children
    if (!ids) return []
    const out: FileNode[] = []
    for (const id of ids) {
      const node = tree.node[id]
      if (node) out.push(node)
    }
    return out
  }

  return {
    listDir,
    refreshDir,
    expandDir,
    collapseDir,
    dirState,
    children,
    node: (path: string) => tree.node[path],
    isLoaded: (path: string) => Boolean(tree.dir[path]?.loaded),
    reset,
  }
}
