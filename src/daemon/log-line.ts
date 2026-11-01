// One daemon log line. The UTC timestamp comes first so a stall (a slow answer
// next to slow embeds and failed observer runs) can be placed in time and
// matched against sleep or load. The message is the caller's: ids, counts and
// timings, never text.

export function logLine(message: string, at: Date = new Date()): string {
  return `${at.toISOString()} sam-daemon: ${message}\n`
}
