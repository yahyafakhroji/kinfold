// The edge pipeline: every event passes through here before the
// spool write. The spool is a file on disk, so a secret that reaches it has
// already leaked once.

import type { NormalizedEvent, RedactionNote, ToolCall, WithheldReason } from '../../system/contract/event'
import { type RedactOptions, type Redacted, redactJson, redactText } from '../redaction/redact'
import { commandNamesSensitivePath, isSensitiveCommand, isSensitivePath } from '../redaction/rules'

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
export function cleanText(text: string, field: string, options: PrepareOptions): Redacted<string> {
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

const WITHHELD_INPUT = /^<withheld reason="[a-z_]+" chars="\d+"\/>$/
const withheldInput = (reason: WithheldReason, text: string): string => `<withheld reason="${reason}" chars="${text.length}"/>`

/**
 * A Write or Edit carries the file's contents in its input, and a command that
 * names a sensitive file may be writing it, so withholding the output alone
 * would keep the secret. For a sensitive path every string but the path is
 * replaced by its length; for a sensitive command, each command that names
 * such a file. Returns the input and how many values were withheld.
 */
function withholdInput(input: unknown, reason: WithheldReason): { value: unknown; withheld: number } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { value: input, withheld: 0 }
  let withheld = 0
  const replace = (text: string): string => {
    withheld += 1
    return withheldInput(reason, text)
  }
  const strip = (node: unknown): unknown => {
    // The daemon runs this again at ingest, and the leak scanner over stored rows: a value already withheld stays as it is.
    if (typeof node === 'string') return WITHHELD_INPUT.test(node) ? node : replace(node)
    if (Array.isArray(node)) return node.map(strip)
    if (node !== null && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, strip(child)]))
    return node
  }
  const kept: readonly string[] = reason === 'sensitive_path' ? [...PATH_KEYS, 'paths'] : []
  const value = Object.fromEntries(Object.entries(input).map(([key, child]) => {
    if (reason === 'sensitive_path') return [key, kept.includes(key) ? child : strip(child)]
    const names = (COMMAND_KEYS as readonly string[]).includes(key) && typeof child === 'string' && commandNamesSensitivePath(child)
    return [key, names ? replace(child as string) : child]
  }))
  return { value, withheld }
}

function prepareTool(tool: ToolCall, options: PrepareOptions): Redacted<ToolCall> {
  const reason = withheldReason(tool, options)
  const kept = reason === undefined ? { value: tool.input, withheld: 0 } : withholdInput(tool.input, reason)
  // A sensitive command that stays readable is read strictly: any random string in it is taken for a secret.
  const redactedInput = redactJson(kept.value, 'tool.input', reason === 'sensitive_command' ? { ...options, entropyMode: 'strict' } : options)
  const input = capJsonStrings(redactedInput.value, 'tool.input', options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS)
  const inputNotes = [...redactedInput.notes, ...input.notes]

  if (reason !== undefined) {
    const withheldNote: RedactionNote[] = kept.withheld > 0 ? [{ field: 'tool.input', rule: reason, count: kept.withheld }] : []
    return {
      value: { ...tool, input: input.value, output: withheldOutput(reason, tool.output), withheld: reason },
      notes: [...inputNotes, ...withheldNote, { field: 'tool.output', rule: reason, count: 1 }],
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
