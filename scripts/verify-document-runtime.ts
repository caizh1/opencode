import { existsSync, readFileSync } from "node:fs"

const vsixPath = process.argv[2]
if (!vsixPath) {
  console.error("Usage: bun scripts/verify-document-runtime.ts <chipmate.vsix>")
  process.exit(2)
}
if (!existsSync(vsixPath)) {
  console.error(`VSIX not found: ${vsixPath}`)
  process.exit(2)
}

const entries = listZipEntries(readFileSync(vsixPath))
const required = [
  "extension/dist/document-parser.js",
  "extension/dist/context.js",
  "extension/dist/tool-runtime.js",
  "extension/node_modules/mammoth/package.json",
  "extension/node_modules/node-html-parser/package.json",
  "extension/node_modules/exceljs/package.json",
  "extension/node_modules/pdfjs-dist/package.json",
]
const missing = required.filter((entry) => !entries.has(entry))
if (missing.length > 0) {
  console.error(`Document runtime verification failed: missing ${missing.join(", ")}`)
  process.exit(1)
}

console.log(`Document runtime OK: ${vsixPath}`)
console.log(`Verified ${required.join(", ")}.`)

function listZipEntries(buffer: Buffer) {
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error("Invalid VSIX: ZIP end-of-central-directory not found.")
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  const entries = new Set<string>()
  let offset = centralOffset
  for (let index = 0; index < entryCount; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    entries.add(buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function findEocd(buffer: Buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22)
  for (let index = buffer.length - 22; index >= min; index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index
  }
  return -1
}
