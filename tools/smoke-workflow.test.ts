// Reads the workflow YAML as text: the checks are about which lines exist, and
// a text read keeps a YAML parser out of the dev dependencies.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WORKFLOWS = join(import.meta.dir, '..', '.github', 'workflows')

function workflow(name: string): string {
  return readFileSync(join(WORKFLOWS, name), 'utf8')
}

function values(text: string, key: string): string[] {
  const pattern = new RegExp(`^\\s*(?:- )?${key}:\\s*(\\S+)\\s*$`, 'gm')
  return [...text.matchAll(pattern)].map((match) => match[1] ?? '')
}

describe('smoke workflow', () => {
  test('the smoke matrix covers every release target', () => {
    const smokeTargets = values(workflow('smoke.yml'), 'target')
    const releaseTargets = values(workflow('release-build.yml'), 'target')
    expect(smokeTargets.length).toBeGreaterThan(0)
    expect([...smokeTargets].sort()).toEqual([...releaseTargets].sort())
    const smokes = values(workflow('smoke.yml'), 'smoke')
    expect(smokes.length).toBe(smokeTargets.length)
    for (const smoke of smokes) expect(['macos', 'linux', 'windows']).toContain(smoke)
  })

  test('every smoke step after the gate is gated', () => {
    const text = workflow('smoke.yml')
    const gate = text.indexOf('id: gate')
    expect(gate).toBeGreaterThan(-1)
    // The first piece is the rest of the gate step itself.
    const blocks = text.slice(gate).split(/^\s*- name:/m).slice(1)
    expect(blocks.length).toBeGreaterThan(0)
    for (const block of blocks) {
      expect(block).toContain("steps.gate.outputs.enabled == 'true'")
      expect(block).not.toContain('security ')
      expect(block).not.toContain('brew ')
    }
  })

  test('the sums URL comes from pathToFileURL, not file://$PWD', () => {
    const text = workflow('smoke.yml')
    expect(text).toContain('bun tools/smoke-sums-url.ts dist/SHA256SUMS')
    expect(text).not.toContain('file://$PWD')
  })
})

describe('ci workflow', () => {
  test('ci gates each OS on its required flag', () => {
    const text = workflow('ci.yml')
    const lines = text.split('\n')
    const gates = lines.filter((line) => line.trim() === 'continue-on-error: ${{ !matrix.required }}')
    expect(lines.filter((line) => line.trim() === 'runs-on: ${{ matrix.os }}').length).toBe(1)
    expect(gates.length).toBe(1)
    let entries = 0
    lines.forEach((line, index) => {
      const entry = /^\s*- os:\s*(\S+)\s*$/.exec(line)
      if (entry === null) return
      entries += 1
      const required = /^\s*required:\s*(\S+)\s*$/.exec(lines[index + 1] ?? '')
      expect(required).not.toBeNull()
      if (entry[1]?.startsWith('macos')) expect(required?.[1]).toBe('true')
    })
    expect(entries).toBe(3)
  })

  test('types runs once, on Linux, under the check name types', () => {
    const text = workflow('ci.yml')
    const types = text.slice(text.indexOf('\n  types:'), text.indexOf('\n  changeset:'))
    expect(types).toContain('    name: types\n')
    expect(types).toContain('    runs-on: ubuntu-latest\n')
    expect(types).not.toContain('matrix')
  })

  test('a new push to a pull request cancels its running ci; pushes to main never do', () => {
    const text = workflow('ci.yml')
    expect(text).toContain("concurrency:\n  group: ci-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n")
  })

  test('the test job restores sqlite3mc from a cache keyed on what builds it, and builds only on a miss', () => {
    const text = workflow('ci.yml')
    expect(text).toContain('path: .cache/sqlite3mc')
    expect(text).toContain("key: sqlite3mc-${{ runner.os }}-${{ hashFiles('src/sqlite/release.ts', 'src/sqlite/build.ts', 'tools/build-sqlite3mc.ts', 'tools/pinned-download.ts') }}")
    expect(text).toMatch(/- name: Build sqlite3mc for the test preload\n {8}if: steps\.sqlite3mc\.outputs\.cache-hit != 'true'/)
  })
})
