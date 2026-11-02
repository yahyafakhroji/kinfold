// The edge pipeline: every event passes through here before the
// spool write. The spool is a file on disk, so a secret that reaches it has
// already leaked once.

import type { NormalizedEvent, RedactionNote, ToolCall, WithheldReason } from '../contract/event'
import { type RedactOptions, type Redacted, redactJson, redactText } from '../redaction/redact'
import { isSensitiveCommand, isSensitivePath } from '../redaction/rules'

declare const redactedBrand: unique symbol

/** An event that passed the edge pipeline. Only prepareForSpool produces one. */
export type RedactedEvent = NormalizedEvent & { readonly [redactedBrand]: true }

export interface PrepareOptions extends RedactOptions {
  /** Extra path patterns, from a project's .memignore. */
  extraPathPatterns?: readonly RegExp[]
  maxFieldChars?: number
}

export const DEFAULT_MAX_FIELD_CHARS = 16_000

const PRIVATE_SPAN = /<private>[\s\S]*?<\/private>/gi
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'filename'] as const
const COMMAND_KEYS = ['command', 'cmd'] as const

export interface ToolTargets {
  paths: string[]
  commands: string[]
}

/** Paths and commands a tool call names, across Claude Code and OpenCode input shapes. */
export function toolTargets(input: unknown): ToolTargets {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { paths: [], commands: [] }
  const record = input as Record<string, unknown>
  const stringsAt = (keys: readonly string[]): string[] =>
    keys.map((key) => record[key]).filter((value): value is string => typeof value === 'string')
  const listed = Array.isArray(record.paths) ? record.paths.filter((value): value is string => typeof value === 'string') : []
  return { paths: [...stringsAt(PATH_KEYS), ...listed], commands: stringsAt(COMMAND_KEYS) }
}

function withheldReason(tool: ToolCall, options: PrepareOptions): WithheldReason | undefined {
  const { paths, commands } = toolTargets(tool.input)
  if (paths.some((path) => isSensitivePath(path, options.extraPathPatterns))) return 'sensitive_path'
  if (commands.some((command) => isSensitiveCommand(command))) return 'sensitive_command'
  return undefined
}

function withheldOutput(reason: WithheldReason, output: string): string {
  const lines = output === '' ? 0 : output.split('\n').length
  return `<withheld reason="${reason}" lines="${lines}" chars="${output.length}"/>`
}

function capText(text: string, field: string, maxChars: number): Redacted<string> {
  if (text.length <= maxChars) return { value: text, notes: [] }
  return {
    value: `${text.slice(0, maxChars)}\n<truncated chars="${text.length - maxChars}"/>`,
    notes: [{ field, rule: 'oversize', count: 1 }],
  }
}

function capJsonStrings(value: unknown, field: string, maxChars: number): Redacted<unknown> {
  const notes: RedactionNote[] = []
  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === 'string') {
      const capped = capText(node, path, maxChars)
      notes.push(...capped.notes)
      return capped.value
    }
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${path}[${index}]`))
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child, `${path}.${key}`)]))
    }
    return node
  }
  return { value: walk(value, field), notes }
}

/** Private spans first, then secrets, then the size cap: capping first could split a secret past its pattern. */
function cleanText(text: string, field: string, options: PrepareOptions): Redacted<string> {
  let privateSpans = 0
  const withoutPrivate = text.replace(PRIVATE_SPAN, () => {
    privateSpans += 1
    return '<private/>'
  })
  const redacted = redactText(withoutPrivate, field, options)
  const capped = capText(redacted.value, field, options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS)
  const privateNote: RedactionNote[] = privateSpans > 0 ? [{ field, rule: 'private_tag', count: privateSpans }] : []
  return { value: capped.value, notes: [...privateNote, ...redacted.notes, ...capped.notes] }
}

function prepareTool(tool: ToolCall, options: PrepareOptions): Redacted<ToolCall> {
  const redactedInput = redactJson(tool.input, 'tool.input', options)
  const input = capJsonStrings(redactedInput.value, 'tool.input', options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS)
  const inputNotes = [...redactedInput.notes, ...input.notes]

  const reason = withheldReason(tool, options)
  if (reason !== undefined) {
    return {
      value: { ...tool, input: input.value, output: withheldOutput(reason, tool.output), withheld: reason },
      notes: [...inputNotes, { field: 'tool.output', rule: reason, count: 1 }],
    }
  }

  const output = cleanText(tool.output, 'tool.output', options)
  return { value: { ...tool, input: input.value, output: output.value }, notes: [...inputNotes, ...output.notes] }
}

export function prepareForSpool(event: NormalizedEvent, options: PrepareOptions): RedactedEvent {
  const notes: RedactionNote[] = []
  const take = <T>(result: Redacted<T>): T => {
    notes.push(...result.notes)
    return result.value
  }

  const prepared: NormalizedEvent = {
    ...event,
    ...(event.promptText !== undefined ? { promptText: take(cleanText(event.promptText, 'promptText', options)) } : {}),
    ...(event.assistantText !== undefined ? { assistantText: take(cleanText(event.assistantText, 'assistantText', options)) } : {}),
    ...(event.tool !== undefined ? { tool: take(prepareTool(event.tool, options)) } : {}),
  }
  // The brand is a phantom type; this function is the only place that mints it.
  return { ...prepared, redactions: notes } as unknown as RedactedEvent
}
