import { describe, expect, test } from 'bun:test'
import { CODEX_HOOK_SPEC, CURSOR_HOOK_SPEC, inspectHostHooks, mergeHostHooks, removeHostHooks, samCommand, samCommandScript, samItem } from './host-hooks'

const TARGET = { bunPath: '/Users/dev/.bun/bin/bun', hookScript: '/Users/dev/sam/src/cli/hook.ts', entry: { command: '/Users/dev/.bun/bin/bun', args: ['/Users/dev/sam/src/cli/hook.ts'] } }
const OLD = { bunPath: '/Users/dev/.bun/bin/bun', hookScript: "/Users/dev/old's checkout/src/cli/hook.ts", entry: { command: '/Users/dev/.bun/bin/bun', args: ["/Users/dev/old's checkout/src/cli/hook.ts"] } }

/** The target with the host flag a Codex or Cursor entry carries. */
const forHost = (target: typeof TARGET, host: 'codex' | 'cursor') => ({ ...target, entry: { command: target.entry.command, args: [...target.entry.args, '--host', host] } })

/** Shaped like the entries another tool wrote into ~/.cursor/hooks.json on the dev machine (synthetic path). */
const FOREIGN_CURSOR = { command: "if [ -x '/Users/dev/.other/cursor-hook.sh' ]; then /bin/sh '/Users/dev/.other/cursor-hook.sh'; fi", timeout: 10 }
const cursorFile = () => ({
  version: 1,
  hooks: { beforeSubmitPrompt: [FOREIGN_CURSOR], stop: [FOREIGN_CURSOR], preToolUse: [FOREIGN_CURSOR], beforeMCPExecution: [FOREIGN_CURSOR] },
})
const FOREIGN_CODEX = { matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh', timeout: 30 }] }
const codexFile = () => ({ description: 'mine', hooks: { PreToolUse: [FOREIGN_CODEX], PostToolUse: [FOREIGN_CODEX] } })

describe('our command', () => {
  test('quotes both paths and names the host; recognised for that host only', () => {
    expect(samCommand(forHost(TARGET, 'codex'))).toBe("'/Users/dev/.bun/bin/bun' '/Users/dev/sam/src/cli/hook.ts' --host codex")
    expect(samCommandScript({ command: samCommand(forHost(TARGET, 'codex')) }, 'codex')).toBe(TARGET.hookScript)
    expect(samCommandScript({ command: samCommand(forHost(TARGET, 'codex')) }, 'cursor')).toBeNull()
    expect(samCommandScript({ command: samCommand(forHost(OLD, 'cursor')) }, 'cursor')).toBe(OLD.hookScript)
    expect(samCommandScript({ command: 'bun /a/src/cli/hook.ts --host cursor' }, 'cursor')).toBe('/a/src/cli/hook.ts')
    expect(samCommandScript(FOREIGN_CURSOR, 'cursor')).toBeNull()
    expect(samCommandScript({ command: 'bun /a/src/cli/hook.ts' }, 'codex')).toBeNull()
  })

  test('Codex groups carry no matcher; PostToolUse is async; SessionEnd fits the 3 s cap', () => {
    expect(samItem(CODEX_HOOK_SPEC, 'PostToolUse', forHost(TARGET, 'codex'))).toEqual({ hooks: [{ type: 'command', command: samCommand(forHost(TARGET, 'codex')), timeout: 10, async: true }] })
    expect(samItem(CODEX_HOOK_SPEC, 'SessionEnd', forHost(TARGET, 'codex'))).toEqual({ hooks: [{ type: 'command', command: samCommand(forHost(TARGET, 'codex')), timeout: 3 }] })
    expect(samItem(CURSOR_HOOK_SPEC, 'stop', forHost(TARGET, 'cursor'))).toEqual({ command: samCommand(forHost(TARGET, 'cursor')), timeout: 10 })
  })
})

describe.each([
  ['codex', CODEX_HOOK_SPEC, codexFile],
  ['cursor', CURSOR_HOOK_SPEC, cursorFile],
] as const)('%s hooks.json', (_name, spec, file) => {
  const T = forHost(TARGET, spec.host)
  const O = forHost(OLD, spec.host)

  test('merge adds every event and keeps every foreign key and entry', () => {
    const merged = mergeHostHooks(spec, file(), T)
    expect(merged.added).toEqual([...spec.events])
    const hooks = (merged.settings as { hooks: Record<string, unknown[]> }).hooks
    for (const [event, list] of Object.entries(file().hooks)) expect(hooks[event]?.slice(0, list.length)).toEqual(list)
    for (const event of spec.events) expect(hooks[event]?.at(-1)).toEqual(samItem(spec, event, T))
    expect(inspectHostHooks(spec, merged.settings, T.entry)).toBe('yes')
  })

  test('a re-run is a no-op returning the same object', () => {
    const once = mergeHostHooks(spec, file(), T).settings
    const twice = mergeHostHooks(spec, once, T)
    expect(twice.changed).toBe(false)
    expect(twice.settings).toBe(once)
  })

  test('a moved checkout replaces the stale entry instead of adding a second', () => {
    const stale = mergeHostHooks(spec, file(), O).settings
    expect(inspectHostHooks(spec, stale, T.entry)).toBe('stale')
    const fixed = mergeHostHooks(spec, stale, T)
    expect(fixed.replaced).toEqual([...spec.events])
    expect(JSON.stringify(fixed.settings)).not.toContain('old')
  })

  test('remove takes out only ours and gives back the original', () => {
    const merged = mergeHostHooks(spec, file(), T).settings
    expect(removeHostHooks(spec, merged)).toEqual({ settings: file(), removed: spec.events.length })
    const untouched = file()
    expect(removeHostHooks(spec, untouched).settings).toBe(untouched)
  })

  test('a wrong shape is an error, never overwritten', () => {
    expect(() => mergeHostHooks(spec, { hooks: [] }, T)).toThrow('"hooks" is not an object')
    expect(() => mergeHostHooks(spec, { hooks: { [spec.events[0] ?? '']: {} } }, T)).toThrow('is not a list')
  })
})

test('Cursor gets version 1 when the file lacks it, and keeps the version it has', () => {
  expect(mergeHostHooks(CURSOR_HOOK_SPEC, {}, forHost(TARGET, 'cursor')).settings.version).toBe(1)
  expect(mergeHostHooks(CURSOR_HOOK_SPEC, { version: 2, hooks: {} }, forHost(TARGET, 'cursor')).settings.version).toBe(2)
  expect(mergeHostHooks(CODEX_HOOK_SPEC, { hooks: {} }, forHost(TARGET, 'codex')).settings.version).toBeUndefined()
})

test('the Codex empty file a previous tool left ({"hooks": {}}) comes back as it was', () => {
  const merged = mergeHostHooks(CODEX_HOOK_SPEC, { hooks: {} }, forHost(TARGET, 'codex')).settings
  expect(removeHostHooks(CODEX_HOOK_SPEC, merged).settings).toEqual({ hooks: {} })
})
