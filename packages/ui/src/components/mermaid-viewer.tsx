import { createEffect, createMemo, createResource, createSignal, Match, Switch, type JSX } from "solid-js"
import { renderMermaid } from "./mermaid-renderer"

const ZOOM_MIN = 0.1
const ZOOM_MAX = 5

export function clampZoomScale(value: number) {
  if (!Number.isFinite(value)) return 1
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value))
}

export function nextZoomScale(current: number, delta: number) {
  return clampZoomScale(Math.round((current + delta) * 10) / 10)
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

function attrNumber(el: Element, name: string) {
  const value = el.getAttribute(name)
  if (!value) return 0
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function svgNaturalSize(svgEl: SVGSVGElement) {
  const vb = svgEl.getAttribute("viewBox")
  if (vb) {
    const parts = vb.split(/\s+/)
    if (parts.length === 4) {
      return {
        width: Number.parseFloat(parts[2]!) || 0,
        height: Number.parseFloat(parts[3]!) || 0,
      }
    }
  }

  return {
    width: attrNumber(svgEl, "width"),
    height: attrNumber(svgEl, "height"),
  }
}

export function createZoomableMediaContainer(input: {
  content: HTMLElement
  target: HTMLElement | SVGElement
  component?: string
  naturalWidth?: number
  naturalHeight?: number
}): { element: HTMLElement; setNaturalSize: (width: number, height: number) => void } {
  const wrapper = document.createElement("div")
  wrapper.setAttribute("data-component", input.component ?? "zoomable-media-preview")

  const viewport = document.createElement("div")
  viewport.setAttribute("data-slot", "mermaid-viewport")

  const content = input.content
  content.setAttribute("data-slot", "mermaid-content")
  content.dataset.scale = "1"

  const target = input.target
  target.style.display = "block"
  target.style.maxWidth = "none"
  target.style.maxHeight = "none"

  const controls = document.createElement("div")
  controls.setAttribute("data-slot", "mermaid-controls")

  const applyScale = () => {
    const scale = parseFloat(content.dataset.scale || "1")
    const w = content.dataset.vbW
    const h = content.dataset.vbH
    if (!w || !h) return
    target.style.width = parseFloat(w) * scale + "px"
    target.style.height = parseFloat(h) * scale + "px"
  }

  const setNaturalSize = (width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    if (width <= 0 || height <= 0) return

    content.dataset.vbW = String(width)
    content.dataset.vbH = String(height)
    viewport.style.height = Math.min(height, 600) + "px"
    viewport.style.maxWidth = "100%"
    applyScale()
  }

  const setScale = (s: number) => {
    content.dataset.scale = String(clampZoomScale(s))
    applyScale()
  }

  const adjustZoom = (delta: number) => {
    const cur = parseFloat(content.dataset.scale || "1")
    setScale(nextZoomScale(cur, delta))
  }

  controls.appendChild(createZoomButton("\u2212", () => adjustZoom(-0.2)))
  controls.appendChild(createZoomButton("1:1", () => setScale(1)))
  controls.appendChild(createZoomButton("+", () => adjustZoom(0.2)))

  const zoomIcon = document.createElement("div")
  zoomIcon.setAttribute("data-slot", "mermaid-zoom-icon")
  zoomIcon.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="M12.5 12.5l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8.5 6v5M6 8.5h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
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

  viewport.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      adjustZoom(e.deltaY > 0 ? -0.1 : 0.1)
    },
    { passive: false },
  )

  viewport.appendChild(content)
  wrapper.appendChild(viewport)
  wrapper.appendChild(controls)

  setNaturalSize(input.naturalWidth ?? 0, input.naturalHeight ?? 0)
  applyScale()

  return { element: wrapper, setNaturalSize }
}

export function createMermaidContainer(svg: string): HTMLElement {
  const content = document.createElement("div")
  content.innerHTML = svg

  const svgEl = content.querySelector<SVGSVGElement>("svg")
  if (!svgEl) {
    return createZoomableMediaContainer({
      content,
      target: content,
      component: "mermaid-diagram",
    }).element
  }

  const size = svgNaturalSize(svgEl)
  return createZoomableMediaContainer({
    content,
    target: svgEl,
    component: "mermaid-diagram",
    naturalWidth: size.width,
    naturalHeight: size.height,
  }).element
}

export function createZoomableImageContainer(input: {
  src: string
  alt?: string
  naturalWidth?: number
  naturalHeight?: number
  onLoad?: () => void
}): HTMLElement {
  const content = document.createElement("div")
  const image = document.createElement("img")
  image.alt = input.alt ?? ""
  content.appendChild(image)

  const container = createZoomableMediaContainer({
    content,
    target: image,
    component: "zoomable-media-preview",
    naturalWidth: input.naturalWidth,
    naturalHeight: input.naturalHeight,
  })

  let loaded = false
  const handleLoad = () => {
    if (loaded) return
    loaded = true
    if (!input.naturalWidth || !input.naturalHeight) {
      container.setNaturalSize(image.naturalWidth, image.naturalHeight)
    }
    input.onLoad?.()
  }

  image.addEventListener("load", handleLoad)
  image.src = input.src
  if (image.complete && (input.naturalWidth || image.naturalWidth) && (input.naturalHeight || image.naturalHeight)) {
    handleLoad()
  }

  return container.element
}

export function renderMermaidSource(code: string, render = renderMermaid) {
  const source = code.trim()
  if (!source) return Promise.reject(new Error("Missing Mermaid source"))
  return render(source)
}

export function MermaidPreview(props: {
  code: string
  class?: string
  loading?: JSX.Element
  fallback?: (error?: unknown) => JSX.Element
  onLoad?: () => void
  render?: (code: string) => Promise<string>
}) {
  const source = createMemo(() => props.code.trim())
  const [svg] = createResource(source, (code) => renderMermaidSource(code, props.render))
  const [root, setRoot] = createSignal<HTMLDivElement>()

  createEffect(() => {
    const el = root()
    const value = svg()
    if (!el || !value) return
    el.replaceChildren(createMermaidContainer(value))
    props.onLoad?.()
  })

  const fallback = () => props.fallback?.(svg.error)

  return (
    <Switch>
      <Match when={!source()}>{fallback()}</Match>
      <Match when={svg.error}>{fallback()}</Match>
      <Match when={svg.loading}>{props.loading}</Match>
      <Match when={true}>
        <div data-component="mermaid-preview" class={props.class} ref={setRoot} />
      </Match>
    </Switch>
  )
}

export function ZoomableMediaPreview(props: {
  src: string
  alt?: string
  naturalWidth?: number
  naturalHeight?: number
  class?: string
  onLoad?: () => void
}) {
  const [root, setRoot] = createSignal<HTMLDivElement>()

  createEffect(() => {
    const el = root()
    if (!el || typeof document === "undefined") return
    el.replaceChildren(
      createZoomableImageContainer({
        src: props.src,
        alt: props.alt,
        naturalWidth: props.naturalWidth,
        naturalHeight: props.naturalHeight,
        onLoad: props.onLoad,
      }),
    )
  })

  return <div data-component="zoomable-media-preview-host" class={props.class} ref={setRoot} />
}
