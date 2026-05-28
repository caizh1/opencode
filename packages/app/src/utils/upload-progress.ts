export type UploadProgressEntry = {
  size: number
  loaded: number
  status: "pending" | "uploading" | "done" | "error"
}

export function uploadProgress(entries: UploadProgressEntry[]) {
  const total = entries.reduce((sum, entry) => sum + entry.size, 0)
  const loaded = entries.reduce((sum, entry) => {
    if (entry.status === "done" || entry.status === "error") return sum + entry.size
    if (entry.status === "uploading") return sum + Math.min(entry.loaded, entry.size)
    return sum
  }, 0)

  return {
    total,
    loaded,
    percent: total === 0 ? 100 : Math.round((loaded / total) * 100),
  }
}
