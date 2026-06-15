export type IndexingPathPolicy = {
  indexTests?: boolean
}

export function isTestDirectoryPath(path: string) {
  return normalizePathSegments(path).some((segment) => segment === "test" || segment === "tests")
}

export function shouldIndexPath(path: string, policy: IndexingPathPolicy = {}) {
  return policy.indexTests === true || !isTestDirectoryPath(path)
}

function normalizePathSegments(path: string) {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)
}
