// Small pure formatters shared by the dashboard pages: ages, byte sizes,
// percentages, durations and truncation. No DOM, so tests import them as is.

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "now", "12m", "5h", "3d" from a timestamp in epoch ms.
 * @param {number} at
 * @param {number} now
 */
export function formatAge(at, now) {
  const ms = Math.max(0, now - at)
  if (ms < MINUTE) return 'now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`
  return `${Math.floor(ms / DAY)}d`
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** @param {number | null} ms */
export function formatDuration(ms) {
  if (ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < MINUTE) return `${(ms / 1000).toFixed(1)} s`
  return `${(ms / MINUTE).toFixed(1)} min`
}

/** @param {number | null} rate 0..1 */
export function formatPercent(rate) {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

/**
 * @param {string} text
 * @param {number} max
 */
export function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** @param {number} at */
export function formatTime(at) {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 16)
}
