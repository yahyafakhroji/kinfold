import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KNOWN_HOSTS } from '../../../system/contract/event'
import { EXIT_OK } from '../../install/install'
import { BUN, type FakeWorld, snapshotTree } from '../install/test-support'
import { wslInstall, wslStatus, wslUninstall } from '../../wsl/entry'
import { WSL_HOME_DIR } from '../../wsl/link'
import { type Stand, mentions, stand, wslProgram } from './test-support'

const worlds: FakeWorld[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup()
})

/** Files under home that differ between two snapshots, outside ~/.kinfold-wsl. */
function changed(before: ReturnType<typeof snapshotTree>, after: ReturnType<typeof snapshotTree>): string[] {
  return Object.keys(after).filter((path) => after[path]?.sha !== null && after[path]?.sha !== before[path]?.sha && !path.startsWith(WSL_HOME_DIR))
}

/** Everything the install handed the agent: the files it wrote and the commands it ran. */
function wiringText(s: Stand, files: readonly string[]): string {
  const written = files.map((path) => readFileSync(join(s.world.home, path), 'utf8'))
  const commands = s.world.commands.map((request) => request.argv.join(' '))
  return [...written, ...commands].join('\n')
}

describe.each([...KNOWN_HOSTS])('%s in a linked WSL distro', (id) => {
  test('install wires it to the WSL program and the Windows folder, and uninstall takes out only that', async () => {
    const s = stand({ hosts: [id] })
    worlds.push(s.world)
    const before = snapshotTree(s.world.home)
    expect(await wslInstall(s.env, s.options)).toBe(EXIT_OK)
    const files = changed(before, snapshotTree(s.world.home))
    const text = wiringText(s, files)
    // Continue's YAML config is wired by hand, so it writes nothing; every other agent names the program and the folder.
    if (id === 'continue') expect(files).toEqual([])
    else {
      expect(mentions(text, wslProgram(s))).toBe(true)
      expect(mentions(text, s.dataDir)).toBe(true)
    }
    // Never the plain Linux memory, the checkout or bun: those would make a second, separate memory.
    expect(mentions(text, s.world.dataDir)).toBe(false)
    expect(mentions(text, BUN)).toBe(false)
    expect(mentions(text, s.world.projectRoot)).toBe(false)
    expect(s.world.out.some((line) => line.includes(`wired ${id} to the Windows memory`))).toBe(true)
    const status = (await wslStatus(s.env))?.lines ?? []
    const row = status.find((line) => line.startsWith(`  ${id}:`)) ?? ''
    // Each part reads "hooks yes", "MCP yes", "plugin yes" and so on; none may be missing or stale.
    if (files.length > 0) {
      expect(row).toMatch(/\b(wired:|hooks|plugin|MCP|toast) yes\b/)
      // A Windows test host has no exec bits, so Cline's executable hook files read stale there; a distro's disk has them.
      const unset = process.platform === 'win32' && id === 'cline' ? /\b(wired:|MCP|toast) (no|stale|partial|unknown)\b/ : /\b(wired:|hooks|plugin|MCP|toast) (no|stale|partial|unknown)\b/
      expect(row).not.toMatch(unset)
    }

    const windows = snapshotTree(s.driveC)
    expect(await wslUninstall(s.env, { dryRun: false, removeCredentials: true, removeHmacKeys: true })).toBe(EXIT_OK)
    expect(snapshotTree(s.driveC)).toEqual(windows)
    for (const path of files) {
      let left = ''
      try {
        left = readFileSync(join(s.world.home, path), 'utf8')
      } catch {
        continue
      }
      expect({ path, left: mentions(left, wslProgram(s)) || mentions(left, s.dataDir) }).toEqual({ path, left: false })
    }
  })
})
