import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'
import { type GitRunner, GitTimeoutError, PROJECT_KEY_TTL_MS, createProjectKeyResolver, gitRunnerWithTimeout, nativeTopLevel, remoteSlug, resolveProjectKey } from './project-key'

let root: string
beforeEach(() => {
  // native expands Windows 8.3 short names (RUNNER~1), as git does.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sam-project-')))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' })
  if (!result.success) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
}

test.each([
  ['git@github.com:acme/widgets.git', 'github.com/acme/widgets'],
  ['github.com:acme/widgets.git', 'github.com/acme/widgets'],
  ['https://github.com/acme/widgets', 'github.com/acme/widgets'],
  ['https://user:hunter2@GitLab.Example.com/group/sub/widgets.git', 'gitlab.example.com/group/sub/widgets'],
  ['ssh://git@github.com:22/acme/widgets.git/', 'github.com/acme/widgets'],
])('remote %s gives slug %s', (url, slug) => {
  expect(remoteSlug(url)).toBe(slug)
})

test('the same org/repo on two hosts gives two keys', () => {
  expect(remoteSlug('git@github.com:acme/widgets.git')).not.toBe(remoteSlug('git@gitlab.com:acme/widgets.git'))
})

test.each(['https://example.com/', '/srv/git/acme/widgets.git', 'file:///srv/git/acme/widgets.git'])(
  '%s gives no slug: no org/repo path, or no host',
  (url) => {
    expect(remoteSlug(url)).toBeNull()
  },
)

test('a repo whose remote is a filesystem path keys on its top level', () => {
  git(root, 'init', '-q')
  git(root, 'remote', 'add', 'origin', '/srv/git/acme/widgets.git')
  expect(resolveProjectKey(root)).toMatchObject({ key: root, kind: 'git-root' })
})

test('a git repo with a remote keys on the slug, from any subdirectory', () => {
  git(root, 'init', '-q')
  git(root, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
  const nested = join(root, 'src', 'deep')
  mkdirSync(nested, { recursive: true })

  expect(resolveProjectKey(nested)).toEqual({ key: 'github.com/acme/widgets', kind: 'git-remote', displayName: 'widgets' })
})

test('a git repo without a remote keys on its top level', () => {
  git(root, 'init', '-q')
  const nested = join(root, 'pkg')
  mkdirSync(nested)
  expect(resolveProjectKey(nested)).toMatchObject({ key: root, kind: 'git-root' })
})

test('a directory outside git keys on the path itself', () => {
  expect(resolveProjectKey(root)).toEqual({ key: root, kind: 'path', displayName: basename(root) })
})

test('a cwd that no longer exists still resolves, to its path', () => {
  const gone = join(root, 'deleted')
  expect(resolveProjectKey(gone)).toMatchObject({ key: gone, kind: 'path' })
})

test('a real git timeout is reported as GitTimeoutError, not as "no repo"', () => {
  expect(() => gitRunnerWithTimeout(1)(tmpdir(), ['-c', 'alias.slow=!sleep 1', 'slow'])).toThrow(GitTimeoutError)
})

test('a timeout is retried once and a key from a timeout is never cached', () => {
  let timeouts = 2
  const calls: string[] = []
  const flaky: GitRunner = (cwd, args) => {
    calls.push(`${cwd} ${args[0]}`)
    if (timeouts > 0) {
      timeouts--
      throw new GitTimeoutError(500)
    }
    return args[0] === 'config' ? 'git@github.com:acme/widgets.git' : null
  }
  const resolve = createProjectKeyResolver(flaky)
  expect(resolve('/a')).toMatchObject({ key: '/a', kind: 'path' })
  expect(resolve('/a')).toMatchObject({ key: 'github.com/acme/widgets', kind: 'git-remote' })
  expect(resolve('/a')).toMatchObject({ kind: 'git-remote' })
  expect(calls).toEqual(['/a config', '/a config', '/a config'])
})

test('the resolver runs git once per cwd', () => {
  const calls: string[] = []
  const fake: GitRunner = (cwd, args) => {
    calls.push(`${cwd} ${args.join(' ')}`)
    return args[0] === 'config' ? 'git@github.com:acme/widgets.git' : null
  }
  const resolve = createProjectKeyResolver(fake)
  resolve('/a')
  resolve('/a')
  resolve('/b')
  expect(calls).toEqual(['/a config --get remote.origin.url', '/b config --get remote.origin.url'])
})

test("git's slash-form top level and the path key of the same folder are one key, on Windows and on POSIX", () => {
  // git prints C:/Users/me/proj on Windows; a cwd arrives as C:\Users\me\proj.
  expect(nativeTopLevel('C:/Users/me/proj', win32.normalize)).toBe('C:\\Users\\me\\proj')
  expect(nativeTopLevel('/home/me/proj', posix.normalize)).toBe('/home/me/proj')
})

test('a git root keys the same as the path key a git timeout falls back to', () => {
  git(root, 'init', '-q')
  const fromGit = resolveProjectKey(root)
  const timedOut = createProjectKeyResolver(() => {
    throw new GitTimeoutError(500)
  })(root)
  expect(fromGit.kind).toBe('git-root')
  expect(timedOut.kind).toBe('path')
  expect(fromGit.key).toBe(timedOut.key)
  expect(fromGit.displayName).toBe(timedOut.displayName)
})

function commit(cwd: string, message: string): string {
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', message)
  return Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd }).stdout.toString().trim()
}

test('asked for it, a repo names its first commit, which stays the same across a renamed remote and later commits', () => {
  git(root, 'init', '-q')
  git(root, 'remote', 'add', 'origin', 'git@github.com:me/shared-agent-memory.git')
  const first = commit(root, 'first')
  commit(root, 'second')
  expect(resolveProjectKey(root, undefined, { withRoot: true })).toMatchObject({ key: 'github.com/me/shared-agent-memory', rootCommit: first })
  git(root, 'remote', 'set-url', 'origin', 'git@github.com:me/kinfold.git')
  expect(resolveProjectKey(root, undefined, { withRoot: true })).toMatchObject({ key: 'github.com/me/kinfold', rootCommit: first })
  // The hook's fallback never asks: one git call fewer on its budget.
  expect(resolveProjectKey(root)).not.toHaveProperty('rootCommit')
})

test('a repo with no commits yet, and a folder outside git, have no first commit', () => {
  git(root, 'init', '-q')
  expect(resolveProjectKey(root, undefined, { withRoot: true })).not.toHaveProperty('rootCommit')
  const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'sam-plain-')))
  try {
    expect(resolveProjectKey(plain, undefined, { withRoot: true })).toEqual({ key: plain, kind: 'path', displayName: basename(plain) })
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})

test('the daemon resolver asks git again after a while, so a renamed remote is seen without a restart', () => {
  git(root, 'init', '-q')
  git(root, 'remote', 'add', 'origin', 'git@github.com:me/shared-agent-memory.git')
  let clock = 0
  const resolver = createProjectKeyResolver(undefined, { withRoot: true, now: () => clock })
  expect(resolver(root).key).toBe('github.com/me/shared-agent-memory')
  git(root, 'remote', 'set-url', 'origin', 'git@github.com:me/kinfold.git')
  expect(resolver(root).key).toBe('github.com/me/shared-agent-memory')
  clock = PROJECT_KEY_TTL_MS + 1
  expect(resolver(root).key).toBe('github.com/me/kinfold')
})

test('the first commit is asked once per folder, a refresh asks only for the remote, and a slow history walk keeps the key', () => {
  const calls: string[] = []
  let slow = false
  const fake: GitRunner = (_cwd, args) => {
    calls.push(args[0]!)
    if (args[0] === 'config') return 'git@github.com:me/kinfold.git'
    if (args[0] === 'rev-list') {
      if (slow) throw new GitTimeoutError(1)
      return 'a'.repeat(40)
    }
    return null
  }
  let clock = 0
  const resolver = createProjectKeyResolver(fake, { withRoot: true, now: () => clock })
  expect(resolver('/w')).toMatchObject({ key: 'github.com/me/kinfold', rootCommit: 'a'.repeat(40) })
  clock = PROJECT_KEY_TTL_MS + 1
  expect(resolver('/w')).toMatchObject({ key: 'github.com/me/kinfold', rootCommit: 'a'.repeat(40) })
  expect(calls.filter((call) => call === 'rev-list')).toHaveLength(1)
  slow = true
  expect(resolveProjectKey('/w', fake, { withRoot: true })).toEqual({ key: 'github.com/me/kinfold', kind: 'git-remote', displayName: 'kinfold' })
})
