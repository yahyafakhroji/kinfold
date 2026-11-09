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
    expect(lines.filter((line) => line.trim().startsWith('runs-on:')).length).toBe(2)
    expect(gates.length).toBe(2)
    let entries = 0
    lines.forEach((line, index) => {
      const entry = /^\s*- os:\s*(\S+)\s*$/.exec(line)
      if (entry === null) return
      entries += 1
      const required = /^\s*required:\s*(\S+)\s*$/.exec(lines[index + 1] ?? '')
      expect(required).not.toBeNull()
      if (entry[1]?.startsWith('macos')) expect(required?.[1]).toBe('true')
    })
    expect(entries).toBe(6)
  })
})
