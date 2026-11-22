// Reads an agent's JSON config for a merge. Some agents accept JSON with
// comments or trailing commas (Zed, VS Code settings); writing such a file
// back through JSON.stringify would drop the user's comments, so a file that
// JSON.parse rejects is refused, untouched, and the agent is skipped with the
// reason. Messages carry the path only, never file contents.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isRecord } from '../../contract/event'
import { type JsonFile, existingBackups, serializeJson } from '../../install/files'

export const NOT_PLAIN_JSON = 'is not plain JSON (comments and trailing commas are not supported); left untouched'

/** Missing is fine; anything JSON.parse rejects, or a value that is not an object, throws and nothing is written. */
export function readPlainJsonObject(path: string): JsonFile {
  if (!existsSync(path)) return { exists: false }
  const text = readFileSync(path, 'utf8')
  let value: unknown
  try {
    value = text.trim() === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error(`${path} ${NOT_PLAIN_JSON}`)
  }
  if (!isRecord(value)) throw new Error(`${path} does not hold a JSON object; left untouched`)
  return { exists: true, value, text, mode: statSync(path).mode & 0o777 }
}

/**
 * The text an uninstall writes. When what is left equals the backup taken
 * before our first change, the backup's own bytes go back, so a user's
 * formatting survives an install and uninstall even though a merge
 * re-serialises the file; otherwise the value is serialised as the merge does.
 */
export function uninstallText(path: string, value: unknown, current: string): string {
  for (const backup of existingBackups(path).sort()) {
    try {
      const text = readFileSync(backup, 'utf8')
      const parsed: unknown = text.trim() === '' ? {} : JSON.parse(text)
      if (JSON.stringify(parsed) === JSON.stringify(value)) return text
    } catch {
      // A backup that no longer parses is not a guide to the original bytes.
    }
  }
  return serializeJson(value, current)
}
