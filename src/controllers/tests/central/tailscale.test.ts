import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TAILSCALE_MISSING, TAILSCALE_STOPPED, type TailscaleRunner, cachedWhois, cliTailscale, firstLine, isLoopbackAddress, isTailscaleAddress, processRunner, sameOwner } from '../../central/tailscale'

const WHOIS = JSON.stringify({
  Node: { ID: 7, StableID: 'nLAPTOP1', Name: 'laptop.tail1234.ts.net.', Tags: null },
  UserProfile: { ID: 42, LoginName: 'me@example.com', DisplayName: 'Me' },
})
const TAGGED = JSON.stringify({
  Node: { ID: 9, StableID: 'nCI', Name: 'ci.tail1234.ts.net.', Tags: ['tag:ci'] },
  UserProfile: { ID: 99, LoginName: 'tagged-devices' },
})
const STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { ID: 'nHUB', HostName: 'mini', DNSName: 'mini.tail1234.ts.net.', UserID: 42, TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'] },
})

function runner(answers: Record<string, string | null>, calls: string[][] = []): TailscaleRunner {
  return async (args) => {
    calls.push([...args])
    const out = answers[args.join(' ')]
    return out === undefined || out === null ? { ok: false, problem: 'the tailscale command failed: exit code 1' } : { ok: true, stdout: out }
  }
}

test('Tailscale addresses are 100.64.0.0/10 and fd7a:115c:a1e0::/48 only', () => {
  expect(isTailscaleAddress('100.64.0.1')).toBe(true)
  expect(isTailscaleAddress('100.127.255.254')).toBe(true)
  expect(isTailscaleAddress('100.128.0.1')).toBe(false)
  expect(isTailscaleAddress('100.63.255.255')).toBe(false)
  expect(isTailscaleAddress('10.0.0.1')).toBe(false)
  expect(isTailscaleAddress('0.0.0.0')).toBe(false)
  expect(isTailscaleAddress('127.0.0.1')).toBe(false)
  expect(isTailscaleAddress('fd7a:115c:a1e0::1')).toBe(true)
  expect(isTailscaleAddress('fd7a:115c:a1e0:ab12:4843:cd96:6258:b240')).toBe(true)
  expect(isTailscaleAddress('fd7a:115c:a1e1::1')).toBe(false)
  expect(isTailscaleAddress('::')).toBe(false)
  expect(isTailscaleAddress('::ffff:100.64.0.1')).toBe(true)
  expect(isTailscaleAddress('100.64.0.1.evil')).toBe(false)
  expect(isLoopbackAddress('127.0.0.1')).toBe(true)
  expect(isLoopbackAddress('::1')).toBe(true)
  expect(isLoopbackAddress('100.64.0.1')).toBe(false)
})

test('whois reads the node and its owner', async () => {
  const calls: string[][] = []
  const tailscale = cliTailscale(runner({ 'whois --json 100.64.0.5': WHOIS }, calls))
  expect(await tailscale.whois('100.64.0.5')).toEqual({ userId: '42', loginName: 'me@example.com', nodeId: 'nLAPTOP1', nodeName: 'laptop', tags: [] })
  expect(calls).toEqual([['whois', '--json', '100.64.0.5']])
})

test('a tagged node keeps its tags, so it can be refused', async () => {
  const tailscale = cliTailscale(runner({ 'whois --json 100.64.0.9': TAGGED }))
  expect((await tailscale.whois('100.64.0.9'))?.tags).toEqual(['tag:ci'])
})

test('a lookup that fails, times out or prints nonsense is no identity', async () => {
  expect(await cliTailscale(runner({ 'whois --json 100.64.0.5': null })).whois('100.64.0.5')).toBeNull()
  expect(await cliTailscale(runner({ 'whois --json 100.64.0.5': '{"Node":{}}' })).whois('100.64.0.5')).toBeNull()
  expect(await cliTailscale(runner({ 'whois --json 100.64.0.5': 'not json' })).whois('100.64.0.5')).toBeNull()
  // Never passes an argument that could be read as a flag.
  const calls: string[][] = []
  expect(await cliTailscale(runner({}, calls)).whois('--help')).toBeNull()
  expect(calls).toEqual([])
})

test('self reads the hub node, its owner and its Tailscale addresses', async () => {
  const tailscale = cliTailscale(runner({ 'status --json --peers=false': STATUS }))
  expect(await tailscale.self()).toEqual({
    identity: { userId: '42', loginName: '', nodeId: 'nHUB', nodeName: 'mini', tags: [] },
    addresses: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
    dnsName: 'mini.tail1234.ts.net',
  })
  const stopped = cliTailscale(runner({ 'status --json --peers=false': JSON.stringify({ BackendState: 'Stopped', Self: {} }) }))
  expect(await stopped.self()).toEqual({ problem: TAILSCALE_STOPPED })
})

test('self names why it has no answer: a failed command is not a stopped Tailscale', async () => {
  expect(await cliTailscale(runner({})).self()).toEqual({ problem: 'the tailscale command failed: exit code 1' })
  expect(await cliTailscale(async () => ({ ok: false, problem: TAILSCALE_MISSING })).self()).toEqual({ problem: TAILSCALE_MISSING })
  const gui = cliTailscale(runner({ 'status --json --peers=false': 'The Tailscale GUI failed to start.\nmore' }))
  expect(await gui.self()).toEqual({ problem: 'the tailscale command failed: The Tailscale GUI failed to start.' })
})

const posixOnly = (name: string) => (process.platform === 'win32' ? test.skip : test)
const fakeDir = mkdtempSync(join(tmpdir(), 'kinfold-fake-tailscale-'))
afterAll(() => {
  if (fakeDir.startsWith(tmpdir()) && fakeDir.includes('kinfold-fake-tailscale-')) rmSync(fakeDir, { recursive: true, force: true })
})

/** Acts like the macOS app binary: a CLI only when TERM is set, else it tries the GUI and fails. */
function fakeTailscale(): string[] {
  const script = join(fakeDir, 'tailscale.ts')
  writeFileSync(script, [
    "if (process.env.TERM === undefined || process.env.TERM === '') {",
    "  process.stderr.write('The Tailscale GUI failed to start: (Tailscale.CLIError error 3.)\\nsecond line\\n')",
    '  process.exit(1)',
    '}',
    "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), term: process.env.TERM }))",
  ].join('\n'))
  return [process.execPath, script]
}

test('the tailscale command always runs with TERM set, as the macOS app needs to act as a CLI', async () => {
  const command = fakeTailscale()
  const noTerm = await processRunner(command, { PATH: process.env.PATH ?? '' })(['status', '--json'])
  expect(noTerm.ok).toBe(true)
  if (noTerm.ok) expect(JSON.parse(noTerm.stdout)).toMatchObject({ args: ['status', '--json'] })
  const kept = await processRunner(command, { PATH: process.env.PATH ?? '', TERM: 'screen' })(['status'])
  expect(kept.ok && JSON.parse(kept.stdout).term).toBe('screen')
})

test('a failed tailscale command reports its first line of output; a missing one says so', async () => {
  const script = join(fakeDir, 'fails.ts')
  writeFileSync(script, "process.stderr.write('\\n\\u001b[31mfailed to connect to local tailscaled\\u001b[0m\\nmore\\n'); process.exit(1)")
  expect(await processRunner([process.execPath, script], { PATH: process.env.PATH ?? '' })(['status'])).toEqual({ ok: false, problem: 'the tailscale command failed: failed to connect to local tailscaled' })
  expect(await processRunner(null)(['status'])).toEqual({ ok: false, problem: TAILSCALE_MISSING })
  expect(await processRunner([join(fakeDir, 'no-such-tailscale')])(['status'])).toEqual({ ok: false, problem: TAILSCALE_MISSING })
})

test('the first line drops terminal title codes and direction overrides from what the command printed', () => {
  expect(firstLine('\u001b]0;Tailscale\u0007\u202eerror\u202c: \u001b[1mstopped\u001b[0m')).toBe('error: stopped')
})

posixOnly('x')('a tailscale file that cannot run is a failed command, not a missing one', async () => {
  const script = join(fakeDir, 'not-executable')
  writeFileSync(script, '#!/bin/sh\necho hi\n', { mode: 0o600 })
  const answer = await processRunner([script])(['status'])
  expect(answer).toEqual({ ok: false, problem: 'the tailscale command failed: it could not start (EACCES)' })
})

test('a tailscale command that leaves a child holding its output still answers within its time', async () => {
  const script = join(fakeDir, 'lingers.ts')
  // The child keeps stdout open after the parent is killed, as a wrapper that starts the app binary can.
  writeFileSync(script, "Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 20000)'], { stdout: 'inherit', stderr: 'inherit' }); setTimeout(() => {}, 20000)")
  const startedAt = Date.now()
  const answer = await processRunner([process.execPath, script], { PATH: process.env.PATH ?? '' }, 300)(['status'])
  expect(answer).toEqual({ ok: false, problem: 'the tailscale command failed: no answer within 0.3 s' })
  expect(Date.now() - startedAt).toBeLessThan(3_000)
})

test('only an untagged node of the hub owner counts as the same owner', () => {
  const hub = { userId: '42', loginName: '', nodeId: 'nHUB', nodeName: 'mini', tags: [] }
  expect(sameOwner(hub, { ...hub, nodeId: 'nOTHER' })).toBe(true)
  expect(sameOwner(hub, { ...hub, userId: '43' })).toBe(false)
  expect(sameOwner(hub, { ...hub, tags: ['tag:server'] })).toBe(false)
  expect(sameOwner({ ...hub, tags: ['tag:x'] }, hub)).toBe(false)
})

test('a successful lookup is reused for a minute; a failed one is asked again', async () => {
  let now = 0
  let asked = 0
  let answer: Awaited<ReturnType<ReturnType<typeof cliTailscale>['whois']>> = null
  const whois = cachedWhois(async () => {
    asked += 1
    return answer
  }, () => now)
  expect(await whois('100.64.0.5')).toBeNull()
  expect(await whois('100.64.0.5')).toBeNull()
  expect(asked).toBe(2)
  answer = { userId: '42', loginName: '', nodeId: 'n1', nodeName: 'a', tags: [] }
  await whois('100.64.0.5')
  now = 59_000
  await whois('100.64.0.5')
  expect(asked).toBe(3)
  now = 61_000
  await whois('100.64.0.5')
  expect(asked).toBe(4)
})
