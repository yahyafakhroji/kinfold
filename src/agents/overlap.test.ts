import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHook } from '../cli/hook'
import type { ContextRequest } from '../context/types'
import { agentWiringActions } from '../install/install'
import type { Action } from '../install/plan'
import { hostStatusLines } from '../install/status'
import { type FakeWorld, createWorld } from '../install/test-support'
import { HOOK_SPECS } from './hook-specs'
import { INSTALL_PROFILES, overlapPlan, overlapState } from './install-profiles'
import type { AgentProfile } from './profile'
import { DEVIN_PROFILE } from './profiles/devin'

const FIXTURES = join(import.meta.dir, '../../test/fixtures')

let worlds: FakeWorld[] = []
let roots: string[] = []
afterEach(async () => {
  for (const w of worlds) await w.cleanup()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  worlds = []
  roots = []
})

const world = (): FakeWorld => {
  const w = createWorld({ claudeVersion: '2.1.310 (Claude Code)' })
  worlds.push(w)
  return w
}
const apply = (actions: readonly Action[]): void => {
  for (const a of actions) {
    if (a.kind === 'mkdir') mkdirSync(a.path, { recursive: true })
    if (a.kind === 'write') writeFileSync(a.path, a.content)
  }
}
const writes = (actions: readonly Action[]): string[] => actions.flatMap((a) => (a.kind === 'write' ? [a.path] : []))
const devinConfig = (w: FakeWorld): string => join(w.env.homeDir, '.config', 'devin', 'config.json')
const devinMcp = (w: FakeWorld): string => join(w.env.homeDir, '.config', 'devin', 'mcp_config.json')

/** Devin found by its binary, without a real `devin --version`. */
const DETECTED_DEVIN: AgentProfile = { ...DEVIN_PROFILE, detection: async () => ({ host: 'devin', selected: true, version: null, note: 'devin answered --version' }) }
const PROFILES = { ...INSTALL_PROFILES, devin: DETECTED_DEVIN }

test('an agent that fires Claude Code\'s hooks gets no second hook entry when Claude Code is wired', async () => {
  expect(overlapPlan(['claude-code', 'devin']).skip).toEqual(['devin'])
  const w = world()
  const actions = await agentWiringActions(w.env, ['claude-code', 'devin'])
  expect(writes(actions)).not.toContain(devinConfig(w))
  expect(writes(actions)).toContain(devinMcp(w))
  expect(writes(actions).some((path) => path.endsWith(join('.claude', 'settings.json')))).toBe(true)
})

test('with Claude Code not selected, the agent gets its own entry', async () => {
  expect(overlapPlan(['devin', 'codex'])).toEqual({ skip: [], notes: {} })
  const w = world()
  const actions = await agentWiringActions(w.env, ['devin'])
  expect(writes(actions)).toEqual([devinConfig(w), devinMcp(w)])
  apply(actions)
  expect(readFileSync(devinConfig(w), 'utf8')).toContain('--host devin')
})

test('a re-run removes the agent\'s own hooks once Claude Code is wired, and a third run plans nothing for it', async () => {
  const w = world()
  mkdirSync(join(w.env.homeDir, '.config', 'devin'), { recursive: true })
  writeFileSync(devinConfig(w), `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`)
  apply(await agentWiringActions(w.env, ['devin']))
  expect(readFileSync(devinConfig(w), 'utf8')).toContain('--host devin')
  const second = await agentWiringActions(w.env, ['claude-code', 'devin'])
  expect(writes(second)).toContain(devinConfig(w))
  apply(second)
  expect(readFileSync(devinConfig(w), 'utf8')).not.toContain('--host devin')
  expect(JSON.parse(readFileSync(devinConfig(w), 'utf8')).theme).toBe('dark')
  expect(readFileSync(devinMcp(w), 'utf8')).toContain('devin')
  const third = await agentWiringActions(w.env, ['claude-code', 'devin'])
  expect(writes(third).filter((path) => path.includes(join('.config', 'devin')))).toEqual([])
})

/** Runs the Claude Code hook on Devin's prompt payload with `env`; returns the host the context was asked for and the spooled event's host. */
async function claudeHookOnDevinPayload(env: Readonly<Record<string, string | undefined>>): Promise<{ asked: string | undefined; spooled: string | undefined }> {
  const root = mkdtempSync(join(tmpdir(), 'kinfold-overlap-'))
  roots.push(root)
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: 4 }))
  writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
  const raw = JSON.parse(readFileSync(join(FIXTURES, 'devin', 'docs-constructed-user-prompt-submit.json'), 'utf8')) as Record<string, unknown>
  const asked: ContextRequest[] = []
  const fetchFake = async (_url: string, init: RequestInit): Promise<Response> => {
    asked.push(JSON.parse(String(init.body)) as ContextRequest)
    return new Response(JSON.stringify({ text: '', observationIds: [], tokens: 0 }))
  }
  await runHook(JSON.stringify({ ...raw, cwd: root }), dataDir, () => undefined, env, { fetch: fetchFake, fallback: false }, 'claude-code')
  const spooled = readdirSync(dataDir, { recursive: true, encoding: 'utf8' })
    .map((name) => join(dataDir, name))
    .filter((path) => path.endsWith('.json') && !path.endsWith('daemon.json') && existsSync(path))
    .flatMap((path) => {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { host?: string }
        return parsed.host !== undefined ? [parsed.host] : []
      } catch {
        return readFileSync(path, 'utf8').includes('"host":"devin"') ? ['devin'] : []
      }
    })
  return { asked: asked[0]?.host, spooled: spooled[0] }
}

test('its events are relabelled when callerOf recognises its payload', async () => {
  const callerOf = HOOK_SPECS['claude-code']?.callerOf
  expect(callerOf?.({ session_id: 's' }, { DEVIN_PROJECT_DIR: '/work/app' })).toBe('devin')
  const seen = await claudeHookOnDevinPayload({ DEVIN_PROJECT_DIR: '/work/app' })
  expect(seen.asked).toBe('devin')
  expect(seen.spooled).toBe('devin')
})

test('callerOf never relabels without the signal', async () => {
  const callerOf = HOOK_SPECS['claude-code']?.callerOf
  expect(callerOf?.({ session_id: 's', prompt_id: 'p', hook_event_name: 'UserPromptSubmit' }, {})).toBeNull()
  expect(callerOf?.({ session_id: 's' }, { DEVIN_PROJECT_DIR: '' })).toBeNull()
  expect(callerOf?.(null, { CLAUDE_PROJECT_DIR: '/work/app' })).toBeNull()
  const seen = await claudeHookOnDevinPayload({})
  expect(seen.asked).toBe('claude-code')
  expect(seen.spooled).toBe('claude-code')
})

test('status says the agent\'s events are recorded as Claude Code\'s when no caller signal exists', async () => {
  const w = world()
  apply(await agentWiringActions(w.env, ['claude-code', 'devin']))
  const { callerOf: _none, ...claudeWithoutCaller } = HOOK_SPECS['claude-code'] ?? {}
  const specs = { ...HOOK_SPECS, 'claude-code': claudeWithoutCaller as NonNullable<(typeof HOOK_SPECS)['claude-code']> }
  expect(overlapPlan(['claude-code'], undefined, PROFILES, specs).notes.devin).toContain('recorded as Claude Code\'s')
  const lines = await hostStatusLines(w.env, PROFILES, specs)
  const at = lines.findIndex((line) => line.startsWith('  devin:'))
  expect(at).toBeGreaterThan(-1)
  expect(lines[at + 1]).toStartWith('    ')
  expect(lines[at + 1]).toContain('events are recorded as Claude Code\'s')
  const withCaller = await hostStatusLines(w.env, PROFILES)
  const note = withCaller[withCaller.findIndex((line) => line.startsWith('  devin:')) + 1]
  expect(note).toContain('DEVIN_PROJECT_DIR')
})

test('status prints no overlap note while Claude Code is not wired', async () => {
  const w = world()
  apply(await agentWiringActions(w.env, ['devin']))
  const lines = await hostStatusLines(w.env, PROFILES)
  const at = lines.findIndex((line) => line.startsWith('  devin:'))
  expect(lines[at + 1] ?? '').not.toContain('Claude Code\'s hooks')
})

test('an agent wired without hooks of its own still counts as wired, so a re-run keeps it ticked', async () => {
  const w = world()
  apply(await agentWiringActions(w.env, ['claude-code', 'devin']))
  expect(DEVIN_PROFILE.wiring.state(w.env)).toBe('no')
  expect(overlapState(w.env, DEVIN_PROFILE)).toBe('yes')
  expect(w.out).toContain('devin: Devin runs Claude Code\'s hooks, so it has no hook entry of its own; its events are recorded as Devin\'s when it sets DEVIN_PROJECT_DIR for the hook, otherwise as Claude Code\'s; Devin records through Claude Code\'s hook entries only if it passes their args (Devin\'s docs list matcher, type, command and timeout only), unverified until a live run; keep read_config_from.claude on in Devin (the default), or Devin records nothing')
})

test('a recorded Claude Code payload stays Claude Code\'s even with DEVIN_PROJECT_DIR inherited', async () => {
  const claudePayload = JSON.parse(readFileSync(join(FIXTURES, 'claude-code', 'user-prompt-submit.json'), 'utf8')) as Record<string, unknown>
  expect(typeof claudePayload.transcript_path).toBe('string')
  const callerOf = HOOK_SPECS['claude-code']?.callerOf
  expect(callerOf?.(claudePayload, { DEVIN_PROJECT_DIR: '/work/app' })).toBeNull()
  const devinPayload = JSON.parse(readFileSync(join(FIXTURES, 'devin', 'docs-constructed-user-prompt-submit.json'), 'utf8')) as Record<string, unknown>
  expect(callerOf?.(devinPayload, { DEVIN_PROJECT_DIR: '/work/app' })).toBe('devin')
})

const writeDevinConfig = (w: FakeWorld, text: string): void => {
  mkdirSync(join(w.env.homeDir, '.config', 'devin'), { recursive: true })
  writeFileSync(devinConfig(w), text)
}

test('with read_config_from.claude false, Devin keeps hooks of its own even with Claude Code wired', async () => {
  const w = world()
  writeDevinConfig(w, `${JSON.stringify({ read_config_from: { claude: false } }, null, 2)}\n`)
  const plan = overlapPlan(['claude-code', 'devin'], w.env)
  expect(plan.skip).toEqual([])
  expect(plan.notes.devin).toContain('read_config_from.claude is false')
  expect(plan.notes.devin).toContain('keeps hooks of its own')
  const actions = await agentWiringActions(w.env, ['claude-code', 'devin'])
  expect(writes(actions)).toContain(devinConfig(w))
  apply(actions)
  expect(readFileSync(devinConfig(w), 'utf8')).toContain('--host devin')
  expect(overlapState(w.env, DEVIN_PROFILE)).toBe('yes')
})

test('with read_config_from.claude absent, Devin is skipped and the note says to keep it on', async () => {
  const w = world()
  writeDevinConfig(w, `${JSON.stringify({ read_config_from: { cursor: false } }, null, 2)}\n`)
  const plan = overlapPlan(['claude-code', 'devin'], w.env)
  expect(plan.skip).toEqual(['devin'])
  expect(plan.notes.devin).toContain('keep read_config_from.claude on in Devin (the default), or Devin records nothing')
  expect(writes(await agentWiringActions(w.env, ['claude-code', 'devin']))).not.toContain(devinConfig(w))
})

test('an unreadable Devin config counts as the default, and the note says the setting could not be read', () => {
  const w = world()
  writeDevinConfig(w, '{ // comment\n "read_config_from": { "claude": false } }\n')
  const plan = overlapPlan(['claude-code', 'devin'], w.env)
  expect(plan.skip).toEqual(['devin'])
  expect(plan.notes.devin).toContain('could not read read_config_from.claude')
})
