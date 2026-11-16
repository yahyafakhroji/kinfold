import { expect, test } from 'bun:test'
import { type TailscaleRunner, cachedWhois, cliTailscale, isLoopbackAddress, isTailscaleAddress, sameOwner } from './tailscale'

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
    return out === undefined || out === null ? null : out
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
  expect(await stopped.self()).toBeNull()
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
