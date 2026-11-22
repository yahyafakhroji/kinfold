// A read tool's answer as it crosses a process boundary: from the Windows
// daemon to WSL, from the hub to a device. Both sides rebuild it from JSON
// field by field, and both need the same answer for "could not ask".

import { isRecord } from '../../system/contract/event'
import type { ToolOutcome, ToolResult } from './tools'

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

/** The answer of a read tool that could not reach the memory: no rows, and why, behind the caller's own lead-in (`prefix`). */
export function unavailableOutcome(prefix: string, reason: string): ToolOutcome {
  const result: ToolResult = {
    content: [{ type: 'text', text: `${prefix}${reason}` }],
    structuredContent: { status: 'unavailable', reason },
    isError: true,
  }
  return { result, count: 0 }
}

function parseContent(value: unknown): ToolResult['content'] | null {
  if (!Array.isArray(value)) return null
  const content: ToolResult['content'] = []
  for (const item of value) {
    if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') return null
    content.push({ type: 'text', text: item.text })
  }
  return content
}

function parseResult(value: unknown): ToolResult | null {
  if (!isRecord(value)) return null
  const content = parseContent(value.content)
  const { structuredContent, isError } = value
  if (content === null || !isRecord(structuredContent)) return null
  if (isError !== undefined && typeof isError !== 'boolean') return null
  return isError === undefined ? { content, structuredContent } : { content, structuredContent, isError }
}

const isIdList = (value: unknown): value is number[] => Array.isArray(value) && value.every((id) => Number.isInteger(id))

/** A ToolOutcome rebuilt from the daemon's JSON, keeping only checked fields; null when any field is off. */
export function parseToolOutcome(value: unknown): ToolOutcome | null {
  if (!isRecord(value)) return null
  const result = parseResult(value.result)
  const { count, ids, scope } = value
  if (result === null || !isCount(count)) return null
  if (ids !== undefined && !isIdList(ids)) return null
  if (scope !== undefined && typeof scope !== 'string') return null
  return { result, count, ...(ids !== undefined ? { ids } : {}), ...(scope !== undefined ? { scope } : {}) }
}
