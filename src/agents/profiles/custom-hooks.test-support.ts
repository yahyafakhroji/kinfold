// Shared set-up for the Cline, Kiro, Amp and Kimi Code profile tests: a temp
// data folder with a daemon that always has context to give, and the hook run
// on a fixture moved into the temp root.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHook } from '../../cli/hook'
import type { ContextRequest } from '../../context/types'
import type { Action } from '../../install/plan'
import { type FakeWorld, createWorld } from '../../install/test-support'
import { profileOf } from '../install-profiles'
import type { AgentId, AgentProfile } from '../profile'

const FIXTURES = join(import.meta.dir, '../../../test/fixtures')

export interface HookBench {
  root: string
  dataDir: string
  asked: ContextRequest[]
  /** Runs the hook on a fixture, with `move` putting the temp root where the payload names its folder. */
  hook(host: AgentId, file: string, move: (raw: Record<string, unknown>, root: string) => Record<string, unknown>): Promise<string | null>
  world(platform?: NodeJS.Platform): FakeWorld
  cleanup(): Promise<void>
}

export function hookBench(): HookBench {
  const root = mkdtempSync(join(tmpdir(), 'kinfold-custom-hooks-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: 4 }))
  writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
  const asked: ContextRequest[] = []
  const worlds: FakeWorld[] = []
  return {
    root,
    dataDir,
    asked,
    hook: (host, file, move) => {
      const raw = JSON.parse(readFileSync(join(FIXTURES, host, file), 'utf8')) as Record<string, unknown>
      const fetchFake = async (_url: string, init: RequestInit): Promise<Response> => {
        asked.push(JSON.parse(String(init.body)) as ContextRequest)
        return new Response(JSON.stringify({ text: '<kinfold>pack</kinfold>', observationIds: [], tokens: 5 }))
      }
      return runHook(JSON.stringify(move(raw, root)), dataDir, () => undefined, {}, { fetch: fetchFake, fallback: false }, host)
    },
    world: (platform) => {
      const w = createWorld(platform !== undefined ? { platform } : {})
      worlds.push(w)
      return w
    },
    cleanup: async () => {
      rmSync(root, { recursive: true, force: true })
      for (const w of worlds) await w.cleanup()
    },
  }
}

export function profile(id: AgentId): AgentProfile {
  return profileOf(id)
}

export const writesOf = (actions: readonly Action[]): string[] => actions.flatMap((action) => (action.kind === 'write' ? [action.path] : []))

/** Applies an install or uninstall plan's file steps. */
export function apply(actions: readonly Action[]): void {
  for (const action of actions) {
    if (action.kind === 'mkdir') mkdirSync(action.path, { recursive: true })
    if (action.kind === 'write') writeFileSync(action.path, action.content, { mode: action.mode })
    if (action.kind === 'remove') rmSync(action.path, { force: true })
  }
}
