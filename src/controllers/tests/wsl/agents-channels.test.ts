import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOOK_SPECS } from '../../../plugins/agents/hook-specs'
import { profileOf } from '../../../plugins/agents/install-profiles'
import type { AgentId } from '../../../plugins/agents/profile'
import { kiloTuiPath } from '../../../plugins/agents/families/kilo-tui'
import { opencodeTuiDir } from '../../../plugins/agents/families/opencode-tui'
import { runHook } from '../../cli/hook'
import { KNOWN_HOSTS } from '../../../system/contract/event'
import type { FakeWorld } from '../install/test-support'
import { PORT, type Stand, linkedStand, mentions, wslProgram } from './test-support'

const FIXTURES = join(import.meta.dir, '../../../../test/fixtures')
const TOKEN = 'a'.repeat(64)

const worlds: FakeWorld[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup()
})

async function linkedFor(id: AgentId): Promise<Stand> {
  const s = await linkedStand({ hosts: [id] })
  worlds.push(s.world)
  writeFileSync(join(s.dataDir, 'daemon.token'), TOKEN)
  // A Linux daemon of the distro's own on another port: a hook that read the plain Linux folder would ask it.
  mkdirSync(s.world.dataDir, { recursive: true })
  writeFileSync(join(s.world.dataDir, 'daemon.json'), JSON.stringify({ pid: 2, port: PORT + 1 }))
  writeFileSync(join(s.world.dataDir, 'daemon.token'), TOKEN)
  return s
}

const spooled = (s: Stand): string[] => {
  const dir = join(s.dataDir, 'spool')
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []
}

/** Agents whose hooks run `kinfold hook`; each has recorded payloads to run them on. */
const HOOKED = KNOWN_HOSTS.filter((id) => HOOK_SPECS[id] !== null)

test('every agent with hooks has recorded payloads, so none drops out of the WSL hook runs', () => {
  expect(HOOKED.filter((id) => !existsSync(join(FIXTURES, id)))).toEqual([])
})

describe.each(HOOKED)('%s hooks in a linked WSL distro', (id) => {
  test('recorded payloads spool into the folder the wired hook names, the Windows one, and context is asked of the Windows daemon only', async () => {
    const s = await linkedFor(id)
    const wired = s.world.commands.map((request) => request.argv.join(' '))
    const files = readdirSync(s.world.home, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && !entry.parentPath.includes('.kinfold'))
    const texts = [...files.map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8')), ...wired]
    // Of the Windows folder and the distro's own Linux one, the wiring must name the Windows folder alone.
    const named = [s.dataDir, s.world.dataDir].filter((dir) => texts.some((text) => mentions(text, dir)))
    expect(named).toEqual([s.dataDir])
    const dataDir = named[0]
    const asked: string[] = []
    const fetch = async (url: string): Promise<Response> => {
      asked.push(url)
      return Response.json({ text: '<kinfold>pack</kinfold>', observationIds: [], tokens: 5 })
    }
    const outputs: (string | null)[] = []
    for (const file of readdirSync(join(FIXTURES, id)).filter((name) => name.endsWith('.json')).sort()) {
      const input = readFileSync(join(FIXTURES, id, file), 'utf8')
      outputs.push(await runHook(input, dataDir ?? '', () => undefined, { NODE_ENV: 'test', HOME: s.world.home }, { fetch, fallback: false }, id))
    }
    expect(spooled(s).length).toBeGreaterThan(0)
    // The port the Windows daemon wrote to daemon.json in the Windows folder, never a Linux daemon's.
    for (const url of asked) expect(new URL(url)).toMatchObject({ hostname: '127.0.0.1', port: String(PORT) })
    const caps = profileOf(id).capabilities('linux')
    if (caps.context.sessionStart || caps.context.prompt) {
      expect(asked.length).toBeGreaterThan(0)
      expect(outputs.some((output) => output?.includes('<kinfold>pack</kinfold>') === true)).toBe(true)
    }
  })
})

describe('visible memory in a linked WSL distro', () => {
  test('Claude Code shows the recall line from the Windows daemon as a systemMessage', async () => {
    const s = await linkedFor('claude-code')
    const asked: string[] = []
    const fetch = async (url: string): Promise<Response> => (asked.push(url), Response.json({ text: '<kinfold>pack</kinfold>', observationIds: [1, 2], tokens: 5 }))
    const input = readFileSync(join(FIXTURES, 'claude-code', 'session-start.json'), 'utf8')
    const output = await runHook(input, s.dataDir, () => undefined, { NODE_ENV: 'test', HOME: s.world.home }, { fetch, fallback: false })
    const message = (JSON.parse(output ?? '{}') as { systemMessage?: string }).systemMessage ?? ''
    expect(message).toMatch(/^kinfold · /)
    expect(asked.map((url) => new URL(url).port)).toEqual([String(PORT)])
  })

  test('Copilot puts the progress line in front of what it prints', async () => {
    const s = await linkedFor('copilot')
    const fetch = async (): Promise<Response> => Response.json({ text: '<kinfold>pack</kinfold>', observationIds: [1], tokens: 5 })
    const input = readFileSync(join(FIXTURES, 'copilot', 'docs-constructed-user-prompt-submit.json'), 'utf8')
    const output = await runHook(input, s.dataDir, () => undefined, { NODE_ENV: 'test', HOME: s.world.home }, { fetch, fallback: false }, 'copilot')
    // The progress line is a JSON object of its own on the first line, then the normal output.
    const first = JSON.parse((output ?? '').split('\n')[0] ?? '{}') as Record<string, unknown>
    expect(first.type).toBe('progress')
    expect(String(first.message)).toMatch(/^kinfold · /)
  })

  test('the OpenCode plugin and its recall toast read the Windows folder', async () => {
    const s = await linkedFor('opencode')
    const plugin = readFileSync(join(s.world.home, '.config', 'opencode', 'plugins', 'kinfold.js'), 'utf8')
    expect(plugin).toContain(`KINFOLD_DATA_DIR = ${JSON.stringify(s.dataDir)}`)
    const tui = readFileSync(join(opencodeTuiDir({ ...s.env, dataDir: s.dataDir }), 'tui.js'), 'utf8')
    expect(tui).toContain(`const DATA_DIR = ${JSON.stringify(s.dataDir)};`)
  })

  test('the Kilo Code plugin and its recall toast read the Windows folder', async () => {
    const s = await linkedFor('kilo-code')
    const plugin = readFileSync(join(s.world.home, '.config', 'kilo', 'plugin', 'kinfold.js'), 'utf8')
    expect(plugin).toContain(`KINFOLD_DATA_DIR = ${JSON.stringify(s.dataDir)}`)
    const tui = readFileSync(kiloTuiPath({ ...s.env, dataDir: s.dataDir }), 'utf8')
    expect(tui).toContain(`const DATA_DIR = ${JSON.stringify(s.dataDir)};`)
  })

  test('the Amp plugin runs the WSL program on the Windows folder', async () => {
    const s = await linkedFor('amp')
    const plugin = readFileSync(join(s.world.home, '.config', 'amp', 'plugins', 'kinfold.ts'), 'utf8')
    expect(plugin).toContain(JSON.stringify(wslProgram(s)))
    expect(plugin).toContain(JSON.stringify(s.dataDir))
  })
})
