import { describe, expect, test } from 'bun:test'
import { KNOWN_HOSTS } from '../contract/event'
import { type AgentProfile, type Capabilities, capabilityLine, verificationNote } from './profile'

const IDS = [
  'claude-code', 'opencode', 'codex', 'cursor', 'gemini-cli', 'qwen-code', 'factory-droid', 'devin',
  'kilo-code', 'cline', 'copilot', 'antigravity', 'junie', 'kiro', 'amp', 'kimi-code', 'auggie',
  'goose', 'crush', 'zed', 'continue', 'warp',
]

function profile(name: string, caps: Capabilities, limit: string | null = null): AgentProfile {
  return {
    id: 'zed',
    name,
    family: 'mcp-only',
    verification: 'docs',
    capabilities: () => caps,
    limit: () => limit,
    detection: { binaries: [] },
    wiring: { install: async () => [], uninstall: () => [], state: () => 'unknown', line: () => '' },
    manualSteps: () => [],
  }
}

describe('agent ids', () => {
  test('KNOWN_HOSTS lists the 22 agent ids in the plan order', () => {
    expect([...KNOWN_HOSTS] as string[]).toEqual(IDS)
  })
})

describe('capabilityLine', () => {
  test('says "captures, context at start and on each prompt, search" for full Claude-style capabilities', () => {
    const p = profile('Claude Code', { capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: true })
    expect(capabilityLine(p, 'macos')).toBe('captures, context at start and on each prompt, search')
  })

  test('says "search only (Zed has no hooks)" when capture is none and limit gives the reason', () => {
    const p = profile('Zed', { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }, 'Zed has no hooks')
    expect(capabilityLine(p, 'macos')).toBe('search only (Zed has no hooks)')
  })

  test('is the limit alone when nothing is captured or searched', () => {
    const p = profile('Continue', { capture: 'none', context: { sessionStart: false, prompt: false }, search: false, observer: false }, 'search needs a step by hand')
    expect(capabilityLine(p, 'macos')).toBe('search needs a step by hand')
    expect(capabilityLine(profile('Y', { capture: 'none', context: { sessionStart: false, prompt: false }, search: false, observer: false }), 'macos')).toBe('nothing wired')
  })

  test('says "captures tool results only, search" for partial capture with no context', () => {
    const p = profile('X', { capture: 'partial', context: { sessionStart: false, prompt: false }, search: true, observer: true })
    expect(capabilityLine(p, 'linux')).toBe('captures tool results only, search')
  })
})

describe('verificationNote', () => {
  test('docs has a note and live has none', () => {
    expect(verificationNote('docs')).toBe('built from the docs, not yet checked against a real run')
    expect(verificationNote('live')).toBeNull()
  })
})
