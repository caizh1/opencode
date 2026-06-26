export const ANSI_RESET = "\x1b[0m"
export const ANSI_BOLD = "\x1b[1m"
export const ANSI_DIM = "\x1b[2m"
export const ANSI_CYAN = "\x1b[36m"
export const ANSI_GREEN = "\x1b[32m"
export const ANSI_YELLOW = "\x1b[33m"
export const ANSI_RED = "\x1b[31m"

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g
const MIN_BOX_WIDTH = 44
const DEFAULT_BOX_WIDTH = 84
const MAX_BOX_WIDTH = 110

export type TerminalBoxTone = "info" | "success" | "warning" | "danger" | "muted"

export type TerminalBoxSection = {
  label?: string
  body?: string | string[]
  bodyStyle?: string[]
}

export type TerminalBoxInput = {
  title: string
  tone?: TerminalBoxTone
  sections?: TerminalBoxSection[]
  footer?: string | string[]
  columns?: number
  width?: number
}

export function renderTerminalBox(input: TerminalBoxInput) {
  const totalWidth = normalizeBoxWidth(input.width ?? terminalBoxWidth(input.columns))
  const contentWidth = Math.max(20, totalWidth - 4)
  const title = truncatePlain(input.title.trim(), Math.max(8, contentWidth - 2))
  const titleAnsi = toneAnsi(input.tone ?? "info")
  const titleText = title ? styled(title, ANSI_BOLD, titleAnsi) : ""
  const lines: string[] = []

  lines.push(topBorder(titleText, title, contentWidth))
  const sections = input.sections ?? []
  sections.forEach((section, index) => {
    if (index > 0) lines.push(boxLine("", contentWidth))
    if (section.label) lines.push(boxLine(styled(section.label, ANSI_BOLD), contentWidth))
    for (const rawLine of sectionBodyLines(section.body)) {
      const wrapped = wrapTerminalText(rawLine, contentWidth)
      for (const line of wrapped.length ? wrapped : [""]) {
        const content = section.bodyStyle?.length ? styled(line, ...section.bodyStyle) : line
        lines.push(boxLine(content, contentWidth))
      }
    }
  })

  const footerLines = sectionBodyLines(input.footer)
  if (footerLines.length) {
    if (sections.length) lines.push(boxLine("", contentWidth))
    for (const rawLine of footerLines) {
      for (const line of wrapTerminalText(rawLine, contentWidth)) {
        lines.push(boxLine(styled(line, ANSI_BOLD), contentWidth))
      }
    }
  }

  lines.push(bottomBorder(contentWidth))
  return lines.join("\n")
}

export function terminalBoxWidth(columns?: number) {
  if (!Number.isFinite(columns) || !columns || columns < MIN_BOX_WIDTH) return DEFAULT_BOX_WIDTH
  return normalizeBoxWidth(Math.floor(columns) - 2)
}

export function styled(text: string, ...codes: string[]) {
  const active = codes.filter(Boolean)
  if (active.length === 0) return text
  return `${active.join("")}${text}${ANSI_RESET}`
}

export function stripAnsi(text: string) {
  return text.replace(ANSI_PATTERN, "")
}

export function visibleWidth(text: string) {
  let width = 0
  for (const char of stripAnsi(text)) {
    const codePoint = char.codePointAt(0) ?? 0
    width += codePointWidth(codePoint)
  }
  return width
}

export function wrapTerminalText(text: string, width: number) {
  const targetWidth = Math.max(1, width)
  const result: string[] = []
  for (const paragraph of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (!paragraph) {
      result.push("")
      continue
    }
    let line = ""
    let lineWidth = 0
    for (let index = 0; index < paragraph.length;) {
      const ansi = ansiSequenceAt(paragraph, index)
      if (ansi) {
        line += ansi
        index += ansi.length
        continue
      }

      const codePoint = paragraph.codePointAt(index) ?? 0
      const char = String.fromCodePoint(codePoint)
      const charWidth = codePointWidth(codePoint)
      if (lineWidth > 0 && lineWidth + charWidth > targetWidth) {
        result.push(line)
        line = ""
        lineWidth = 0
      }
      line += char
      lineWidth += charWidth
      index += char.length
    }
    result.push(line)
  }
  return result
}

export function toneAnsi(tone: TerminalBoxTone) {
  if (tone === "danger") return ANSI_RED
  if (tone === "warning") return ANSI_YELLOW
  if (tone === "success") return ANSI_GREEN
  if (tone === "muted") return ANSI_DIM
  return ANSI_CYAN
}

function normalizeBoxWidth(width: number) {
  if (!Number.isFinite(width)) return DEFAULT_BOX_WIDTH
  return Math.max(MIN_BOX_WIDTH, Math.min(MAX_BOX_WIDTH, Math.floor(width)))
}

function topBorder(styledTitle: string, plainTitle: string, contentWidth: number) {
  if (!plainTitle) return `╭${"─".repeat(contentWidth + 2)}╮`
  const titleWidth = visibleWidth(plainTitle)
  const fillWidth = Math.max(1, contentWidth + 2 - titleWidth - 3)
  return `╭─ ${styledTitle} ${"─".repeat(fillWidth)}╮`
}

function bottomBorder(contentWidth: number) {
  return `╰${"─".repeat(contentWidth + 2)}╯`
}

function boxLine(content: string, width: number) {
  const normalized = `${content}${ANSI_RESET}`
  return `│ ${normalized}${" ".repeat(Math.max(0, width - visibleWidth(normalized)))} │`
}

function sectionBodyLines(body: string | string[] | undefined) {
  if (body === undefined) return []
  if (Array.isArray(body)) return body
  return body.split(/\r\n|\r|\n/)
}

function truncatePlain(text: string, maxWidth: number) {
  if (visibleWidth(text) <= maxWidth) return text
  let result = ""
  let width = 0
  for (const char of text) {
    const next = codePointWidth(char.codePointAt(0) ?? 0)
    if (width + next > Math.max(1, maxWidth - 1)) break
    result += char
    width += next
  }
  return `${result}…`
}

function ansiSequenceAt(text: string, index: number) {
  if (text.charCodeAt(index) !== 0x1b) return undefined
  ANSI_PATTERN.lastIndex = index
  const match = ANSI_PATTERN.exec(text)
  if (!match || match.index !== index) return undefined
  return match[0]
}

function codePointWidth(codePoint: number) {
  if (codePoint === 0) return 0
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0
  if (isCombiningCodePoint(codePoint)) return 0
  return isWideCodePoint(codePoint) ? 2 : 1
}

function isCombiningCodePoint(codePoint: number) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  )
}

function isWideCodePoint(codePoint: number) {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  )
}
