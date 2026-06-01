import { describe, expect, test } from "bun:test"
import {
  createTextFragment,
  getCursorPosition,
  getNodeLength,
  getTextLength,
  setCursorPosition,
  setCursorPositionFromPoint,
} from "./editor-dom"

type TestCaretPosition = {
  offsetNode: Node
  offset: number
  getClientRect: () => DOMRect
}

type PointCaretOverrides = {
  caretPositionFromPoint?: (x: number, y: number) => TestCaretPosition | null
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

function overrideDocumentPointCaret(overrides: PointCaretOverrides) {
  const caretPosition = Object.getOwnPropertyDescriptor(document, "caretPositionFromPoint")
  const caretRange = Object.getOwnPropertyDescriptor(document, "caretRangeFromPoint")
  Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: overrides.caretPositionFromPoint })
  Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: overrides.caretRangeFromPoint })

  return () => {
    if (caretPosition) Object.defineProperty(document, "caretPositionFromPoint", caretPosition)
    else delete (document as PointCaretOverrides).caretPositionFromPoint

    if (caretRange) Object.defineProperty(document, "caretRangeFromPoint", caretRange)
    else delete (document as PointCaretOverrides).caretRangeFromPoint
  }
}

describe("prompt-input editor dom", () => {
  test("createTextFragment preserves newlines with consecutive br nodes", () => {
    const fragment = createTextFragment("foo\n\nbar")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(4)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
    expect((container.childNodes[2] as HTMLElement).tagName).toBe("BR")
    expect(container.childNodes[3]?.textContent).toBe("bar")
  })

  test("createTextFragment keeps trailing newline as terminal break", () => {
    const fragment = createTextFragment("foo\n")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("createTextFragment avoids break-node explosion for large multiline content", () => {
    const content = Array.from({ length: 220 }, () => "line").join("\n")
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(1)
    expect(container.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE)
    expect(container.textContent).toBe(content)
  })

  test("createTextFragment keeps terminal break in large multiline fallback", () => {
    const content = `${Array.from({ length: 220 }, () => "line").join("\n")}\n`
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe(content.slice(0, -1))
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("length helpers treat breaks as one char and ignore zero-width chars", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("ab\u200B"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))

    expect(getNodeLength(container.childNodes[0]!)).toBe(2)
    expect(getNodeLength(container.childNodes[1]!)).toBe(1)
    expect(getTextLength(container)).toBe(5)
  })

  test("setCursorPosition and getCursorPosition round-trip with pills and breaks", () => {
    const container = document.createElement("div")
    const pill = document.createElement("span")
    pill.dataset.type = "file"
    pill.textContent = "@file"
    container.appendChild(document.createTextNode("ab"))
    container.appendChild(pill)
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 7)
    expect(getCursorPosition(container)).toBe(7)

    setCursorPosition(container, 8)
    expect(getCursorPosition(container)).toBe(8)

    container.remove()
  })

  test("setCursorPosition and getCursorPosition round-trip across blank lines", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("a"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("b"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 3)
    expect(getCursorPosition(container)).toBe(3)

    container.remove()
  })

  test("setCursorPositionFromPoint uses caretPositionFromPoint inside editor", () => {
    const container = document.createElement("div")
    const text = document.createTextNode("abcd")
    container.appendChild(text)
    document.body.appendChild(container)

    const restore = overrideDocumentPointCaret({
      caretPositionFromPoint: () => ({ offsetNode: text, offset: 2, getClientRect: () => new DOMRect() }),
      caretRangeFromPoint: () => {
        throw new Error("caretRangeFromPoint should not be used")
      },
    })

    try {
      expect(setCursorPositionFromPoint(container, 10, 20)).toBe(true)
      expect(getCursorPosition(container)).toBe(2)
    } finally {
      restore()
      container.remove()
    }
  })

  test("setCursorPositionFromPoint falls back to caretRangeFromPoint", () => {
    const container = document.createElement("div")
    const text = document.createTextNode("abcd")
    container.appendChild(text)
    document.body.appendChild(container)

    const restore = overrideDocumentPointCaret({
      caretRangeFromPoint: () => {
        const range = document.createRange()
        range.setStart(text, 3)
        return range
      },
    })

    try {
      expect(setCursorPositionFromPoint(container, 10, 20)).toBe(true)
      expect(getCursorPosition(container)).toBe(3)
    } finally {
      restore()
      container.remove()
    }
  })

  test("setCursorPositionFromPoint rejects ranges outside editor", () => {
    const container = document.createElement("div")
    const text = document.createTextNode("abcd")
    const outside = document.createTextNode("outside")
    container.appendChild(text)
    document.body.append(container, outside)
    setCursorPosition(container, 1)

    const restore = overrideDocumentPointCaret({
      caretPositionFromPoint: () => ({ offsetNode: outside, offset: 2, getClientRect: () => new DOMRect() }),
    })

    try {
      expect(setCursorPositionFromPoint(container, 10, 20)).toBe(false)
      expect(getCursorPosition(container)).toBe(1)
    } finally {
      restore()
      outside.remove()
      container.remove()
    }
  })
})
