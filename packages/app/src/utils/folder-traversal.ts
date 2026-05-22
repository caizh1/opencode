async function readAllEntries(reader: any): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const all: any[] = []
    const read = () => {
      reader.readEntries((entries: any[]) => {
        if (entries.length === 0) {
          resolve(all)
          return
        }
        all.push(...entries)
        read()
      }, reject)
    }
    read()
  })
}

export async function getFilesFromEntry(entry: any, basePath = ""): Promise<File[]> {
  if (entry.isFile) {
    const file: File = await new Promise((resolve, reject) => {
      entry.file(resolve, reject)
    })
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name
    Object.defineProperty(file, "webkitRelativePath", { value: relativePath, configurable: true })
    return [file]
  }
  if (entry.isDirectory) {
    const reader = entry.createReader()
    const entries: any[] = await readAllEntries(reader)
    const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name
    const files = await Promise.all(entries.map((e: any) => getFilesFromEntry(e, dirPath)))
    return files.flat()
  }
  return []
}

export async function traverseDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  if (dataTransfer.items && dataTransfer.items.length > 0 && (dataTransfer.items[0] as any).webkitGetAsEntry) {
    const entries: any[] = []
    for (let i = 0; i < dataTransfer.items.length; i++) {
      const entry = (dataTransfer.items[i] as any).webkitGetAsEntry()
      if (entry) entries.push(entry)
    }
    if (entries.length > 0) {
      const files = await Promise.all(entries.map((e: any) => getFilesFromEntry(e)))
      return files.flat()
    }
  }
  return Array.from(dataTransfer.files)
}

export function fileDisplayPath(file: File) {
  const path = (file as any).webkitRelativePath as string | undefined
  return path || file.name
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => resolve(""))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const idx = value.indexOf(";base64,")
      resolve(idx >= 0 ? value.slice(idx + 8) : value)
    })
    reader.readAsDataURL(file)
  })
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => resolve(""))
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : "")
    })
    reader.readAsText(file)
  })
}
