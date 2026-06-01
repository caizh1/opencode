import { useFile } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import {
  createEffect,
  createMemo,
  For,
  Match,
  on,
  Show,
  splitProps,
  Switch,
  untrack,
  type ComponentProps,
  type ParentProps,
} from "solid-js"
import { createStore, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { showToast } from "@opencode-ai/ui/toast"

const MAX_DEPTH = 128

function pathToFileUrl(filepath: string): string {
  return `file://${encodeFilePath(filepath)}`
}

type Kind = "add" | "del" | "mix"

type Filter = {
  files: Set<string>
  dirs: Set<string>
}

export type SelectionMode = "replace" | "toggle" | "range"

export type SelectedFileTreeNode = Pick<FileNode, "name" | "path" | "type">

type FileTreeSelection = {
  selected: Record<string, SelectedFileTreeNode>
  anchor?: string
}

export function parentDir(path: string) {
  const idx = path.lastIndexOf("/")
  if (idx === -1) return ""
  return path.slice(0, idx)
}

export function nextFileTreeSelection(input: {
  selected: readonly string[]
  anchor?: string
  target: string
  visible: readonly string[]
  mode: SelectionMode
}) {
  const selected = new Set(input.selected)

  if (input.mode === "toggle") {
    if (selected.has(input.target)) {
      selected.delete(input.target)
      const next = Array.from(selected)
      return {
        selected: next,
        anchor: next.includes(input.anchor ?? "") ? input.anchor : next[0],
      }
    }
    selected.add(input.target)
    return { selected: Array.from(selected), anchor: input.target }
  }

  if (input.mode === "range" && input.anchor) {
    const start = input.visible.indexOf(input.anchor)
    const end = input.visible.indexOf(input.target)
    if (start !== -1 && end !== -1) {
      const [from, to] = start < end ? [start, end] : [end, start]
      for (const path of input.visible.slice(from, to + 1)) selected.add(path)
      return { selected: Array.from(selected), anchor: input.anchor }
    }
  }

  return { selected: [input.target], anchor: input.target }
}

export function deleteTargets(nodes: readonly SelectedFileTreeNode[]) {
  const sorted = nodes
    .map((node) => ({ ...node, path: node.path.replaceAll("\\", "/").replace(/\/+$/, "") }))
    .filter((node) => node.path.length > 0)
    .sort((a, b) => a.path.length - b.path.length)

  return sorted.filter((node, index) => {
    return !sorted.slice(0, index).some((parent) => {
      if (parent.type !== "directory") return false
      return node.path === parent.path || node.path.startsWith(`${parent.path}/`)
    })
  })
}

export function shouldListRoot(input: { level: number; dir?: { loaded?: boolean; loading?: boolean } }) {
  if (input.level !== 0) return false
  if (input.dir?.loaded) return false
  if (input.dir?.loading) return false
  return true
}

export function shouldListExpanded(input: {
  level: number
  dir?: { expanded?: boolean; loaded?: boolean; loading?: boolean }
}) {
  if (input.level === 0) return false
  if (!input.dir?.expanded) return false
  if (input.dir.loaded) return false
  if (input.dir.loading) return false
  return true
}

export function dirsToExpand(input: {
  level: number
  filter?: { dirs: Set<string> }
  expanded: (dir: string) => boolean
}) {
  if (input.level !== 0) return []
  if (!input.filter) return []
  return [...input.filter.dirs].filter((dir) => !input.expanded(dir))
}

const kindLabel = (kind: Kind) => {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

const kindTextColor = (kind: Kind) => {
  if (kind === "add") return "color: var(--icon-diff-add-base)"
  if (kind === "del") return "color: var(--icon-diff-delete-base)"
  return "color: var(--icon-diff-modified-base)"
}

const kindDotColor = (kind: Kind) => {
  if (kind === "add") return "background-color: var(--icon-diff-add-base)"
  if (kind === "del") return "background-color: var(--icon-diff-delete-base)"
  return "background-color: var(--icon-diff-modified-base)"
}

const formatRelTime = (mtime?: number) => {
  if (mtime == null) return ""
  const diff = Date.now() - mtime
  if (diff < 0) return "just now"
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  const date = new Date(mtime)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

const formatSize = (bytes?: number) => {
  if (bytes == null) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const visibleKind = (node: FileNode, kinds?: ReadonlyMap<string, Kind>, marks?: Set<string>) => {
  const kind = kinds?.get(node.path)
  if (!kind) return
  if (!marks?.has(node.path)) return
  return kind
}

const buildDragImage = (target: HTMLElement) => {
  const icon = target.querySelector('[data-component="file-icon"]') ?? target.querySelector("svg")
  const text = target.querySelector('[data-filetree-label="true"]') ?? target.querySelector("span")
  if (!icon || !text) return

  const image = document.createElement("div")
  image.className =
    "flex items-center gap-x-2 px-2 py-1 bg-surface-raised-base rounded-md border border-border-base text-12-regular text-text-strong"
  image.style.position = "absolute"
  image.style.top = "-1000px"
  image.innerHTML = (icon as SVGElement).outerHTML + (text as HTMLSpanElement).outerHTML
  return image
}

const withFileDragImage = (event: DragEvent) => {
  const image = buildDragImage(event.currentTarget as HTMLElement)
  if (!image) return
  document.body.appendChild(image)
  event.dataTransfer?.setDragImage(image, 0, 12)
  setTimeout(() => document.body.removeChild(image), 0)
}

const FileTreeNode = (
  p: ParentProps &
    ComponentProps<"div"> &
    {
      node: FileNode
      level: number
      active?: string
      nodeClass?: string
      draggable: boolean
      selected?: boolean
    },
) => {
  const [local, rest] = splitProps(p, [
    "node",
    "level",
    "active",
    "nodeClass",
    "draggable",
    "selected",
    "children",
    "class",
    "classList",
  ])

  return (
    <div
      classList={{
        "group/filetree w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors cursor-pointer": true,
        "bg-surface-base-active": local.node.path === local.active,
        "bg-surface-raised-base-hover": local.selected,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
        [local.nodeClass ?? ""]: !!local.nodeClass,
      }}
      data-selected={local.selected ? "" : undefined}
      style={`padding-left: ${Math.max(0, 8 + local.level * 12 - (local.node.type === "file" ? 24 : 4))}px`}
      draggable={local.draggable}
      onDragStart={(event: DragEvent) => {
        if (!local.draggable) return
        event.dataTransfer?.setData("text/plain", `file:${local.node.path}`)
        event.dataTransfer?.setData("text/uri-list", pathToFileUrl(local.node.path))
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy"
        withFileDragImage(event)
      }}
      {...rest}
    >
      {local.children}
    </div>
  )
}

const FileTreeNodeLabel = (props: { node: FileNode; kinds?: ReadonlyMap<string, Kind>; marks?: Set<string> }) => {
  const kind = () => visibleKind(props.node, props.kinds, props.marks)
  const active = () => !!kind() && !props.node.ignored
  const color = () => {
    const value = kind()
    if (!value) return
    return kindTextColor(value)
  }

  return (
    <>
      <span
        data-filetree-label="true"
        classList={{
          "flex-1 min-w-0 text-12-medium whitespace-nowrap truncate": true,
          "text-text-weaker": props.node.ignored,
          "text-text-weak": !props.node.ignored && !active(),
        }}
        style={active() ? color() : undefined}
      >
        {props.node.name}
      </span>
      <span class="shrink-0 text-[10px] leading-none text-text-weaker ml-auto whitespace-nowrap">
        {formatRelTime(props.node.mtime)}
        &nbsp;
        {formatSize(props.node.size)}
      </span>
      {(() => {
        const value = kind()
        if (!value) return null
        if (props.node.type === "file") {
          return (
            <span class="shrink-0 w-4 text-center text-12-medium" style={kindTextColor(value)}>
              {kindLabel(value)}
            </span>
          )
        }
        return <div class="shrink-0 size-1.5 mr-1.5 rounded-full" style={kindDotColor(value)} />
      })()}
    </>
  )
}

export default function FileTree(props: {
  path: string
  class?: string
  nodeClass?: string
  active?: string
  level?: number
  allowed?: readonly string[]
  modified?: readonly string[]
  kinds?: ReadonlyMap<string, Kind>
  draggable?: boolean
  onFileClick?: (file: FileNode) => void

  _filter?: Filter
  _marks?: Set<string>
  _deeps?: Map<string, number>
  _kinds?: ReadonlyMap<string, Kind>
  _chain?: readonly string[]
  _selection?: Store<FileTreeSelection>
  _setSelection?: SetStoreFunction<FileTreeSelection>
}) {
  const file = useFile()
  const language = useLanguage()
  const sdk = useSDK()
  const level = props.level ?? 0
  const draggable = () => props.draggable ?? true
  const [ownedSelection, setOwnedSelection] = createStore<FileTreeSelection>({ selected: {} })
  const selection = props._selection ?? ownedSelection
  const setSelection = props._setSelection ?? setOwnedSelection

  const key = (p: string) =>
    file
      .normalize(p)
      .replace(/[\\/]+$/, "")
      .replaceAll("\\", "/")
  const chain = props._chain ? [...props._chain, key(props.path)] : [key(props.path)]

  const filter = createMemo(() => {
    if (props._filter) return props._filter

    const allowed = props.allowed
    if (!allowed) return

    const files = new Set(allowed)
    const dirs = new Set<string>()

    for (const item of allowed) {
      const parts = item.split("/")
      const parents = parts.slice(0, -1)
      for (const [idx] of parents.entries()) {
        const dir = parents.slice(0, idx + 1).join("/")
        if (dir) dirs.add(dir)
      }
    }

    return { files, dirs }
  })

  const marks = createMemo(() => {
    if (props._marks) return props._marks

    const out = new Set<string>()
    for (const item of props.modified ?? []) out.add(item)
    for (const item of props.kinds?.keys() ?? []) out.add(item)
    if (out.size === 0) return
    return out
  })

  const kinds = createMemo(() => {
    if (props._kinds) return props._kinds
    return props.kinds
  })

  const deeps = createMemo(() => {
    if (props._deeps) return props._deeps

    const out = new Map<string, number>()

    const root = props.path
    if (!(file.tree.state(root)?.expanded ?? false)) return out

    const seen = new Set<string>()
    const stack: { dir: string; lvl: number; i: number; kids: string[]; max: number }[] = []

    const push = (dir: string, lvl: number) => {
      const id = key(dir)
      if (seen.has(id)) return
      seen.add(id)

      const kids = file.tree
        .children(dir)
        .filter((node) => node.type === "directory" && (file.tree.state(node.path)?.expanded ?? false))
        .map((node) => node.path)

      stack.push({ dir, lvl, i: 0, kids, max: lvl })
    }

    push(root, level - 1)

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!

      if (top.i < top.kids.length) {
        const next = top.kids[top.i]!
        top.i++
        push(next, top.lvl + 1)
        continue
      }

      out.set(top.dir, top.max)
      stack.pop()

      const parent = stack[stack.length - 1]
      if (!parent) continue
      parent.max = Math.max(parent.max, top.max)
    }

    return out
  })

  createEffect(() => {
    const current = filter()
    const dirs = dirsToExpand({
      level,
      filter: current,
      expanded: (dir) => untrack(() => file.tree.state(dir)?.expanded) ?? false,
    })
    for (const dir of dirs) file.tree.expand(dir)
  })

  createEffect(
    on(
      () => props.path,
      (path) => {
        const dir = untrack(() => file.tree.state(path))
        if (!shouldListRoot({ level, dir })) return
        void file.tree.list(path)
      },
      { defer: false },
    ),
  )

  const nodes = createMemo(() => {
    const nodes = file.tree.children(props.path)
    const current = filter()
    if (!current) return nodes

    const parent = (path: string) => {
      const idx = path.lastIndexOf("/")
      if (idx === -1) return ""
      return path.slice(0, idx)
    }

    const leaf = (path: string) => {
      const idx = path.lastIndexOf("/")
      return idx === -1 ? path : path.slice(idx + 1)
    }

    const out = nodes.filter((node) => {
      if (node.type === "file") return current.files.has(node.path)
      return current.dirs.has(node.path)
    })

    const seen = new Set(out.map((node) => node.path))

    for (const dir of current.dirs) {
      if (parent(dir) !== props.path) continue
      if (seen.has(dir)) continue
      out.push({
        name: leaf(dir),
        path: dir,
        absolute: dir,
        type: "directory",
        ignored: false,
      })
      seen.add(dir)
    }

    for (const item of current.files) {
      if (parent(item) !== props.path) continue
      if (seen.has(item)) continue
      out.push({
        name: leaf(item),
        path: item,
        absolute: item,
        type: "file",
        ignored: false,
      })
      seen.add(item)
    }

    out.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      const aTime = a.mtime ?? 0
      const bTime = b.mtime ?? 0
      return bTime - aTime
    })

    return out
  })

  const selectedNodes = createMemo(() => Object.values(selection.selected))
  const selectedSet = createMemo(() => new Set(selectedNodes().map((node) => node.path)))
  const selected = (node: FileNode) => selectedSet().has(node.path)
  const selectedNode = (node: FileNode): SelectedFileTreeNode => ({
    name: node.name,
    path: node.path,
    type: node.type,
  })
  const clearSelection = () => {
    setSelection("selected", reconcile({}))
    setSelection("anchor", undefined)
  }
  const selectOnly = (node: FileNode) => {
    setSelection("selected", reconcile({ [node.path]: selectedNode(node) }))
    setSelection("anchor", node.path)
  }
  const updateSelection = (
    event: Pick<MouseEvent | KeyboardEvent, "shiftKey" | "ctrlKey" | "metaKey">,
    node: FileNode,
    modeOverride?: SelectionMode,
  ) => {
    const visible = nodes()
    const visibleByPath = new Map(visible.map((item) => [item.path, selectedNode(item)]))
    const currentByPath = new Map(selectedNodes().map((item) => [item.path, item]))
    const mode = modeOverride ?? (event.shiftKey ? "range" : event.ctrlKey || event.metaKey ? "toggle" : "replace")
    const next = nextFileTreeSelection({
      selected: Object.keys(selection.selected),
      anchor: selection.anchor,
      target: node.path,
      visible: visible.map((item) => item.path),
      mode,
    })
    const value = Object.fromEntries(
      next.selected.flatMap((path) => {
        const item = visibleByPath.get(path) ?? currentByPath.get(path)
        if (!item) return []
        return [[path, item]]
      }),
    )
    setSelection("selected", reconcile(value))
    setSelection("anchor", next.anchor)
  }
  const selectForContextMenu = (node: FileNode) => {
    if (selected(node)) return
    selectOnly(node)
  }
  const contextSelection = (node: FileNode) => {
    if (!selected(node)) return [selectedNode(node)]
    return selectedNodes()
  }
  const deleteSelected = async (items: readonly SelectedFileTreeNode[]) => {
    const targets = deleteTargets(items)
    if (targets.length === 0) return
    if (typeof window === "undefined") return

    const count = items.length
    const message =
      count === 1
        ? `Delete "${items[0]?.name ?? targets[0]?.name}"?`
        : language.t("session.files.deleteSelectedConfirm", { count })
    if (!window.confirm(message)) return

    const results = await Promise.all(
      targets.map((target) =>
        fetch(
          `${sdk.url}/file/delete?path=${encodeURIComponent(target.path)}&directory=${encodeURIComponent(sdk.directory)}`,
          { method: "DELETE" },
        ).then(
          (res) => ({ target, ok: res.ok }),
          () => ({ target, ok: false }),
        ),
      ),
    )
    const succeeded = results.filter((result) => result.ok).map((result) => result.target)
    const failed = results.length - succeeded.length

    if (succeeded.length > 0) {
      await Promise.all([...new Set(succeeded.map((target) => parentDir(target.path)))].map((dir) => file.tree.refresh(dir)))
      clearSelection()
    }

    if (failed > 0) {
      showToast({
        title: language.t("session.files.deleteFailed"),
        description: language.t("session.files.deleteFailedDescription", { count: failed }),
        variant: "error",
      })
    }
  }
  const deleteLabel = (node: FileNode) => {
    const count = contextSelection(node).length
    if (count <= 1) return language.t("session.files.delete")
    return language.t("session.files.deleteSelected", { count })
  }
  const selectionBox = (node: FileNode) => (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected(node)}
      draggable={false}
      class="shrink-0 size-3.5 rounded-sm border flex items-center justify-center transition-opacity appearance-none p-0"
      classList={{
        "border-border-base bg-background-base opacity-0 group-hover/filetree:opacity-100 group-focus-within/filetree:opacity-100":
          !selected(node) && selectedNodes().length === 0,
        "border-border-base bg-background-base opacity-60 group-hover/filetree:opacity-100 group-focus-within/filetree:opacity-100":
          !selected(node) && selectedNodes().length > 0,
        "border-icon-interactive-base bg-surface-selected-base text-icon-interactive-base opacity-100": selected(node),
      }}
      onPointerDown={(event) => {
        event.stopPropagation()
      }}
      onMouseDown={(event) => {
        event.stopPropagation()
      }}
      onClick={(event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        updateSelection(event, node, event.shiftKey ? "range" : "toggle")
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== " " && event.key !== "Enter") return
        event.preventDefault()
        event.stopPropagation()
        updateSelection(event, node, event.shiftKey ? "range" : "toggle")
      }}
      aria-label={language.t("session.files.select")}
    >
      <Show when={selected(node)}>
        <Icon name="check-small" size="small" />
      </Show>
    </button>
  )

  return (
    <div data-component="filetree" class={`flex flex-col gap-0.5 ${props.class ?? ""}`}>
      <For each={nodes()}>
        {(node) => {
          const expanded = () => file.tree.state(node.path)?.expanded ?? false
          const deep = () => deeps().get(node.path) ?? -1
          const kind = () => visibleKind(node, kinds(), marks())
          const active = () => !!kind() && !node.ignored

          return (
            <Switch>
              <Match when={node.type === "directory"}>
                <ContextMenu>
                  <Collapsible
                    variant="ghost"
                    class="w-full"
                    data-scope="filetree"
                    forceMount={false}
                    open={expanded()}
                    onOpenChange={(open) => (open ? file.tree.expand(node.path) : file.tree.collapse(node.path))}
                  >
                    <ContextMenu.Trigger>
                      <FileTreeNode
                        node={node}
                        level={level}
                        active={props.active}
                        nodeClass={props.nodeClass}
                        draggable={draggable()}
                        selected={selected(node)}
                        onContextMenu={() => selectForContextMenu(node)}
                      >
                        {selectionBox(node)}
                        <button
                          type="button"
                          aria-expanded={expanded()}
                          class="min-w-0 h-full flex flex-1 items-center justify-start gap-x-1.5 p-0 text-left bg-transparent border-0 appearance-none cursor-pointer"
                          onClick={(event: MouseEvent) => {
                            if (event.shiftKey || event.ctrlKey || event.metaKey) {
                              event.preventDefault()
                              event.stopPropagation()
                              updateSelection(event, node)
                              return
                            }
                            if (expanded()) {
                              file.tree.collapse(node.path)
                              return
                            }
                            file.tree.expand(node.path)
                          }}
                        >
                          <div class="size-4 flex items-center justify-center text-icon-weak">
                            <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
                          </div>
                          <FileTreeNodeLabel node={node} kinds={kinds()} marks={marks()} />
                        </button>
                      </FileTreeNode>
                    </ContextMenu.Trigger>
                    <Collapsible.Content class="relative pt-0.5">
                      <div
                        classList={{
                          "absolute top-0 bottom-0 w-px pointer-events-none bg-border-weak-base opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none": true,
                          "group-hover/filetree:opacity-100": expanded() && deep() === level,
                          "group-hover/filetree:opacity-50": !(expanded() && deep() === level),
                        }}
                        style={`left: ${Math.max(0, 8 + level * 12 - 4) + 8}px`}
                      />
                      <Show
                        when={level < MAX_DEPTH && !chain.includes(key(node.path))}
                        fallback={<div class="px-2 py-1 text-12-regular text-text-weak">...</div>}
                      >
                        <FileTree
                          path={node.path}
                          level={level + 1}
                          allowed={props.allowed}
                          modified={props.modified}
                          kinds={props.kinds}
                          active={props.active}
                          draggable={props.draggable}
                          onFileClick={props.onFileClick}
                          _filter={filter()}
                          _marks={marks()}
                          _deeps={deeps()}
                          _kinds={kinds()}
                          _chain={chain}
                          _selection={selection}
                          _setSelection={setSelection}
                        />
                      </Show>
                    </Collapsible.Content>
                  </Collapsible>
                  <ContextMenu.Portal>
                    <ContextMenu.Content>
                      <ContextMenu.Item
                        onSelect={() => {
                          const url = `${sdk.url}/file/download?directory=${encodeURIComponent(sdk.directory)}&path=${encodeURIComponent(node.path)}`
                          window.open(url, "_blank")
                        }}
                      >
                        <ContextMenu.ItemLabel>{language.t("session.files.download")}</ContextMenu.ItemLabel>
                      </ContextMenu.Item>
                      <ContextMenu.Separator />
                      <ContextMenu.Item
                        onSelect={async () => {
                          await deleteSelected(contextSelection(node))
                        }}
                      >
                        <ContextMenu.ItemLabel>{deleteLabel(node)}</ContextMenu.ItemLabel>
                      </ContextMenu.Item>
                    </ContextMenu.Content>
                  </ContextMenu.Portal>
                </ContextMenu>
              </Match>
              <Match when={node.type === "file"}>
                <ContextMenu>
                  <ContextMenu.Trigger>
                    <FileTreeNode
                      node={node}
                      level={level}
                      active={props.active}
                      nodeClass={props.nodeClass}
                      draggable={draggable()}
                      selected={selected(node)}
                      onContextMenu={() => selectForContextMenu(node)}
                    >
                      {selectionBox(node)}
                      <button
                        type="button"
                        class="min-w-0 h-full flex flex-1 items-center justify-start gap-x-1.5 p-0 text-left bg-transparent border-0 appearance-none cursor-pointer"
                        onClick={(event: MouseEvent) => {
                          if (event.shiftKey || event.ctrlKey || event.metaKey) {
                            event.preventDefault()
                            updateSelection(event, node)
                            return
                          }
                          props.onFileClick?.(node)
                        }}
                      >
                        <div class="w-4 shrink-0" />
                        <Switch>
                          <Match when={node.ignored}>
                            <FileIcon
                              node={node}
                              class="size-4 filetree-icon filetree-icon--mono"
                              style="color: var(--icon-weak-base)"
                              mono
                            />
                          </Match>
                          <Match when={active()}>
                            <FileIcon
                              node={node}
                              class="size-4 filetree-icon filetree-icon--mono"
                              style={kindTextColor(kind()!)}
                              mono
                            />
                          </Match>
                          <Match when={!node.ignored}>
                            <span class="filetree-iconpair size-4">
                              <FileIcon
                                node={node}
                                class="size-4 filetree-icon filetree-icon--color opacity-0 group-hover/filetree:opacity-100"
                              />
                              <FileIcon
                                node={node}
                                class="size-4 filetree-icon filetree-icon--mono group-hover/filetree:opacity-0"
                                mono
                              />
                            </span>
                          </Match>
                        </Switch>
                        <FileTreeNodeLabel node={node} kinds={kinds()} marks={marks()} />
                      </button>
                    </FileTreeNode>
                  </ContextMenu.Trigger>
                  <ContextMenu.Portal>
                    <ContextMenu.Content>
                      <ContextMenu.Item
                        onSelect={() => {
                          const url = `${sdk.url}/file/download?directory=${encodeURIComponent(sdk.directory)}&path=${encodeURIComponent(node.path)}`
                          window.open(url, "_blank")
                        }}
                      >
                        <ContextMenu.ItemLabel>{language.t("session.files.download")}</ContextMenu.ItemLabel>
                      </ContextMenu.Item>
                      <ContextMenu.Separator />
                      <ContextMenu.Item
                        onSelect={async () => {
                          await deleteSelected(contextSelection(node))
                        }}
                      >
                        <ContextMenu.ItemLabel>{deleteLabel(node)}</ContextMenu.ItemLabel>
                      </ContextMenu.Item>
                    </ContextMenu.Content>
                  </ContextMenu.Portal>
                </ContextMenu>
              </Match>
            </Switch>
          )
        }}
      </For>
    </div>
  )
}
