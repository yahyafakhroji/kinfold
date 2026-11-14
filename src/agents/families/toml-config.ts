// Kinfold's entries in a TOML config such as Kimi Code's ~/.kimi-code/config.toml,
// whose hooks are [[hooks]] tables of event, matcher, command and timeout
// (kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html, checked
// 2026-11-13). Only a subset of TOML is read: tables, arrays of tables, keys
// (bare, quoted or dotted), single-line strings, decimal numbers, booleans and
// arrays of those, with comments. Anything else (inline tables, multi-line
// strings, dates, hex numbers) makes readTomlConfig return null, so the file
// is refused rather than half understood. So does a document TOML itself
// rejects for defining one name twice: a table header repeated, a table and
// an array of tables under one name, or a header and a key (plain or dotted)
// claiming the same table. Kimi would not load such a file, and the blocks
// here would give one table's keys to two owners.
//
// The document is kept as its own lines, split into blocks at each header, so
// every byte outside Kinfold's tables stays as the user wrote it. Our tables
// are appended at the end, each after one blank line, and removal takes out
// those tables and the blank line before them, which gives back the original
// bytes when nothing else changed. Ours are found by what their command runs
// (entry.ts), never by position.

import { MCP_SERVER_NAME, mcpServerScript } from '../../install/mcp-config'
import { entryRole } from '../../install/entry'
import type { HookTarget } from './json-hooks'
import { shellCommand } from './json-hooks'

export type TomlValue = string | number | boolean | readonly TomlValue[]

export interface TomlBlock {
  kind: 'root' | 'table' | 'array'
  /** The header's dotted key, quoted parts kept quoted; '' for the root. */
  name: string
  /** Raw lines, header first; blank and comment lines up to the next header belong here. */
  lines: readonly string[]
  /** The block's own keys, dotted, with their values. */
  values: Readonly<Record<string, TomlValue>>
}

export interface TomlDoc {
  blocks: readonly TomlBlock[]
  finalNewline: boolean
}

export interface McpTomlTarget {
  entry: HookTarget['entry']
}

const HOOK_TIMEOUT_S = 10
const HOOKS = 'hooks'
const MCP_TABLE = `mcpServers.${MCP_SERVER_NAME}`
const BARE_KEY = /^[A-Za-z0-9_-]+$/
const NUMBER = /[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/y
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

interface ParsedHeader {
  kind: 'root' | 'table' | 'array'
  name: string
  startLine: number
  values: Record<string, TomlValue>
}

type Claim = 'value' | 'table' | 'array' | 'implied' | 'dotted'
/** Key parts as written; a number is the element of the array of tables before it. */
type ClaimPath = readonly (string | number)[]

interface Claims {
  /** Records a [table] or [[array]] header; the path its keys live under, or null when the name is taken. */
  header(parts: readonly string[], isArray: boolean): ClaimPath | null
  /** Records a key of the block at `base`; false when it or a table on its way is taken. */
  key(base: ClaimPath, parts: readonly string[], block: number): boolean
}

/**
 * Who defined each table and key so far. A header may fill in a table that
 * earlier headers only implied ([a.b] then [a]) and may add a sub-table to
 * one a dotted key made; a dotted key may extend only tables made by dotted
 * keys of its own block. Everything else under a taken name is a conflict.
 */
function newClaims(): Claims {
  const kinds = new Map<string, Claim>()
  const dottedBy = new Map<string, number>()
  const elements = new Map<string, number>()
  const id = (path: ClaimPath): string => JSON.stringify(path)
  /** The path with every array of tables on it narrowed to its latest element, the one a header below it means. */
  const scoped = (parts: readonly string[]): (string | number)[] => {
    const out: (string | number)[] = []
    for (const part of parts) {
      out.push(part)
      const count = kinds.get(id(out)) === 'array' ? elements.get(id(out)) : undefined
      if (count !== undefined) out.push(count - 1)
    }
    return out
  }
  return {
    header: (parts, isArray) => {
      const parent = scoped(parts.slice(0, -1))
      for (let end = 1; end <= parent.length; end += 1) {
        if (typeof parent[end - 1] === 'number') continue
        const prefix = id(parent.slice(0, end))
        if (kinds.get(prefix) === 'value') return null
        if (!kinds.has(prefix)) kinds.set(prefix, 'implied')
      }
      const path = [...parent, parts[parts.length - 1] ?? '']
      const existing = kinds.get(id(path))
      if (existing !== undefined && existing !== (isArray ? 'array' : 'implied')) return null
      if (!isArray) {
        kinds.set(id(path), 'table')
        return path
      }
      const count = (elements.get(id(path)) ?? 0) + 1
      kinds.set(id(path), 'array')
      elements.set(id(path), count)
      return [...path, count - 1]
    },
    key: (base, parts, block) => {
      for (let end = 1; end < parts.length; end += 1) {
        const prefix = id([...base, ...parts.slice(0, end)])
        const existing = kinds.get(prefix)
        if (existing === undefined) {
          kinds.set(prefix, 'dotted')
          dottedBy.set(prefix, block)
        } else if (existing !== 'dotted' || dottedBy.get(prefix) !== block) return false
      }
      const full = id([...base, ...parts])
      if (kinds.has(full)) return false
      kinds.set(full, 'value')
      return true
    },
  }
}

const dottedName = (parts: readonly string[]): string => parts.map((part) => (BARE_KEY.test(part) ? part : JSON.stringify(part))).join('.')

/** The statements of `text`, or null at the first thing outside the subset or the first name defined twice. */
function parseStatements(text: string): ParsedHeader[] | null {
  let pos = 0
  let line = 0
  const blocks: ParsedHeader[] = [{ kind: 'root', name: '', startLine: 0, values: {} }]
  const claims = newClaims()
  let base: ClaimPath = []
  const peek = (ahead = 0): string | undefined => text[pos + ahead]
  const skipWs = (): void => {
    while (peek() === ' ' || peek() === '\t') pos += 1
  }
  const atEol = (): boolean => pos >= text.length || peek() === '\n' || (peek() === '\r' && peek(1) === '\n')
  const eatEol = (): void => {
    if (pos >= text.length) return
    pos += peek() === '\r' ? 2 : 1
    line += 1
  }
  const skipComment = (): void => {
    if (peek() === '#') while (!atEol()) pos += 1
  }
  const endOfStatement = (): boolean => {
    skipWs()
    skipComment()
    if (!atEol()) return false
    eatEol()
    return true
  }
  const skipBlank = (): void => {
    for (;;) {
      skipWs()
      skipComment()
      if (pos >= text.length || !atEol()) return
      eatEol()
    }
  }
  const isDelimiter = (char: string | undefined): boolean => char === undefined || ' \t,]#\r\n'.includes(char)

  const basicString = (): string | undefined => {
    pos += 1
    let out = ''
    for (;;) {
      const char = peek()
      if (char === undefined || char === '\n' || char === '\r') return undefined
      pos += 1
      if (char === '"') return out
      if (char !== '\\') {
        if (char < ' ' && char !== '\t') return undefined
        out += char
        continue
      }
      const escape = peek() ?? ''
      pos += 1
      if (SIMPLE_ESCAPES[escape] !== undefined) {
        out += SIMPLE_ESCAPES[escape]
        continue
      }
      const width = escape === 'u' ? 4 : escape === 'U' ? 8 : 0
      const hex = text.slice(pos, pos + width)
      if (width === 0 || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) return undefined
      const code = Number.parseInt(hex, 16)
      if (code > 0x10ffff) return undefined
      out += String.fromCodePoint(code)
      pos += width
    }
  }
  const literalString = (): string | undefined => {
    const end = text.indexOf("'", pos + 1)
    const body = end === -1 ? '' : text.slice(pos + 1, end)
    if (end === -1 || body.includes('\n')) return undefined
    pos = end + 1
    return body
  }
  const keyPart = (): string | undefined => {
    if (peek() === '"') return text.startsWith('"""', pos) ? undefined : basicString()
    if (peek() === "'") return text.startsWith("'''", pos) ? undefined : literalString()
    const start = pos
    while (/[A-Za-z0-9_-]/.test(peek() ?? '')) pos += 1
    return pos === start ? undefined : text.slice(start, pos)
  }
  const keyPath = (): string[] | undefined => {
    const parts: string[] = []
    for (;;) {
      skipWs()
      const part = keyPart()
      if (part === undefined) return undefined
      parts.push(part)
      skipWs()
      if (peek() !== '.') return parts
      pos += 1
    }
  }
  const value = (): TomlValue | undefined => {
    const char = peek()
    if (char === '"') return text.startsWith('"""', pos) ? undefined : basicString()
    if (char === "'") return text.startsWith("'''", pos) ? undefined : literalString()
    if (char === '[') return array()
    for (const [word, bool] of [['true', true], ['false', false]] as const) {
      if (text.startsWith(word, pos) && isDelimiter(peek(word.length))) {
        pos += word.length
        return bool
      }
    }
    NUMBER.lastIndex = pos
    const match = NUMBER.exec(text)
    if (match === null || !isDelimiter(text[pos + match[0].length])) return undefined
    pos += match[0].length
    return Number(match[0].replaceAll('_', ''))
  }
  const array = (): TomlValue[] | undefined => {
    pos += 1
    const items: TomlValue[] = []
    for (;;) {
      skipBlank()
      if (peek() === ']') {
        pos += 1
        return items
      }
      const item = value()
      if (item === undefined) return undefined
      items.push(item)
      skipBlank()
      if (peek() === ',') pos += 1
      else if (peek() !== ']') return undefined
    }
  }

  while (pos < text.length) {
    skipWs()
    if (pos >= text.length) break
    if (atEol()) {
      eatEol()
      continue
    }
    if (peek() === '#') {
      skipComment()
      eatEol()
      continue
    }
    if (peek() === '[') {
      const isArray = peek(1) === '['
      const close = isArray ? ']]' : ']'
      pos += close.length
      const name = keyPath()
      if (name === undefined || !text.startsWith(close, pos)) return null
      pos += close.length
      const startLine = line
      if (!endOfStatement()) return null
      const claimed = claims.header(name, isArray)
      if (claimed === null) return null
      base = claimed
      blocks.push({ kind: isArray ? 'array' : 'table', name: dottedName(name), startLine, values: {} })
      continue
    }
    const key = keyPath()
    if (key === undefined || peek() !== '=') return null
    pos += 1
    skipWs()
    const parsed = value()
    const block = blocks[blocks.length - 1]
    if (parsed === undefined || block === undefined || !claims.key(base, key, blocks.length - 1)) return null
    block.values[dottedName(key)] = parsed
    if (!endOfStatement()) return null
  }
  return blocks
}

function splitLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text === '') return { lines: [], finalNewline: true }
  const lines = text.split('\n')
  const finalNewline = text.endsWith('\n')
  return { lines: finalNewline ? lines.slice(0, -1) : lines, finalNewline }
}

/** The document, or null when it uses anything outside the subset this module reads. */
export function readTomlConfig(text: string): TomlDoc | null {
  const headers = parseStatements(text)
  if (headers === null) return null
  const { lines, finalNewline } = splitLines(text)
  const blocks = headers.map((header, index): TomlBlock => ({
    kind: header.kind,
    name: header.name,
    lines: lines.slice(header.startLine, headers[index + 1]?.startLine ?? lines.length),
    values: header.values,
  }))
  return { blocks, finalNewline }
}

export function renderToml(doc: TomlDoc): string {
  const lines = doc.blocks.flatMap((block) => block.lines)
  return lines.length === 0 ? '' : `${lines.join('\n')}${doc.finalNewline ? '\n' : ''}`
}

const isBlank = (line: string): boolean => line.trim() === ''
const isTrailing = (line: string): boolean => isBlank(line) || line.trimStart().startsWith('#')

/** The blank and comment lines that close a block. */
function trailingLines(block: TomlBlock): readonly string[] {
  let at = block.lines.length
  while (at > 1 && isTrailing(block.lines[at - 1] ?? '')) at -= 1
  return block.lines.slice(at)
}

const contentLines = (block: TomlBlock): readonly string[] => block.lines.slice(0, block.lines.length - trailingLines(block).length)

function isOurHook(block: TomlBlock): boolean {
  const command = block.values.command
  return block.kind === 'array' && block.name === HOOKS && typeof command === 'string' && entryRole(command, []) === 'hook'
}

function isOurMcp(block: TomlBlock): boolean {
  return block.kind === 'table' && block.name === MCP_TABLE && mcpServerScript({ command: block.values.command, args: block.values.args }) !== null
}

/**
 * Drops the matching tables. For each run of them, the blank line our append
 * put before the run goes too, and the lines that closed the run (the
 * separator before whatever the user added after it) stay.
 */
function removeBlocks(doc: TomlDoc, ours: (block: TomlBlock) => boolean): TomlDoc {
  const kept: TomlBlock[] = []
  let run: TomlBlock[] = []
  const closeRun = (): void => {
    const last = run.at(-1)
    const previous = kept.at(-1)
    run = []
    if (last === undefined || previous === undefined) return
    const lines = previous.lines.length > 0 && isBlank(previous.lines.at(-1) ?? '') ? previous.lines.slice(0, -1) : previous.lines
    kept[kept.length - 1] = { ...previous, lines: [...lines, ...trailingLines(last)] }
  }
  for (const block of doc.blocks) {
    if (block.kind !== 'root' && ours(block)) {
      run.push(block)
      continue
    }
    closeRun()
    kept.push(block)
  }
  closeRun()
  return { ...doc, blocks: kept }
}

function appendBlocks(doc: TomlDoc, tables: readonly (readonly string[])[]): TomlDoc {
  const lines = doc.blocks.flatMap((block) => block.lines)
  const next = [...lines, ...tables.flatMap((table, index) => (lines.length > 0 || index > 0 ? ['', ...table] : [...table]))]
  const parsed = readTomlConfig(`${next.join('\n')}${doc.finalNewline ? '\n' : ''}`)
  if (parsed === null) throw new Error('the merged config.toml did not read back; nothing was written')
  return parsed
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((line, index) => line === b[index])

export function tomlString(value: string): string {
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, (char) => {
    if (char === '\\' || char === '"') return `\\${char}`
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  return `"${escaped}"`
}

function hookTable(event: string, target: HookTarget): string[] {
  return ['[[hooks]]', `event = ${tomlString(event)}`, `command = ${tomlString(shellCommand(target.entry))}`, `timeout = ${HOOK_TIMEOUT_S}`]
}

function mcpTable(target: McpTomlTarget): string[] {
  return [`[${MCP_TABLE}]`, `command = ${tomlString(target.entry.command)}`, `args = [${target.entry.args.map(tomlString).join(', ')}]`]
}

const underHooks = (name: string): boolean => name.startsWith(`${HOOKS}.`)

/**
 * Appending [[hooks]] is only valid while nothing else claims the name: a
 * [hooks] table, a root hooks key, or any table or array of tables below
 * hooks, which Kimi's [[hooks]] tables (four fields, nothing else) never have.
 */
function assertHooksFree(doc: TomlDoc): void {
  const clash = doc.blocks.some((block) =>
    (block.kind === 'table' && block.name === HOOKS)
    || (block.kind !== 'root' && underHooks(block.name))
    || Object.keys(block.kind === 'root' ? block.values : {}).some((key) => key === HOOKS || underHooks(key)))
  if (clash) throw new Error('config.toml "hooks" is not a list of [[hooks]] tables; fix it by hand first')
}

/** Our [[hooks]] table for each event; a re-run with them in place returns the same document. */
export function mergeTomlHooks(doc: TomlDoc, events: readonly string[], target: HookTarget): TomlDoc {
  assertHooksFree(doc)
  const desired = events.map((event) => hookTable(event, target))
  const ours = doc.blocks.filter(isOurHook)
  if (ours.length === desired.length && ours.every((block, index) => sameLines(contentLines(block), desired[index] ?? []))) return doc
  return appendBlocks(removeBlocks(doc, isOurHook), desired)
}

/** Our [mcpServers.kinfold] table; a table by that name that runs anything else is an error, never overwritten. */
export function mergeTomlMcp(doc: TomlDoc, target: McpTomlTarget): TomlDoc {
  const named = doc.blocks.filter((block) => block.kind === 'table' && block.name === MCP_TABLE)
  if (named.some((block) => !isOurMcp(block))) throw new Error(`config.toml [${MCP_TABLE}] is not ours; rename or remove it by hand first`)
  const desired = mcpTable(target)
  if (named.length === 1 && named[0] !== undefined && sameLines(contentLines(named[0]), desired)) return doc
  return appendBlocks(removeBlocks(doc, isOurMcp), [desired])
}

/** Only Kinfold's tables out, hooks and MCP; every other byte stays. */
export function removeTomlOurs(doc: TomlDoc): TomlDoc {
  return removeBlocks(doc, (block) => isOurHook(block) || isOurMcp(block))
}
