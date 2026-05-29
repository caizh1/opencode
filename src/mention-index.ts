export type MentionEntryType = "file" | "folder"

export type MentionSourceFile = {
  uri: string
  label: string
}

export type MentionIndexEntry = {
  type: MentionEntryType
  uri?: string
  label: string
  insertText: string
  normalized: string
  basename: string
  parent: string
  depth: number
  segments: string[]
}

export type MentionSearchResult = {
  type: MentionEntryType
  uri?: string
  label: string
  insertText: string
}

const MAX_SCORE = 100000

export function buildMentionIndex(files: MentionSourceFile[]) {
  const folderLabels = new Set<string>()
  const fileEntries: MentionIndexEntry[] = []

  for (const file of files) {
    const label = cleanPath(file.label)
    if (!label) continue

    const segments = label.split("/").filter(Boolean)
    if (segments.length === 0) continue

    for (let index = 1; index < segments.length; index++) {
      folderLabels.add(segments.slice(0, index).join("/"))
    }

    fileEntries.push(entryFor("file", label, file.uri))
  }

  const folderEntries = [...folderLabels].map((label) => entryFor("folder", label))
  return [...folderEntries, ...fileEntries]
}

export function searchMentionIndex(entries: MentionIndexEntry[], query: string, limit = 50): MentionSearchResult[] {
  const normalized = normalizeMentionQuery(query)
  const wantsChildren = hasTrailingSlash(query)
  const scored = entries
    .map((entry) => ({ entry, score: mentionScore(entry, normalized, wantsChildren) }))
    .filter((item) => item.score < MAX_SCORE)
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score
      if (left.entry.type !== right.entry.type) return left.entry.type === "folder" ? -1 : 1
      return left.entry.label.localeCompare(right.entry.label)
    })
    .slice(0, limit)

  return scored.map(({ entry }) => ({
    type: entry.type,
    uri: entry.uri,
    label: entry.label,
    insertText: entry.insertText,
  }))
}

export function normalizeMentionQuery(input: string) {
  return cleanPath(input.replace(/^@+/, "")).toLowerCase()
}

function entryFor(type: MentionEntryType, label: string, uri?: string): MentionIndexEntry {
  const normalized = label.toLowerCase()
  const segments = normalized.split("/").filter(Boolean)
  const basename = segments[segments.length - 1] ?? normalized
  const parent = segments.slice(0, -1).join("/")
  return {
    type,
    uri,
    label,
    insertText: type === "folder" ? `${label}/` : label,
    normalized,
    basename,
    parent,
    depth: segments.length,
    segments,
  }
}

function mentionScore(entry: MentionIndexEntry, query: string, wantsChildren: boolean) {
  if (!query) return entry.type === "folder" ? entry.depth * 5 + entry.label.length : 1000 + entry.label.length

  const baseQuery = query.replace(/\/+$/, "")
  if (!baseQuery) return entry.type === "folder" ? entry.depth * 5 + entry.label.length : 1000 + entry.label.length

  if (wantsChildren && entry.parent === baseQuery) {
    return entry.type === "folder" ? 0 + entry.label.length / 1000 : 40 + entry.label.length / 1000
  }

  if (entry.normalized === baseQuery || entry.basename === baseQuery) return 1
  if (entry.normalized.startsWith(`${baseQuery}/`)) {
    return entry.type === "folder" ? 10 + entry.depth : 30 + entry.depth
  }
  if (entry.normalized.startsWith(baseQuery)) return 70 + entry.depth
  if (!baseQuery.includes("/") && entry.basename.startsWith(baseQuery)) return 90 + entry.depth

  const segmented = segmentScore(entry.segments, baseQuery.split("/").filter(Boolean))
  if (segmented < MAX_SCORE) return 200 + segmented

  const index = entry.normalized.indexOf(baseQuery)
  if (index !== -1) return 500 + index
  return MAX_SCORE
}

function segmentScore(segments: string[], querySegments: string[]) {
  if (querySegments.length === 0) return 0
  let position = 0
  let score = 0

  for (const query of querySegments) {
    let found = -1
    for (let index = position; index < segments.length; index++) {
      if (segments[index].startsWith(query)) {
        found = index
        score += (index - position) * 20
        break
      }
      const containsAt = segments[index].indexOf(query)
      if (containsAt !== -1 && found === -1) {
        found = index
        score += (index - position) * 20 + 8 + containsAt
        break
      }
    }
    if (found === -1) return MAX_SCORE
    position = found + 1
  }

  return score + segments.length
}

function cleanPath(input: string) {
  return input
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
}

function hasTrailingSlash(input: string) {
  return /[\\/]$/.test(input.trim())
}
