import { checksum } from "@opencode-ai/core/util/encode"

let id = 0
let initialized = false

const cache = new Map<string, string>()

export function renderMermaid(code: string): Promise<string> {
  const hash = checksum(code) ?? code
  const cached = cache.get(hash)
  if (cached) return Promise.resolve(cached)

  return initMermaid().then(() => {
    const uid = `mermaid-${++id}-${Date.now()}`
    return import("mermaid").then((m) =>
      m.default.render(uid, code).then((out) => {
        const svg = out.svg
        cache.set(hash, svg)
        return svg
      }),
    )
  })
}

function initMermaid(): Promise<void> {
  if (initialized) return Promise.resolve()
  initialized = true
  return import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
    })
  })
}

export function hashCode(code: string): string {
  return checksum(code) ?? code
}

export function isMermaid(text: string): boolean {
  const t = text.trim()
  return /^(graph\s+|flowchart\s+|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie\s+|journey\s+|gitgraph|timeline|mindmap|packet|quadrantChart|requirementDiagram|sankey|xychart)/i.test(t)
}
