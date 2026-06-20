interface ParsedExtensionVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const EXTENSION_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const NUMERIC_IDENTIFIER_PATTERN = /^\d+$/

export function shouldPromptReloadForInstalledVersion(installedVersion: string, runningVersion: string) {
  if (installedVersion === runningVersion) return false
  return compareExtensionVersions(installedVersion, runningVersion) > 0
}

export function compareExtensionVersions(left: string, right: string) {
  const leftVersion = parseExtensionVersion(left)
  const rightVersion = parseExtensionVersion(right)
  if (!leftVersion || !rightVersion) return left === right ? 0 : 1

  const coreDelta =
    leftVersion.major - rightVersion.major
    || leftVersion.minor - rightVersion.minor
    || leftVersion.patch - rightVersion.patch
  if (coreDelta !== 0) return coreDelta

  return comparePrereleaseIdentifiers(leftVersion.prerelease, rightVersion.prerelease)
}

function parseExtensionVersion(version: string): ParsedExtensionVersion | undefined {
  const match = version.trim().match(EXTENSION_VERSION_PATTERN)
  if (!match) return undefined

  const prerelease = match[4]?.split(".") ?? []
  if (prerelease.some((identifier) => identifier.length === 0)) return undefined

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

function comparePrereleaseIdentifiers(left: string[], right: string[]) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index]
    const rightIdentifier = right[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1

    const delta = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier)
    if (delta !== 0) return delta
  }

  return 0
}

function comparePrereleaseIdentifier(left: string, right: string) {
  const leftIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(left)
  const rightIsNumeric = NUMERIC_IDENTIFIER_PATTERN.test(right)

  if (leftIsNumeric && rightIsNumeric) return Number(left) - Number(right)
  if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
