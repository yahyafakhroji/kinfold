import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'
import { type GitRunner, GitTimeoutError, createProjectKeyResolver, gitRunnerWithTimeout, nativeTopLevel, remoteSlug, resolveProjectKey } from './project-key'

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
