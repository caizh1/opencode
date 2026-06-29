import type { OoxmlPartPatchSpec } from "./types"

const MAX_PATCH_TEXT_LENGTH = 20_000
const MAX_INITIAL_XML_LENGTH = 120_000
const MAX_EXPECTED_OCCURRENCES = 20

export function normalizeOoxmlPackagePart(input: unknown) {
  if (typeof input !== "string") return undefined
  const part = input.trim().replace(/^\/+/, "")
  if (!part || part.includes("\\") || part.includes("\0") || part.includes("//")) return undefined
  if (part.split("/").some((segment) => !segment || segment === "." || segment === "..")) return undefined
  if (part === "[Content_Types].xml" || part === "_rels/.rels") return part
  if (/^docProps\/[A-Za-z0-9_.-]+\.xml$/.test(part)) return part
  if (/^word\/[A-Za-z0-9_.-]+\.xml$/.test(part)) return part
  if (/^word\/theme\/[A-Za-z0-9_.-]+\.xml$/.test(part)) return part
  if (/^word\/_rels\/[A-Za-z0-9_.-]+\.xml\.rels$/.test(part)) return part
  return undefined
}

export function normalizeOoxmlPartPatches(input: unknown): OoxmlPartPatchSpec[] | undefined {
  if (!Array.isArray(input)) return undefined
  const patches = input.map(normalizeOoxmlPartPatch).filter((item): item is OoxmlPartPatchSpec => Boolean(item))
  return patches.length ? patches : undefined
}

function normalizeOoxmlPartPatch(input: unknown): OoxmlPartPatchSpec | undefined {
  if (!input || typeof input !== "object") return undefined
  const raw = input as Record<string, unknown>
  const action = raw.action
  const expectedOccurrences = normalizeExpectedOccurrences(raw.expectedOccurrences)
  if (action === "replace") {
    return {
      action,
      oldText: stringValue(raw.oldText).slice(0, MAX_PATCH_TEXT_LENGTH),
      newText: stringValue(raw.newText).slice(0, MAX_PATCH_TEXT_LENGTH),
      expectedOccurrences,
    }
  }
  if (action === "insertBefore" || action === "insertAfter") {
    return {
      action,
      anchor: stringValue(raw.anchor).slice(0, MAX_PATCH_TEXT_LENGTH),
      text: stringValue(raw.text ?? raw.newText).slice(0, MAX_PATCH_TEXT_LENGTH),
      expectedOccurrences,
    }
  }
  if (action === "appendBeforeClose") {
    return {
      action,
      closeTag: stringValue(raw.closeTag ?? raw.anchor).slice(0, 200),
      text: stringValue(raw.text ?? raw.newText).slice(0, MAX_PATCH_TEXT_LENGTH),
      expectedOccurrences,
    }
  }
  return undefined
}

function normalizeExpectedOccurrences(input: unknown) {
  if (input === undefined || input === null || input === "") return 1
  const value = Number(input)
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(MAX_EXPECTED_OCCURRENCES, Math.round(value)))
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input : String(input ?? "")
}

export function validateOoxmlPatchPlan(input: {
  part: unknown
  patches: unknown
  locatorKind?: string
  reason?: unknown
  createIfMissing?: unknown
  initialXml?: unknown
  prefix: string
}) {
  const errors: string[] = []
  const part = normalizeOoxmlPackagePart(input.part)
  if (!part) errors.push(`${input.prefix}.part must be a safe XML OOXML package part such as word/document.xml, word/settings.xml, word/_rels/document.xml.rels, or [Content_Types].xml.`)
  if (input.locatorKind !== "documentEnd") errors.push(`${input.prefix}.locator must be documentEnd for patchOoxmlPart.`)
  const reason = typeof input.reason === "string" ? input.reason.trim() : ""
  if (!reason) errors.push(`${input.prefix}.reason is required for patchOoxmlPart.`)
  if (reason.length > 300) errors.push(`${input.prefix}.reason exceeds 300 characters.`)
  const patches = normalizeOoxmlPartPatches(input.patches)
  if (!patches?.length) errors.push(`${input.prefix}.patches must contain at least one patch.`)
  if (patches && patches.length > 12) errors.push(`${input.prefix}.patches exceeds 12 items.`)
  patches?.forEach((patch, index) => validatePatchSpec(patch, `${input.prefix}.patches[${index}]`, errors))
  if (input.createIfMissing !== undefined && typeof input.createIfMissing !== "boolean") errors.push(`${input.prefix}.createIfMissing must be boolean when provided.`)
  if (input.createIfMissing === true) {
    const initialXml = typeof input.initialXml === "string" ? input.initialXml : ""
    if (!initialXml.trim()) errors.push(`${input.prefix}.initialXml is required when createIfMissing is true.`)
    if (initialXml.length > MAX_INITIAL_XML_LENGTH) errors.push(`${input.prefix}.initialXml exceeds ${MAX_INITIAL_XML_LENGTH} characters.`)
    if (part && initialXml) errors.push(...validateOoxmlXmlSafety(part, initialXml, `${input.prefix}.initialXml`))
  }
  return errors
}

function validatePatchSpec(patch: OoxmlPartPatchSpec, prefix: string, errors: string[]) {
  if (!Number.isInteger(patch.expectedOccurrences) || (patch.expectedOccurrences ?? 1) < 1 || (patch.expectedOccurrences ?? 1) > MAX_EXPECTED_OCCURRENCES) {
    errors.push(`${prefix}.expectedOccurrences must be an integer between 1 and ${MAX_EXPECTED_OCCURRENCES}.`)
  }
  if (patch.action === "replace") {
    validateSnippet(patch.oldText, `${prefix}.oldText`, errors, { allowEmpty: false })
    validateSnippet(patch.newText, `${prefix}.newText`, errors, { allowEmpty: true })
    return
  }
  if (patch.action === "insertBefore" || patch.action === "insertAfter") {
    validateSnippet(patch.anchor, `${prefix}.anchor`, errors, { allowEmpty: false })
    validateSnippet(patch.text, `${prefix}.text`, errors, { allowEmpty: false })
    return
  }
  if (patch.action === "appendBeforeClose") {
    validateSnippet(patch.closeTag, `${prefix}.closeTag`, errors, { allowEmpty: false, maxLength: 200 })
    validateSnippet(patch.text, `${prefix}.text`, errors, { allowEmpty: false })
  }
}

function validateSnippet(value: string, field: string, errors: string[], options: { allowEmpty: boolean; maxLength?: number }) {
  const maxLength = options.maxLength ?? MAX_PATCH_TEXT_LENGTH
  if (!options.allowEmpty && !value) errors.push(`${field} is required.`)
  if (value.length > maxLength) errors.push(`${field} exceeds ${maxLength} characters.`)
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value)) errors.push(`${field} contains unsupported control characters.`)
  const blocked = blockedOoxmlSnippetReason(value)
  if (blocked) errors.push(`${field} contains unsupported OOXML patch content: ${blocked}.`)
}

export function applyOoxmlPartPatches(part: string, xml: string, patches: OoxmlPartPatchSpec[]) {
  let nextXml = xml
  const details: string[] = []
  for (const [index, patch] of patches.entries()) {
    const expected = patch.expectedOccurrences ?? 1
    if (patch.action === "replace") {
      assertPatchTextSafe(patch.newText, `patches[${index}].newText`)
      const count = countOccurrences(nextXml, patch.oldText)
      if (count !== expected) throw new Error(`patchOoxmlPart ${part} patches[${index}] expected ${expected} occurrence(s) of oldText but found ${count}.`)
      nextXml = nextXml.split(patch.oldText).join(patch.newText)
      details.push(`replace:${count}`)
      continue
    }
    if (patch.action === "insertBefore" || patch.action === "insertAfter") {
      assertPatchTextSafe(patch.text, `patches[${index}].text`)
      const count = countOccurrences(nextXml, patch.anchor)
      if (count !== expected) throw new Error(`patchOoxmlPart ${part} patches[${index}] expected ${expected} occurrence(s) of anchor but found ${count}.`)
      const replacement = patch.action === "insertBefore" ? `${patch.text}${patch.anchor}` : `${patch.anchor}${patch.text}`
      nextXml = nextXml.split(patch.anchor).join(replacement)
      details.push(`${patch.action}:${count}`)
      continue
    }
    if (patch.action === "appendBeforeClose") {
      assertPatchTextSafe(patch.text, `patches[${index}].text`)
      const count = countOccurrences(nextXml, patch.closeTag)
      if (count !== expected) throw new Error(`patchOoxmlPart ${part} patches[${index}] expected ${expected} occurrence(s) of closeTag but found ${count}.`)
      nextXml = nextXml.split(patch.closeTag).join(`${patch.text}${patch.closeTag}`)
      details.push(`appendBeforeClose:${count}`)
    }
  }
  const safetyErrors = validateOoxmlXmlSafety(part, nextXml, `patchOoxmlPart(${part})`)
  if (safetyErrors.length) throw new Error(safetyErrors.join("; "))
  return {
    xml: nextXml,
    details,
    byteDelta: Buffer.byteLength(nextXml, "utf8") - Buffer.byteLength(xml, "utf8"),
  }
}

function assertPatchTextSafe(value: string, field: string) {
  const reason = blockedOoxmlSnippetReason(value)
  if (reason) throw new Error(`${field} contains unsupported OOXML patch content: ${reason}.`)
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value)) throw new Error(`${field} contains unsupported control characters.`)
}

function blockedOoxmlSnippetReason(value: string) {
  if (/<!DOCTYPE\b/i.test(value)) return "DOCTYPE declarations are not allowed"
  if (/<!ENTITY\b/i.test(value)) return "ENTITY declarations are not allowed"
  if (/<\?xml-stylesheet\b/i.test(value)) return "xml-stylesheet processing instructions are not allowed"
  if (/\bTargetMode\s*=\s*["']External["']/i.test(value)) return "external relationships must use native hyperlink/image tools"
  if (/vbaProject|activeX|oleObject|\/?embeddings\/|relationships\/oleObject|relationships\/vbaProject/i.test(value)) return "macro, ActiveX, OLE, and embedding relationships are not allowed"
  return undefined
}

export function validateOoxmlXmlSafety(part: string, xml: string, field: string) {
  const errors: string[] = []
  if (!xml.trim()) errors.push(`${field} must not be empty.`)
  if (xml.length > MAX_INITIAL_XML_LENGTH * 2) errors.push(`${field} exceeds ${MAX_INITIAL_XML_LENGTH * 2} characters.`)
  const blocked = blockedOoxmlSnippetReason(xml)
  if (blocked) errors.push(`${field} contains unsupported OOXML content: ${blocked}.`)
  if (part === "[Content_Types].xml" && !/<Types\b/.test(xml)) errors.push(`${field} must contain a Types root for [Content_Types].xml.`)
  if (part.endsWith(".rels") && !/<Relationships\b/.test(xml)) errors.push(`${field} must contain a Relationships root for .rels parts.`)
  if (part === "word/document.xml" && !/<w:document\b/.test(xml)) errors.push(`${field} must contain a w:document root.`)
  const xmlError = wellFormedXmlLikeError(xml)
  if (xmlError) errors.push(`${field} is not well-formed XML: ${xmlError}`)
  return errors
}

function wellFormedXmlLikeError(xml: string) {
  const withoutIgnored = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
  const stack: string[] = []
  const tagPattern = /<\/?([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s[^<>]*)?\/?>/g
  let sawTag = false
  for (const match of withoutIgnored.matchAll(tagPattern)) {
    sawTag = true
    const tag = match[0]
    const name = match[1] ?? ""
    if (tag.startsWith("</")) {
      const previous = stack.pop()
      if (previous !== name) return `closing tag ${name} does not match ${previous ?? "empty stack"}`
    } else if (!tag.endsWith("/>")) {
      stack.push(name)
    }
  }
  if (!sawTag) return "no XML tags found"
  if (stack.length) return `unclosed tag ${stack[stack.length - 1]}`
  return undefined
}

function countOccurrences(input: string, needle: string) {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while (true) {
    const index = input.indexOf(needle, offset)
    if (index < 0) return count
    count += 1
    offset = index + needle.length
  }
}
