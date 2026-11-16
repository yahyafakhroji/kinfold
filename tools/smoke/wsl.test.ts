import { describe, expect, test } from 'bun:test'
import { NOT_LINKED_LINE, unreachableRefusal } from '../../src/wsl/entry'
import { SmokeError } from './platform'
import { distroArgv, expectNatRefusal, expectNotLinked, hookPayload, sessionEventCount } from './wsl'

const ok = (stdout: string, code = 0): { code: number; stdout: string; stderr: string } => ({ code, stdout, stderr: '' })

function stepOf(run: () => void): string | null {
  try {
    run()
  } catch (error: unknown) {
    return error instanceof SmokeError ? error.step : 'not a SmokeError'
  }
  return null
}

describe('distroArgv', () => {
  test('runs the command as root in the named distro with HOME set, and with no shell, so a Windows path keeps its backslashes', () => {
    expect(distroArgv('Ubuntu-24.04', ['wslpath', '-u', 'D:\\a\\dist'])).toEqual(['wsl.exe', '-d', 'Ubuntu-24.04', '-u', 'root', '--exec', 'env', 'HOME=/root', 'wslpath', '-u', 'D:\\a\\dist'])
  })
})

describe('expectNotLinked', () => {
  test('passes on the not-linked line and fails without it', () => {
    expect(stepOf(() => expectNotLinked(ok(`${NOT_LINKED_LINE}\nhosts:\n`)))).toBeNull()
    expect(stepOf(() => expectNotLinked(ok('hosts:\n')))).toBe('wsl status')
  })
})

describe('expectNatRefusal', () => {
  test('needs a failed exit and the unreachable refusal with the mirrored advice', () => {
    expect(stepOf(() => expectNatRefusal(ok(`${unreachableRefusal(37_811)}\n`, 1), 37_811))).toBeNull()
    // Exit 0 means the distro linked, which NAT must never allow.
    expect(stepOf(() => expectNatRefusal(ok(`${unreachableRefusal(37_811)}\n`, 0), 37_811))).toBe('wsl install')
    // A refusal for another reason is not the NAT one.
    expect(stepOf(() => expectNatRefusal(ok('WSL (preview): no Windows install found (x)\n', 1), 37_811))).toBe('wsl install')
  })
})

describe('sessionEventCount', () => {
  test('reads the event count of the session with that host session id', () => {
    const body = { sessions: [{ hostSessionId: 'other', eventCount: 4 }, { hostSessionId: 'wsl-abc', eventCount: 1 }] }
    expect(sessionEventCount(body, 'wsl-abc')).toBe(1)
    expect(sessionEventCount(body, 'missing')).toBeNull()
    expect(sessionEventCount({ nope: true }, 'wsl-abc')).toBeNull()
  })
})

describe('hookPayload', () => {
  test('is a Claude Code Stop payload whose session id carries the marker', () => {
    const payload = JSON.parse(hookPayload('abc')) as Record<string, unknown>
    expect(payload).toMatchObject({ session_id: 'wsl-abc', hook_event_name: 'Stop', cwd: '/root' })
    expect(String(payload.last_assistant_message)).toContain('abc')
  })
})
