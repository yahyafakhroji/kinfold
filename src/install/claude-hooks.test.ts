import { expect, test } from 'bun:test'
import { CLAUDE_HOOK_EVENTS, inspectSamHooks, mergeSamHooks, removeSamHooks, samHookGroup, samHookScript } from './claude-hooks'

const TARGET = { bunPath: '/Users/dev/.bun/bin/bun', hookScript: '/Users/dev/sam/src/cli/hook.ts' }
const OLD = { bunPath: '/Users/dev/.bun/bin/bun', hookScript: '/Users/dev/old-checkout/src/cli/hook.ts' }
const OTHER_HOOK = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/other-tool', timeout: 5 }] }

const userSettings = () => ({
  theme: 'dark',
  env: { SOME_FLAG: '1' },
  hooks: { PostToolUse: [OTHER_HOOK], PreCompact: [{ hooks: [{ type: 'command', command: 'echo compact' }] }] },
})

test('our group has the shape .claude/settings.local.json proved live', () => {
  expect(samHookGroup('SessionStart', TARGET)).toEqual({ hooks: [{ type: 'command', command: TARGET.bunPath, args: [TARGET.hookScript], timeout: 10 }] })
  expect(samHookGroup('PostToolUseFailure', TARGET)).toEqual({
    matcher: '*',
    hooks: [{ type: 'command', command: TARGET.bunPath, args: [TARGET.hookScript], timeout: 10, async: true }],
  })
})

test('merge adds all six events and keeps every unrelated key and hook', () => {
  const merged = mergeSamHooks(userSettings(), TARGET)
  expect(merged.changed).toBe(true)
  expect(merged.added).toEqual([...CLAUDE_HOOK_EVENTS])
  const settings = merged.settings as { theme: string; env: unknown; hooks: Record<string, unknown[]> }
  expect(settings.theme).toBe('dark')
  expect(settings.env).toEqual({ SOME_FLAG: '1' })
  expect(settings.hooks.PreCompact).toEqual(userSettings().hooks.PreCompact)
  expect(settings.hooks.PostToolUse).toEqual([OTHER_HOOK, samHookGroup('PostToolUse', TARGET)])
  expect(inspectSamHooks(merged.settings, TARGET.hookScript)).toBe('yes')
})

test('a re-run changes nothing and returns the same object', () => {
  const once = mergeSamHooks(userSettings(), TARGET).settings
  const twice = mergeSamHooks(once, TARGET)
  expect(twice.changed).toBe(false)
  expect(twice.settings).toBe(once)
  expect(JSON.stringify(twice.settings)).toBe(JSON.stringify(once))
})

test('a moved checkout replaces the stale path instead of adding a second entry', () => {
  const stale = mergeSamHooks(userSettings(), OLD).settings
  expect(inspectSamHooks(stale, TARGET.hookScript)).toBe('stale')
  const fixed = mergeSamHooks(stale, TARGET)
  expect(fixed.replaced).toEqual([...CLAUDE_HOOK_EVENTS])
  const hooks = (fixed.settings as { hooks: Record<string, unknown[]> }).hooks
  for (const event of CLAUDE_HOOK_EVENTS) {
    const scripts = JSON.stringify(hooks[event])
    expect(scripts).toContain(TARGET.hookScript)
    expect(scripts).not.toContain(OLD.hookScript)
  }
  expect(hooks.PostToolUse).toEqual([OTHER_HOOK, samHookGroup('PostToolUse', TARGET)])
})

test('our entry sharing a group with someone else\'s keeps their entry on replace and remove', () => {
  const shared = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }, { type: 'command', command: OLD.bunPath, args: [OLD.hookScript], timeout: 10 }] }] } }
  const merged = mergeSamHooks(shared, TARGET).settings as { hooks: { Stop: unknown[] } }
  expect(merged.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'say done' }] }, samHookGroup('Stop', TARGET)])
  const removed = removeSamHooks(merged)
  expect(removed.removed).toBe(6)
  expect(removed.settings).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } })
})

test('remove takes out only ours; lists and the hooks object go only when we emptied them', () => {
  const merged = mergeSamHooks(userSettings(), TARGET).settings
  expect(removeSamHooks(merged)).toEqual({ settings: userSettings(), removed: 6 })
  expect(removeSamHooks(mergeSamHooks({ theme: 'x' }, TARGET).settings)).toEqual({ settings: { theme: 'x' }, removed: 6 })
  const untouched = userSettings()
  expect(removeSamHooks(untouched).settings).toBe(untouched)
})

test('ours is recognised by the bun + hook.ts path, including the older command-string form', () => {
  expect(samHookScript({ type: 'command', command: '/x/bun', args: ['/a/src/cli/hook.ts'] })).toBe('/a/src/cli/hook.ts')
  expect(samHookScript({ type: 'command', command: 'bun /a/src/cli/hook.ts' })).toBe('/a/src/cli/hook.ts')
  expect(samHookScript({ type: 'command', command: '/x/node', args: ['/a/src/cli/hook.ts'] })).toBeNull()
  expect(samHookScript({ type: 'command', command: 'node /plugin/scripts/hook.js' })).toBeNull()
  expect(inspectSamHooks({ hooks: { Stop: [samHookGroup('Stop', TARGET)] } }, TARGET.hookScript)).toBe('partial')
  expect(inspectSamHooks({}, TARGET.hookScript)).toBe('no')
})

test('a hooks value of the wrong shape is an error, never overwritten', () => {
  expect(() => mergeSamHooks({ hooks: [] }, TARGET)).toThrow('"hooks" is not an object')
  expect(() => mergeSamHooks({ hooks: { Stop: {} } }, TARGET)).toThrow('hooks.Stop is not a list')
})
