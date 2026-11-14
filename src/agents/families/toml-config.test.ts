import { expect, test } from 'bun:test'
import { type TomlDoc, mergeTomlHooks, mergeTomlMcp, readTomlConfig, removeTomlOurs, renderToml } from './toml-config'
import { assertWriterContract } from './writer-contract.test-support'

const HOOK = { entry: { command: '/Users/dev/.bun/bin/bun', args: ['/Users/dev/sam/src/cli/hook.ts', '--data-dir', '/Users/dev/.kinfold', '--host', 'kimi-code'] } }
const OLD_HOOK = { entry: { command: '/Users/dev/.bun/bin/bun', args: ["/Users/dev/old's checkout/src/cli/hook.ts", '--host', 'kimi-code'] } }
const MCP = { entry: { command: '/Users/dev/.kinfold/bin/kinfold', args: ['--data-dir', '/Users/dev/.kinfold', 'mcp'] } }
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'] as const

// Shaped like the hooks page's example, with a user's own settings around it.
const KIMI = `# Kimi Code settings
default_model = "kimi-k2"   # the model I use
max_steps = 1_000
yolo = false
ratio = 0.5
allow = [
  "Read",  # always
  'Glob',
]

[[hooks]]
event = "Notification"           # Trigger: when a background task status changes
matcher = "task\\\\.completed"     # Only care about "completed" notifications
command = "terminal-notifier -title Kimi -message 'Task done'"

[permissions."web fetch"]
mode = 'ask'
`

const parsed = (text: string): TomlDoc => {
  const doc = readTomlConfig(text)
  if (doc === null) throw new Error('fixture did not parse')
  return doc
}

test.each([
  ['an inline table', 'server = { command = "x" }\n'],
  ['a multi-line basic string', 'note = """\nhello\n"""\n'],
  ['a multi-line literal string', "note = '''\nhello\n'''\n"],
  ['a date', 'when = 1979-05-27\n'],
  ['a hex number', 'n = 0xff\n'],
  ['an array of inline tables', 'xs = [ { a = 1 } ]\n'],
  ['an unterminated string', 'a = "open\n'],
  ['a bad escape', 'a = "\\q"\n'],
  ['two values on one line', 'a = 1 b = 2\n'],
  ['a key with no value', 'a =\n'],
])('readTomlConfig refuses a TOML feature outside the subset: %s', (_name, text) => {
  expect(readTomlConfig(text)).toBeNull()
})

test.each([
  ['a table header given twice', '[a]\nx = 1\n[a]\ny = 2\n'],
  ['a table header given twice with a quoted name', '[a."b c"]\n[a."b c"]\n'],
  ['a table and an array of tables under one name', '[a]\n[[a]]\n'],
  ['an array of tables and a table under one name', '[[a]]\n[a]\n'],
  ['a header over a key of the root', 'a = 1\n[a]\n'],
  ['a header below a key of the root', 'a = 1\n[a.b]\n'],
  ['a header over a table a dotted key made', 'a.b = 1\n[a]\n'],
  ['a header over a table a dotted key made, inside a table', '[t]\na.b = 1\n[t.a]\n'],
  ['a dotted key through a value', 'a = 1\na.b = 2\n'],
  ['a value over a dotted-key table', 'a.b = 1\na = 2\n'],
  ['a dotted key into a table a header defined', '[a.b]\nx = 1\n[a]\nb.y = 2\n'],
  ['an array of tables over a table only headers implied', '[a.b]\n[[a]]\n'],
])('readTomlConfig refuses a document whose tables conflict: %s', (_name, text) => {
  expect(readTomlConfig(text)).toBeNull()
})

test('readTomlConfig still reads tables that only look alike', () => {
  for (const text of [
    '[a.b]\nx = 1\n[a]\ny = 2\n',
    '[[hooks]]\nevent = "A"\n[[hooks]]\nevent = "A"\n',
    '[[a]]\n[a.sub]\nx = 1\n[[a]]\n[a.sub]\nx = 2\n',
    'a.b = 1\na.c = 2\n[a.d]\nx = 1\n',
    '[t]\na.b = 1\n[u]\na.b = 1\n',
    '[mcpServers.one]\ncommand = "x"\n[mcpServers.two]\ncommand = "y"\n',
  ]) {
    expect(renderToml(parsed(text))).toBe(text)
  }
})

test('readTomlConfig reads the subset, comments and all, and renders it back byte for byte', () => {
  const doc = parsed(KIMI)
  expect(renderToml(doc)).toBe(KIMI)
  expect(renderToml(parsed(''))).toBe('')
  expect(renderToml(parsed('a = 1'))).toBe('a = 1')
  expect(renderToml(parsed('a = 1\r\n[b]\r\nc = "d"\r\n'))).toBe('a = 1\r\n[b]\r\nc = "d"\r\n')
})

test('mergeTomlHooks then removeTomlOurs round-trips a Kimi config with other hooks in it', () => {
  const merged = mergeTomlHooks(parsed(KIMI), EVENTS, HOOK)
  const text = renderToml(merged)
  expect(text.startsWith(KIMI)).toBe(true)
  expect(text).toContain(`[[hooks]]\nevent = "Stop"\ncommand = "'/Users/dev/.bun/bin/bun' '/Users/dev/sam/src/cli/hook.ts' --data-dir '/Users/dev/.kinfold' --host kimi-code"\ntimeout = 10\n`)
  expect(text.match(/\[\[hooks\]\]/g)).toHaveLength(6)
  // A re-run finds every entry in place and returns the same document.
  expect(mergeTomlHooks(parsed(text), EVENTS, HOOK)).toEqual(parsed(text))
  expect(renderToml(removeTomlOurs(parsed(text)))).toBe(KIMI)
})

test('a moved checkout replaces our entries instead of adding a second set', () => {
  const stale = renderToml(mergeTomlHooks(parsed(KIMI), EVENTS, OLD_HOOK))
  const fixed = renderToml(mergeTomlHooks(parsed(stale), EVENTS, HOOK))
  expect(fixed).not.toContain("old's checkout")
  expect(fixed.match(/\[\[hooks\]\]/g)).toHaveLength(6)
  expect(renderToml(removeTomlOurs(parsed(fixed)))).toBe(KIMI)
})

test('a user entry added after ours survives removal, and only our separators go', () => {
  const merged = renderToml(mergeTomlHooks(parsed('a = 1\n'), ['Stop', 'SessionEnd'], HOOK))
  const edited = `${merged}\n[[hooks]]\nevent = "Stop"\ncommand = "say done"\n`
  expect(renderToml(removeTomlOurs(parsed(edited)))).toBe('a = 1\n\n[[hooks]]\nevent = "Stop"\ncommand = "say done"\n')
})

test('the writer contract holds for hooks and the MCP table, whatever the file had', () => {
  const write = (before: string | null): string | null => {
    const doc = readTomlConfig(before ?? '')
    if (doc === null) throw new Error('refused')
    const next = mergeTomlMcp(mergeTomlHooks(doc, EVENTS, HOOK), MCP)
    const text = renderToml(next)
    return text === (before ?? '') ? null : text
  }
  const remove = (after: string | null): string => {
    const doc = readTomlConfig(after ?? '')
    if (doc === null) throw new Error('refused')
    return renderToml(removeTomlOurs(doc))
  }
  assertWriterContract(write, remove, [KIMI, '', 'a = 1', 'a = 1\n\n\n', null])
})

test('the MCP table carries our command and args, and a foreign one under our name is an error', () => {
  const text = renderToml(mergeTomlMcp(parsed('[mcpServers.other]\ncommand = "npx"\n'), MCP))
  expect(text).toBe('[mcpServers.other]\ncommand = "npx"\n\n[mcpServers.kinfold]\ncommand = "/Users/dev/.kinfold/bin/kinfold"\nargs = ["--data-dir", "/Users/dev/.kinfold", "mcp"]\n')
  expect(() => mergeTomlMcp(parsed('[mcpServers.kinfold]\ncommand = "npx"\n'), MCP)).toThrow('not ours')
})

test('a root hooks key that is not an array of tables is an error, never overwritten', () => {
  expect(() => mergeTomlHooks(parsed('hooks = "off"\n'), EVENTS, HOOK)).toThrow('hooks')
  expect(() => mergeTomlHooks(parsed('[hooks]\na = 1\n'), EVENTS, HOOK)).toThrow('hooks')
})

test.each([
  ['an array of tables under hooks', '[[hooks.foo]]\na = 1\n'],
  ['a table under hooks', '[hooks.foo]\na = 1\n'],
  ['a dotted root key under hooks', 'hooks.enabled = true\n'],
])('a config with %s is refused, since appending [[hooks]] would make it invalid', (_name, text) => {
  expect(() => mergeTomlHooks(parsed(text), EVENTS, HOOK)).toThrow('[[hooks]]')
})
