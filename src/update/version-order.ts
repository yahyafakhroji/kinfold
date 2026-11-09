// Semver order for release tags: a pre-release sorts before its release.

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  pre: string | null
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/** Null for anything that is not `major.minor.patch[-pre][+build]`; a leading `v` is not accepted. */
export function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(text)
  if (match === null) return null
  const [, major, minor, patch, pre] = match
  const numbers = [Number(major), Number(minor), Number(patch)]
  if (!numbers.every(Number.isSafeInteger)) return null
  return { major: numbers[0]!, minor: numbers[1]!, patch: numbers[2]!, pre: pre ?? null }
}

function comparePre(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Negative when a is older than b. A text that does not parse throws: callers check with parseVersion first. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) throw new Error('not a version')
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  return comparePre(left.pre, right.pre)
}
