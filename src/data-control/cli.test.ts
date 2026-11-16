import { afterEach, beforeEach, expect, test } from 'bun:test'
import { fakeTerminal } from '../install/prompt/fake-terminal'
import { runKinfold } from '../cli/kinfold'
import { startDaemon } from '../daemon/daemon'
import { parseArgs, parseDataArgs } from '../install/args'
import { EXIT_USAGE } from '../install/install'
import { type FakeWorld, createWorld } from '../install/test-support'
import { planFor } from './cli'

let world: FakeWorld
beforeEach(() => {
  world = createWorld()
})
afterEach(async () => world.cleanup())

function startWorldDaemon(): void {
  const daemon = startDaemon({ dataDir: world.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  world.launchd.daemon = daemon
  world.allowedPorts.add(daemon.port)
}

const parsed = (argv: string[]) => {
  const result = parseDataArgs(argv)
  if (result === null || !result.ok) throw new Error(`did not parse: ${result === null ? 'not a data command' : result.error}`)
  return result.value
}
const errorOf = (argv: string[]): string => {
  const result = parseDataArgs(argv)
  return result === null ? 'not a data command' : result.ok ? 'parsed' : result.error
}

test('each data subcommand parses and maps to its route', () => {
  const routes = (argv: string[]) => {
    const plan = planFor(parsed(argv))
    return [plan.method, plan.path, plan.body]
  }
  expect(routes(['size'])).toEqual(['GET', '/data/size', undefined])
  expect(routes(['scan'])).toEqual(['POST', '/data/scan', {}])
  expect(routes(['retention'])).toEqual(['GET', '/data/retention', undefined])
  expect(routes(['retention', '--set', 'events=7', '--set=prompts=keep', '--set', 'warn_bytes=1000'])).toEqual(['PUT', '/data/retention', { retention: { events: 7, prompts: null }, warnBytes: 1000, preview: true }])
  expect(routes(['retention', '--set', 'events=7', '--yes'])).toEqual(['PUT', '/data/retention', { retention: { events: 7 } }])
  expect(routes(['findings'])).toEqual(['GET', '/data/findings?action=pending', undefined])
  expect(routes(['findings', '--all'])).toEqual(['GET', '/data/findings?action=all', undefined])
  expect(routes(['findings', '--redact', '4'])).toEqual(['POST', '/data/findings/4/resolve', { action: 'redact' }])
  expect(routes(['findings', '--purge=5'])).toEqual(['POST', '/data/findings/5/resolve', { action: 'purge' }])
  expect(routes(['purge', '--session', '3', '--dry-run'])).toEqual(['POST', '/data/purge', { session: 3, dryRun: true }])
  expect(routes(['purge', '--project', 'org/repo'])).toEqual(['POST', '/data/purge', { project: 'org/repo' }])
  expect(routes(['purge', '--host', 'opencode'])).toEqual(['POST', '/data/purge', { host: 'opencode' }])
  expect(routes(['purge', '--observation', '9'])).toEqual(['POST', '/data/purge', { observation: 9 }])
  expect(routes(['purge', '--before', '2026-10-01T00:00:00Z', '--after', '2026-09-01'])).toEqual(['POST', '/data/purge', { before: '2026-10-01T00:00:00Z', after: '2026-09-01' }])
})

test('bad data flags are usage errors, and install/uninstall/status still parse as before', () => {
  expect(errorOf(['purge'])).toStartWith('purge: name exactly one of')
  expect(errorOf(['purge', '--session', '1', '--host', 'x'])).toStartWith('purge: name exactly one of')
  expect(errorOf(['purge', '--session', 'abc'])).toBe('purge: session must be a positive integer id')
  expect(errorOf(['purge', '--before', 'yesterday'])).toBe('purge: before must be epoch ms or an ISO 8601 time')
  expect(errorOf(['purge', '--session'])).toBe('--session needs a value')
  expect(errorOf(['purge', '--force', '1'])).toStartWith('unknown purge flag "--force"')
  expect(errorOf(['retention', '--set', 'events=0'])).toStartWith('retention.events must be whole days')
  expect(errorOf(['retention', '--set', 'vectors=3'])).toStartWith('retention tables are')
  expect(errorOf(['retention', '--set', 'events'])).toStartWith('retention takes --set')
  expect(errorOf(['retention', '--yes'])).toBe('retention --yes needs at least one --set')
  expect(errorOf(['retention', '--yes=1'])).toStartWith('retention takes --set')
  expect(errorOf(['findings', '--redact', '1', '--purge', '2'])).toBe('resolve one finding at a time')
  expect(errorOf(['size', '--all'])).toBe('size takes no flags')
  expect(errorOf(['scan', 'now'])).toBe('scan takes no flags')
  expect(errorOf(['findings', 'all'])).toStartWith('unknown argument "all"')
  expect(errorOf(['status'])).toBe('not a data command')
  expect(parseArgs(['status']).ok).toBe(true)
  expect(parseArgs(['size'])).toEqual({ ok: false, error: expect.stringContaining('usage: kinfold <install|uninstall|status|update|size|') })
})

test('runKinfold sends each data command to the running daemon and prints its answer', async () => {
  startWorldDaemon()
  for (const argv of [['size'], ['retention'], ['retention', '--set', 'events=14'], ['scan'], ['findings'], ['purge', '--host', 'nobody', '--dry-run']]) {
    expect(await runKinfold(argv, world.env)).toBe(0)
  }
  expect(world.fetches).toEqual(['GET /data/size', 'GET /data/retention', 'PUT /data/retention', 'POST /data/scan', 'GET /data/findings', 'POST /data/purge'])
  expect(world.out).toContain('retention: events 14 days (payload), prompts keep (text), observations keep, summaries keep')
  expect(world.out).toContain('preview, nothing saved; saving now would expire: events 0 (0 B), prompts 0 (0 B), observations 0 (0 B), summaries 0 (0 B)')
  expect(world.out).toContain('dry run, nothing changed; would remove: nothing')
  expect(world.out.some((line) => line.startsWith('scanned 0 rows'))).toBe(true)
  expect(world.out.some((line) => line.startsWith('database '))).toBe(true)
})

test('a data command without a daemon fails with exit 1, and a usage error exits 2 without a request', async () => {
  expect(await runKinfold(['size'], world.env)).toBe(1)
  expect(world.out.at(-1)).toBe('kinfold size failed: the daemon is not running (no daemon.json or daemon.token)')
  expect(await runKinfold(['purge'], world.env)).toBe(EXIT_USAGE)
  expect(world.fetches).toEqual([])
  startWorldDaemon()
  expect(await runKinfold(['findings', '--redact', '77'], world.env)).toBe(1)
  expect(world.out.at(-1)).toBe('kinfold findings failed: POST /data/findings/77/resolve answered 404: no such finding')
})

test('kinfold retention previews a change and saves only with --yes', async () => {
  startWorldDaemon()
  expect(await runKinfold(['retention', '--set', 'prompts=3'], world.env)).toBe(0)
  expect(world.out.at(-1)).toBe('run again with --yes to save and apply')
  world.out.length = 0
  expect(await runKinfold(['retention'], world.env)).toBe(0)
  expect(world.out[0]).toContain('prompts keep (text)')
  expect(await runKinfold(['retention', '--set', 'prompts=3', '--yes'], world.env)).toBe(0)
  expect(world.out.at(-1)).toBe('applied now: events 0, prompts 0, observations 0, summaries 0')
  world.out.length = 0
  expect(await runKinfold(['retention'], world.env)).toBe(0)
  expect(world.out[0]).toContain('prompts 3 days (text)')
})

// ---- on a terminal -------------------------------------------------------------

const drawnLines = (term: ReturnType<typeof fakeTerminal>): string[] =>
  term.output().split('\n').map((line) => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trimEnd()).filter((line) => line !== '')

test('on a terminal each data command is one titled section, with the next command where there is one', async () => {
  startWorldDaemon()
  const term = fakeTerminal([])
  world.env = { ...world.env, terminal: term }
  expect(await runKinfold(['size'], world.env)).toBe(0)
  expect(await runKinfold(['findings'], world.env)).toBe(0)
  expect(await runKinfold(['retention', '--set', 'events=30'], world.env)).toBe(0)
  expect(await runKinfold(['purge', '--host', 'opencode', '--dry-run'], world.env)).toBe(0)
  expect(world.out).toEqual([])
  const lines = drawnLines(term)
  for (const title of ['Database size', 'Findings', 'Retention', 'Purge']) expect(lines).toContain(title)
  expect(lines.some((line) => /^ {2}database \S+ \S+ \(db /.test(line))).toBe(true)
  expect(lines).toContain('  + no findings')
  expect(lines).toContain('Save and apply it with: kinfold retention --set ... --yes')
  // Nothing would be removed here, so there is no next step to name; and the preview's own "run again" line is the outro, not a row too.
  expect(lines).not.toContain('Remove them with the same command without --dry-run')
  expect(lines.filter((line) => line.includes('run again with --yes'))).toEqual([])
  // Rows under a heading keep their indent, so the tables read as a list.
  expect(lines.some((line) => /^ {4}events \S+ \S+$/.test(line))).toBe(true)
})

test('only a finding that is still pending is flagged in the list', async () => {
  const { rowOf } = await import('./cli')
  expect(rowOf('  #4 events 12 payload aws-key v2 x1 pending')).toEqual({ mark: 'warn', text: '#4 events 12 payload aws-key v2 x1 pending' })
  expect(rowOf('  #5 events 13 payload aws-key v2 x1 redacted').mark).toBe('none')
  expect(rowOf('  #6 prompts 2 - github-token v1 x3 purged').mark).toBe('none')
})

test('a purge dry run that would remove something ends on how to go ahead', () => {
  const plan = planFor(parsed(['purge', '--host', 'opencode', '--dry-run']))
  expect(plan.next?.({ dryRun: true, counts: { events: 3 }, packsRebuilt: 0, scrub: null })).toBe('Remove them with the same command without --dry-run')
  expect(plan.next?.({ dryRun: true, counts: { events: 0 }, packsRebuilt: 0, scrub: null })).toBeNull()
  expect(plan.next?.({ dryRun: false, counts: { events: 3 }, packsRebuilt: 1, scrub: null })).toBeNull()
})

test('on a terminal a data command that cannot reach the daemon draws the reason as an error', async () => {
  const term = fakeTerminal([])
  world.env = { ...world.env, terminal: term }
  expect(await runKinfold(['size'], world.env)).toBe(1)
  expect(drawnLines(term).slice(-2)).toEqual(['x kinfold size failed: the daemon is not running (no daemon.json or daemon.token)', 'kinfold size did not finish.'])
  expect(world.out).toEqual([])
})

test('--plain on a terminal prints the lines a script reads', async () => {
  startWorldDaemon()
  const term = fakeTerminal([])
  world.env = { ...world.env, terminal: term }
  expect(await runKinfold(['size', '--plain'], world.env)).toBe(0)
  expect(term.output()).toBe('')
  expect(world.out[0]).toMatch(/^database /)
})

// ---- purge asks before it deletes ------------------------------------------------

/** The world's daemon, with /data/purge answered here so a test can say what would go and see what was asked. */
function purgeWorld(counts: Record<string, number>): { sent: Record<string, unknown>[] } {
  startWorldDaemon()
  const sent: Record<string, unknown>[] = []
  const real = world.env.fetch
  world.env = {
    ...world.env,
    fetch: async (url, init) => {
      if (!url.endsWith('/data/purge')) return real(url, init)
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      sent.push(body)
      return new Response(JSON.stringify({ dryRun: body.dryRun === true, counts, packsRebuilt: 2, scrub: null }))
    },
  }
  return { sent }
}

const onTerminal = (keys: readonly string[]): ReturnType<typeof fakeTerminal> => {
  const term = fakeTerminal(keys)
  world.env = { ...world.env, terminal: term }
  return term
}

test('--yes is a purge flag and never part of what is sent', () => {
  expect(parsed(['purge', '--host', 'opencode', '--yes'])).toEqual({ command: 'purge', body: { host: 'opencode' }, yes: true })
  expect(parsed(['purge', '--host', 'opencode'])).toEqual({ command: 'purge', body: { host: 'opencode' }, yes: false })
  expect(parsed(['purge', '--host', 'opencode', '--dry-run'])).toEqual({ command: 'purge', body: { host: 'opencode', dryRun: true }, yes: false })
})

test('with no terminal and no --yes purge refuses, names --yes, and sends nothing', async () => {
  const { sent } = purgeWorld({ events: 3 })
  expect(await runKinfold(['purge', '--host', 'opencode'], world.env)).toBe(1)
  expect(world.out).toEqual(['kinfold purge: nothing was deleted. Purge asks before it deletes, and there is no terminal to ask on; pass --yes to delete, or --dry-run to see what would go'])
  expect(sent).toEqual([])
})

test('--plain on a terminal is a run that cannot ask, so it refuses the same way', async () => {
  const { sent } = purgeWorld({ events: 3 })
  onTerminal(['y'])
  expect(await runKinfold(['purge', '--host', 'opencode', '--plain'], world.env)).toBe(1)
  expect(sent).toEqual([])
})

test('--yes deletes without asking, with or without a terminal', async () => {
  const { sent } = purgeWorld({ events: 3 })
  expect(await runKinfold(['purge', '--host', 'opencode', '--yes'], world.env)).toBe(0)
  expect(world.out).toEqual(['removed: events 3', 'packs rebuilt 2'])
  const term = onTerminal([])
  expect(await runKinfold(['purge', '--host', 'opencode', '--yes'], world.env)).toBe(0)
  expect(term.output()).not.toContain('Delete')
  expect(sent).toEqual([{ host: 'opencode' }, { host: 'opencode' }])
})

test('on a terminal purge shows what it would delete, asks with no as the default, and deletes only on yes', async () => {
  const { sent } = purgeWorld({ events: 3, observations: 1, prompts: 0 })
  const term = onTerminal(['y'])
  expect(await runKinfold(['purge', '--host', 'opencode'], world.env)).toBe(0)
  const lines = drawnLines(term)
  expect(lines).toContain('Purge')
  expect(lines).toContain('  would remove: events 3, observations 1')
  expect(drawnLines(term).some((line) => line.startsWith('Delete them? This cannot be undone. (y/N)'))).toBe(true)
  expect(lines).toContain('removed: events 3, observations 1')
  // The counts were asked for first, and the delete was sent only after the yes.
  expect(sent).toEqual([{ host: 'opencode', dryRun: true }, { host: 'opencode' }])
})

test('Enter, n, Ctrl-C or a closed terminal at the question deletes nothing', async () => {
  for (const [keys, code] of [[['\r'], 0], [['n'], 0], [['\u0003'], 130], [[], 130]] as const) {
    const { sent } = purgeWorld({ events: 3 })
    const term = onTerminal(keys)
    expect(await runKinfold(['purge', '--host', 'opencode'], world.env)).toBe(code)
    expect(sent).toEqual([{ host: 'opencode', dryRun: true }])
    if (code === 0) expect(drawnLines(term)).toContain('nothing was deleted')
    await world.cleanup()
    world = createWorld()
  }
})

test('with nothing to delete purge says so and asks nothing', async () => {
  const { sent } = purgeWorld({ events: 0 })
  const term = onTerminal([])
  expect(await runKinfold(['purge', '--host', 'opencode'], world.env)).toBe(0)
  expect(term.output()).not.toContain('Delete them?')
  expect(drawnLines(term)).toContain('  nothing matches, so nothing was deleted')
  expect(sent).toEqual([{ host: 'opencode', dryRun: true }])
})

test('--dry-run asks nothing on a terminal and deletes nothing', async () => {
  const { sent } = purgeWorld({ events: 3 })
  const term = onTerminal([])
  expect(await runKinfold(['purge', '--host', 'opencode', '--dry-run'], world.env)).toBe(0)
  expect(term.output()).not.toContain('Delete them?')
  expect(sent).toEqual([{ host: 'opencode', dryRun: true }])
})

// ---- findings --purge asks before it deletes -------------------------------------

const FINDING = { id: 4, table: 'events', rowId: 12, field: 'payload', rule: 'aws-key', ruleVersion: 2, matches: 1, foundAt: 1, action: 'pending', resolvedAt: null }

/** The world's daemon, with the findings routes answered here: one pending finding, and a record of what was asked. */
function findingsWorld(findings: unknown[] = [FINDING]): { asked: string[] } {
  startWorldDaemon()
  const asked: string[] = []
  const real = world.env.fetch
  world.env = {
    ...world.env,
    fetch: async (url, init) => {
      const path = new URL(url).pathname + new URL(url).search
      if (!path.startsWith('/data/findings')) return real(url, init)
      asked.push(`${init.method ?? 'GET'} ${path}${init.body === undefined ? '' : ` ${String(init.body)}`}`)
      if (init.method === 'POST') return new Response(JSON.stringify({ resolved: { ...FINDING, action: 'purged' } }))
      return new Response(JSON.stringify({ pendingByRule: { 'aws-key': findings.length }, findings }))
    },
  }
  return { asked }
}

const RESOLVE = 'POST /data/findings/4/resolve {"action":"purge"}'
const LIST = 'GET /data/findings?action=pending'

test('--yes is a findings flag for --purge', () => {
  expect(parsed(['findings', '--purge', '4', '--yes'])).toEqual({ command: 'findings', all: false, resolve: { id: 4, action: 'purge' }, yes: true })
  expect(parsed(['findings', '--purge', '4'])).toEqual({ command: 'findings', all: false, resolve: { id: 4, action: 'purge' }, yes: false })
})

test('with no terminal and no --yes, findings --purge refuses, names --yes, and sends nothing', async () => {
  const { asked } = findingsWorld()
  expect(await runKinfold(['findings', '--purge', '4'], world.env)).toBe(1)
  expect(world.out).toEqual(['kinfold findings: nothing was deleted. --purge asks before it deletes, and there is no terminal to ask on; pass --yes to delete'])
  expect(asked).toEqual([])
  onTerminal(['y'])
  expect(await runKinfold(['findings', '--purge', '4', '--plain'], world.env)).toBe(1)
  expect(asked).toEqual([])
})

test('findings --purge --yes deletes without asking', async () => {
  const { asked } = findingsWorld()
  expect(await runKinfold(['findings', '--purge', '4', '--yes'], world.env)).toBe(0)
  expect(world.out).toEqual(['finding resolved: #4 events 12 payload aws-key v2 x1 purged'])
  expect(asked).toEqual([RESOLVE])
})

test('on a terminal findings --purge shows the finding, never its secret, asks with no as the default, and deletes only on yes', async () => {
  const { asked } = findingsWorld()
  const term = onTerminal(['y'])
  expect(await runKinfold(['findings', '--purge', '4'], world.env)).toBe(0)
  const lines = drawnLines(term)
  expect(lines).toContain('Finding')
  // Where it is and which rule found it: the id, the table and row, the field, the rule. The matched text is never stored in a finding.
  expect(lines).toContain('  ! #4 events 12 payload aws-key v2 x1 pending')
  expect(lines.some((line) => line.startsWith('Delete the events row this finding is in? This cannot be undone. (y/N)'))).toBe(true)
  expect(lines).toContain('finding resolved: #4 events 12 payload aws-key v2 x1 purged')
  expect(asked).toEqual([LIST, RESOLVE])
})

test('Enter, n, Ctrl-C or a closed terminal at the findings question deletes nothing', async () => {
  for (const [keys, code] of [[['\r'], 0], [['n'], 0], [['\u0003'], 130], [[], 130]] as const) {
    const { asked } = findingsWorld()
    const term = onTerminal(keys)
    expect(await runKinfold(['findings', '--purge', '4'], world.env)).toBe(code)
    expect(asked).toEqual([LIST])
    if (code === 0) expect(drawnLines(term)).toContain('nothing was deleted')
    await world.cleanup()
    world = createWorld()
  }
})

test('a finding that is not pending is named as such and nothing is asked or deleted', async () => {
  const { asked } = findingsWorld([])
  const term = onTerminal(['y'])
  expect(await runKinfold(['findings', '--purge', '4'], world.env)).toBe(1)
  expect(drawnLines(term)).toContain('x kinfold findings: no pending finding #4; nothing was deleted')
  expect(asked).toEqual([LIST])
})

test('--redact deletes no row, so it asks nothing', async () => {
  const { asked } = findingsWorld()
  const term = onTerminal([])
  expect(await runKinfold(['findings', '--redact', '4'], world.env)).toBe(0)
  expect(term.output()).not.toContain('Delete')
  expect(asked).toEqual(['POST /data/findings/4/resolve {"action":"redact"}'])
})

test('kinfold size lists the store by part, and past the threshold names the largest part', () => {
  const plan = planFor(parsed(['size']))
  const report = {
    source: 'dbstat', pageSize: 4096, pageCount: 1, freelistPages: 0,
    files: { db: 2000, wal: 0, shm: 0 }, totalBytes: 2000, freeBytes: 0, warnBytes: 1000, overWarn: true,
    tables: [], projects: [],
    parts: [
      { name: 'prompts', bytes: 100 }, { name: 'replies', bytes: 1220 }, { name: 'events', bytes: 300 }, { name: 'observations', bytes: 200 },
      { name: 'summaries', bytes: 0 }, { name: 'vectors', bytes: 80 }, { name: 'other', bytes: 100 },
    ],
    warning: 'replies are 61% of 2.0 KB; set prompts retention to trim them',
  }
  const lines = plan.lines(report)
  expect(lines.slice(1, 3)).toEqual(['warning threshold 1000 B: OVER', 'warning: replies are 61% of 2.0 KB; set prompts retention to trim them'])
  const byPart = lines.indexOf('by part:')
  expect(byPart).toBeGreaterThan(-1)
  expect(lines.slice(byPart + 1, byPart + 3)).toEqual(['  prompts 100 B (5%)', '  replies 1.2 KB (61%)'])
  const under = plan.lines({ ...report, overWarn: false, warning: null })
  expect(under[1]).toBe('warning threshold 1000 B: ok')
  expect(under.some((line) => line.startsWith('warning: '))).toBe(false)
})

test('the threshold row and the line naming the largest part are flagged', async () => {
  const { rowOf } = await import('./cli')
  expect(rowOf('warning threshold 1000 B: OVER').mark).toBe('warn')
  expect(rowOf('warning: replies are 61% of 2.0 KB; set prompts retention to trim them').mark).toBe('warn')
  expect(rowOf('warning threshold 1000 B: ok').mark).toBe('none')
})

test('a daemon from before the part breakdown gets no empty by part heading', () => {
  const plan = planFor(parsed(['size']))
  const old = {
    source: 'dbstat', pageSize: 4096, pageCount: 1, freelistPages: 0,
    files: { db: 2000, wal: 0, shm: 0 }, totalBytes: 2000, freeBytes: 0, warnBytes: 1000, overWarn: true, tables: [], projects: [],
  }
  const lines = plan.lines(old)
  expect(lines).not.toContain('by part:')
  expect(lines[1]).toBe('warning threshold 1000 B: OVER')
})
