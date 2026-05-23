import { useMarked } from "../context/marked"
import { useI18n } from "../context/i18n"
import DOMPurify from "dompurify"
import morphdom from "morphdom"
import { checksum } from "@opencode-ai/core/util/encode"
import { ComponentProps, createEffect, createResource, createSignal, onCleanup, splitProps } from "solid-js"
import { isServer } from "solid-js/web"
import { stream } from "./markdown-stream"
import { renderMermaid, isMermaid } from "./mermaid-renderer"

type Entry = {
  hash: string
  html: string
}

const max = 200
const cache = new Map<string, Entry>()

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return

    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
}

const iconPaths = {
  copy: '<path d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z" stroke="currentColor" stroke-linecap="round"/>',
  check: '<path d="M5 11.9657L8.37838 14.7529L15 5.83398" stroke="currentColor" stroke-linecap="square"/>',
}

function sanitize(html: string) {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config)
}

function escape(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fallback(markdown: string) {
  return escape(markdown).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>")
}

type CopyLabels = {
  copy: string
  copied: string
}

const urlPattern = /^https?:\/\/[^\s<>()`"']+$/

function codeUrl(text: string) {
  const href = text.trim().replace(/[),.;!?]+$/, "")
  if (!urlPattern.test(href)) return
  try {
    const url = new URL(href)
    return url.toString()
  } catch {
    return
  }
}

function createIcon(path: string, slot: string) {
  const icon = document.createElement("div")
  icon.setAttribute("data-component", "icon")
  icon.setAttribute("data-size", "small")
  icon.setAttribute("data-slot", slot)
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("data-slot", "icon-svg")
  svg.setAttribute("fill", "none")
  svg.setAttribute("viewBox", "0 0 20 20")
  svg.setAttribute("aria-hidden", "true")
  svg.innerHTML = path
  icon.appendChild(svg)
  return icon
}

function createCopyButton(labels: CopyLabels) {
  const button = document.createElement("button")
  button.type = "button"
  button.setAttribute("data-component", "icon-button")
  button.setAttribute("data-variant", "secondary")
  button.setAttribute("data-size", "small")
  button.setAttribute("data-slot", "markdown-copy-button")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
  button.appendChild(createIcon(iconPaths.copy, "copy-icon"))
  button.appendChild(createIcon(iconPaths.check, "check-icon"))
  return button
}

function setCopyState(button: HTMLButtonElement, labels: CopyLabels, copied: boolean) {
  if (copied) {
    button.setAttribute("data-copied", "true")
    button.setAttribute("aria-label", labels.copied)
    button.setAttribute("data-tooltip", labels.copied)
    return
  }
  button.removeAttribute("data-copied")
  button.setAttribute("aria-label", labels.copy)
  button.setAttribute("data-tooltip", labels.copy)
}

function ensureCodeWrapper(block: HTMLPreElement, labels: CopyLabels) {
  const parent = block.parentElement
  if (!parent) return
  const wrapped = parent.getAttribute("data-component") === "markdown-code"
  if (!wrapped) {
    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-component", "markdown-code")
    parent.replaceChild(wrapper, block)
    wrapper.appendChild(block)
    wrapper.appendChild(createCopyButton(labels))
    return
  }

  const buttons = Array.from(parent.querySelectorAll('[data-slot="markdown-copy-button"]')).filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  )

  if (buttons.length === 0) {
    parent.appendChild(createCopyButton(labels))
    return
  }

  for (const button of buttons.slice(1)) {
    button.remove()
  }
}

function markCodeLinks(root: HTMLDivElement) {
  const codeNodes = Array.from(root.querySelectorAll(":not(pre) > code"))
  for (const code of codeNodes) {
    const href = codeUrl(code.textContent ?? "")
    const parentLink =
      code.parentElement instanceof HTMLAnchorElement && code.parentElement.classList.contains("external-link")
        ? code.parentElement
        : null

    if (!href) {
      if (parentLink) parentLink.replaceWith(code)
      continue
    }

    if (parentLink) {
      parentLink.href = href
      continue
    }

    const link = document.createElement("a")
    link.href = href
    link.className = "external-link"
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    code.parentNode?.replaceChild(link, code)
    link.appendChild(code)
  }
}

function decorate(root: HTMLDivElement, labels: CopyLabels) {
  const blocks = Array.from(root.querySelectorAll("pre"))
  for (const block of blocks) {
    ensureCodeWrapper(block, labels)
  }
  markCodeLinks(root)
}

function setupCodeCopy(root: HTMLDivElement, getLabels: () => CopyLabels) {
  const timeouts = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()

  const updateLabel = (button: HTMLButtonElement) => {
    const labels = getLabels()
    const copied = button.getAttribute("data-copied") === "true"
    setCopyState(button, labels, copied)
  }

  const handleClick = async (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return

    const button = target.closest('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLButtonElement)) return
    const code = button.closest('[data-component="markdown-code"]')?.querySelector("code")
    const content = code?.textContent ?? ""
    if (!content) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    await clipboard.writeText(content)
    const labels = getLabels()
    setCopyState(button, labels, true)
    const existing = timeouts.get(button)
    if (existing) clearTimeout(existing)
    const timeout = setTimeout(() => setCopyState(button, labels, false), 2000)
    timeouts.set(button, timeout)
  }

  const buttons = Array.from(root.querySelectorAll('[data-slot="markdown-copy-button"]'))
  for (const button of buttons) {
    if (button instanceof HTMLButtonElement) updateLabel(button)
  }

  root.addEventListener("click", handleClick)

  return () => {
    root.removeEventListener("click", handleClick)
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout)
    }
  }
}

function touch(key: string, value: Entry) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= max) return

  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

function createZoomButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button")
  btn.type = "button"
  btn.setAttribute("data-slot", "mermaid-zoom-btn")
  btn.textContent = label
  btn.addEventListener("mousedown", (e) => e.preventDefault())
  btn.addEventListener("click", (e) => {
    e.stopPropagation()
    onClick()
  })
  return btn
}

function createMermaidContainer(svg: string): HTMLElement {
  const wrapper = document.createElement("div")
  wrapper.setAttribute("data-component", "mermaid-diagram")

  const viewport = document.createElement("div")
  viewport.setAttribute("data-slot", "mermaid-viewport")

  const content = document.createElement("div")
  content.setAttribute("data-slot", "mermaid-content")
  content.innerHTML = svg
  content.dataset.scale = "1"

  const svgEl = content.querySelector<SVGSVGElement>("svg")
  let naturalW = 0
  let naturalH = 0
  if (svgEl) {
    const vb = svgEl.getAttribute("viewBox")
    if (vb) {
      const parts = vb.split(/\s+/)
      if (parts.length === 4) {
        naturalW = parseInt(parts[2])
        naturalH = parseInt(parts[3])
        content.dataset.vbW = String(naturalW)
        content.dataset.vbH = String(naturalH)
      }
    }
    svgEl.style.display = "block"
    svgEl.style.maxWidth = "none"
    svgEl.style.maxHeight = "none"
  }
  if (naturalH > 0) viewport.style.height = Math.min(naturalH, 600) + "px"
  if (naturalW > 0) viewport.style.maxWidth = "100%"

  const controls = document.createElement("div")
  controls.setAttribute("data-slot", "mermaid-controls")

  const applyScale = () => {
    if (!svgEl) return
    const scale = parseFloat(content.dataset.scale || "1")
    const w = content.dataset.vbW
    const h = content.dataset.vbH
    if (!w || !h) return
    svgEl.style.width = (parseFloat(w) * scale) + "px"
    svgEl.style.height = (parseFloat(h) * scale) + "px"
  }

  const setScale = (s: number) => {
    content.dataset.scale = String(Math.max(0.1, Math.min(5, s)))
    applyScale()
  }

  const adjustZoom = (delta: number) => {
    const cur = parseFloat(content.dataset.scale || "1")
    setScale(Math.round((cur + delta) * 10) / 10)
  }

  const resetZoom = () => {
    setScale(1)
  }

  controls.appendChild(createZoomButton("\u2212", () => adjustZoom(-0.2)))
  controls.appendChild(createZoomButton("1:1", () => resetZoom()))
  controls.appendChild(createZoomButton("+", () => adjustZoom(0.2)))

  const zoomIcon = document.createElement("div")
  zoomIcon.setAttribute("data-slot", "mermaid-zoom-icon")
  zoomIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="M12.5 12.5l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8.5 6v5M6 8.5h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
  controls.insertBefore(zoomIcon, controls.firstChild)

  let dragging = false
  let dragStartX = 0
  let dragStartY = 0
  let scrollStartX = 0
  let scrollStartY = 0

  viewport.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return
    dragging = true
    dragStartX = e.clientX
    dragStartY = e.clientY
    scrollStartX = viewport.scrollLeft
    scrollStartY = viewport.scrollTop
    viewport.style.cursor = "grabbing"
  })

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return
    viewport.scrollLeft = scrollStartX - (e.clientX - dragStartX)
    viewport.scrollTop = scrollStartY - (e.clientY - dragStartY)
  })

  window.addEventListener("mouseup", () => {
    if (!dragging) return
    dragging = false
    viewport.style.cursor = ""
  })

  viewport.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    adjustZoom(e.deltaY > 0 ? -0.1 : 0.1)
  }, { passive: false })

  viewport.appendChild(content)

  wrapper.appendChild(viewport)
  wrapper.appendChild(controls)

  applyScale()

  return wrapper
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    cacheKey?: string
    streaming?: boolean
    class?: string
    classList?: Record<string, boolean>
  },
) {
  const [local, others] = splitProps(props, ["text", "cacheKey", "streaming", "class", "classList"])
  const marked = useMarked()
  const i18n = useI18n()
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const [html] = createResource(
    () => ({
      text: local.text,
      key: local.cacheKey,
      streaming: local.streaming ?? false,
    }),
    async (src) => {
      if (isServer) return fallback(src.text)
      if (!src.text) return ""

      const base = src.key ?? checksum(src.text)
      return Promise.all(
        stream(src.text, src.streaming).map(async (block, index) => {
          const hash = checksum(block.raw)
          const key = base ? `${base}:${index}:${block.mode}` : hash

          if (key && hash) {
            const cached = cache.get(key)
            if (cached && cached.hash === hash) {
              touch(key, cached)
              return cached.html
            }
          }

          const next = await Promise.resolve(marked.parse(block.src))
          const safe = sanitize(next)
          if (key && hash) touch(key, { hash, html: safe })
          return safe
        }),
      )
        .then((list) => list.join(""))
        .catch(() => fallback(src.text))
    },
    { initialValue: fallback(local.text) },
  )

  let copyCleanup: (() => void) | undefined

  createEffect(() => {
    const container = root()
    const content = local.text ? (html.latest ?? html() ?? "") : ""
    if (!container) return
    if (isServer) return

    if (!content) {
      container.innerHTML = ""
      return
    }

    const labels = {
      copy: i18n.t("ui.message.copy"),
      copied: i18n.t("ui.message.copied"),
    }
    const temp = document.createElement("div")
    temp.innerHTML = content
    decorate(temp, labels)

    morphdom(container, temp, {
      childrenOnly: true,
      onBeforeElUpdated: (fromEl, toEl) => {
        if (fromEl instanceof HTMLElement && fromEl.dataset.mermaidRendered) {
          return false
        }
        if (
          fromEl instanceof HTMLButtonElement &&
          toEl instanceof HTMLButtonElement &&
          fromEl.getAttribute("data-slot") === "markdown-copy-button" &&
          toEl.getAttribute("data-slot") === "markdown-copy-button" &&
          fromEl.getAttribute("data-copied") === "true"
        ) {
          setCopyState(toEl, labels, true)
        }
        if (fromEl.isEqualNode(toEl)) return false
        return true
      },
    })

    if (!copyCleanup)
      copyCleanup = setupCodeCopy(container, () => ({
        copy: i18n.t("ui.message.copy"),
        copied: i18n.t("ui.message.copied"),
      }))

    for (const pre of container.querySelectorAll<HTMLPreElement>("pre")) {
      if (pre.dataset.mermaidRendered) continue
      const codeEl = pre.querySelector("code")
      if (!codeEl) continue
      const code = codeEl.textContent ?? ""
      if (!code || !isMermaid(code)) continue

      pre.dataset.mermaidRendered = "pending"
      renderMermaid(code).then((svg) => {
        pre.innerHTML = ""
        pre.dataset.mermaidRendered = "done"
        pre.appendChild(createMermaidContainer(svg))
      }).catch(() => {
        pre.dataset.mermaidRendered = "error"
      })
    }
  })

  onCleanup(() => {
    if (copyCleanup) copyCleanup()
  })

  return (
    <div
      data-component="markdown"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      ref={setRoot}
      {...others}
    />
  )
}
