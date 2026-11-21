// Project identity: the git remote slug (host included) when
// there is one, then the repo root, then the path. Two tools opened in different subdirectories or
// worktrees of one repo land on the same project.

import { basename, normalize } from 'node:path'

export type ProjectKeyKind = 'git-remote' | 'git-root' | 'path'

export interface ProjectKey {
  key: string
  kind: ProjectKeyKind
  displayName: string
  /** The repo's first commit, which names it across renames, forks and clones; absent outside git or when not asked. */
  rootCommit?: string
}

/** Runs git with these args in `cwd`; returns trimmed stdout, or null when git fails or is missing. */
export type GitRunner = (cwd: string, args: readonly string[]) => string | null

export const GIT_TIMEOUT_MS = 500
/** The daemon resolves keys off the hook's hot path, so it can wait for a slow git under load. */
export const DAEMON_GIT_TIMEOUT_MS = 3_000

/** `[user@]host:path`, but not `scheme://`. */
const SCP_REMOTE = /^(?:[^@/:\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/

/**
 * A git call killed by its timeout says nothing about the checkout. Treating it
 * as "not a repo" gave one live repo a path key, and the resolver cache then
 * kept that key for the daemon's life.
 */
export class GitTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`git timed out after ${timeoutMs} ms`)
    this.name = 'GitTimeoutError'
  }
}

function spawnGit(cwd: string, args: readonly string[], timeoutMs: number): ReturnType<typeof Bun.spawnSync> | null {
  try {
    return Bun.spawnSync(['git', '-C', cwd, ...args], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: timeoutMs,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0' },
    })
  } catch (error: unknown) {
    // git not installed, or a cwd that no longer exists: both mean "not a git checkout".
    if (error instanceof Error) return null
    throw error
  }
}

/** A runner whose git call is killed after `timeoutMs`; the read-only context fallback passes what is left of its budget. Throws GitTimeoutError on a timeout. */
export const gitRunnerWithTimeout = (timeoutMs: number): GitRunner => (cwd, args) => {
  const result = spawnGit(cwd, args, timeoutMs)
  if (result === null) return null
  if (result.exitedDueToTimeout === true) throw new GitTimeoutError(timeoutMs)
  if (!result.success) return null
  const out = result.stdout?.toString().trim() ?? ''
  return out === '' ? null : out
}

export const runGit: GitRunner = gitRunnerWithTimeout(GIT_TIMEOUT_MS)

/** GitRunner's answer without holding the caller's thread: work that can wait (the daemon's merge backfill) runs git this way. */
export type AsyncGitRunner = (cwd: string, args: readonly string[]) => Promise<string | null>

/** Like gitRunnerWithTimeout, on a child the caller awaits; a timeout rejects with GitTimeoutError. */
export const asyncGitRunnerWithTimeout = (timeoutMs: number): AsyncGitRunner => async (cwd, args) => {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(['git', '-C', cwd, ...args], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0' },
    })
  } catch (error: unknown) {
    // git not installed, or a cwd that no longer exists: both mean "not a git checkout".
    if (error instanceof Error) return null
    throw error
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  try {
    const [out, code] = await Promise.all([new Response(child.stdout as ReadableStream<Uint8Array>).text(), child.exited])
    if (timedOut) throw new GitTimeoutError(timeoutMs)
    const trimmed = out.trim()
    return code !== 0 || trimmed === '' ? null : trimmed
  } finally {
    clearTimeout(timer)
  }
}

interface RemoteParts {
  host: string
  path: string
}

/** Filesystem and file:// remotes have no host, so they name no shared project. */
function remoteParts(url: string): RemoteParts | null {
  const scp = SCP_REMOTE.exec(url)
  if (scp) return { host: scp[1]!, path: scp[2]! }
  try {
    const parsed = new URL(url)
    return parsed.hostname === '' ? null : { host: parsed.hostname, path: parsed.pathname }
  } catch {
    return null
  }
}

/**
 * `host/org/repo` from scp (`git@host:org/repo.git`) and URL (`https://host/org/repo`) forms.
 * The host keeps github.com/acme/x and gitlab.com/acme/x apart; nested groups are kept;
 * credentials, port and `.git` are dropped.
 */
export function remoteSlug(url: string): string | null {
  const parts = remoteParts(url.trim())
  if (parts === null) return null
  const segments = parts.path.replace(/\.git\/?$/, '').split('/').filter((part) => part !== '')
  if (segments.length < 2) return null
  return [parts.host.toLowerCase(), ...segments].join('/')
}

/**
 * git prints the top level with forward slashes on every OS (C:/Users/me/proj
 * on Windows), while a cwd, and so the path key a git timeout falls back to,
 * uses the native form. Normalizing keeps one folder on one key.
 */
export function nativeTopLevel(output: string, normalizePath: (path: string) => string = normalize): string {
  return normalizePath(output)
}

export interface ResolveOptions {
  /** Also name the repo's first commit (one more git call): the daemon does, the hook's fallback does not. */
  withRoot?: boolean
}

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/**
 * The repo's first commit: the same in every clone and fork, and through a
 * renamed remote. A history with several roots (merged unrelated histories)
 * is named by the smallest, so every clone picks the same one.
 */
export function rootCommitOf(cwd: string, git: GitRunner = runGit): string | null {
  return firstRoot(git(cwd, ROOT_ARGS))
}

/** rootCommitOf through a runner the caller awaits. */
export async function rootCommitOfAsync(cwd: string, git: AsyncGitRunner): Promise<string | null> {
  return firstRoot(await git(cwd, ROOT_ARGS))
}

const ROOT_ARGS = ['rev-list', '--max-parents=0', 'HEAD'] as const

function firstRoot(out: string | null): string | null {
  if (out === null) return null
  const roots = out.split(/\s+/).filter((line) => COMMIT.test(line)).sort()
  return roots[0] ?? null
}

/** The key with its repo's first commit added when git can say in time; a long history can outlast the timeout, and the key found already stands without it. */
function withRootCommit(cwd: string, git: GitRunner, key: ProjectKey): ProjectKey {
  try {
    const root = rootCommitOf(cwd, git)
    return root === null ? key : { ...key, rootCommit: root }
  } catch (error: unknown) {
    if (error instanceof GitTimeoutError) return key
    throw error
  }
}

export function resolveProjectKey(cwd: string, git: GitRunner = runGit, options: ResolveOptions = {}): ProjectKey {
  const withRoot = (key: ProjectKey): ProjectKey => (options.withRoot === true ? withRootCommit(cwd, git, key) : key)
  const remote = git(cwd, ['config', '--get', 'remote.origin.url'])
  const slug = remote === null ? null : remoteSlug(remote)
  if (slug !== null) return withRoot({ key: slug, kind: 'git-remote', displayName: basename(slug) })

  const topLevel = git(cwd, ['rev-parse', '--show-toplevel'])
  if (topLevel !== null) {
    const root = nativeTopLevel(topLevel)
    return withRoot({ key: root, kind: 'git-root', displayName: basename(root) })
  }

  return pathKey(cwd)
}

export type ProjectKeyResolver = (cwd: string) => ProjectKey

function pathKey(cwd: string): ProjectKey {
  return { key: cwd, kind: 'path', displayName: basename(cwd) || cwd }
}

/**
 * One git lookup per cwd per PROJECT_KEY_TTL_MS; the daemon keeps one.
 * A timeout is retried once; if git times out again the event gets the path
 * key, kept only for GIT_RETRY_AFTER_TIMEOUT_MS: every event of a stuck
 * folder asking git again held the daemon for the timeout each time, while a
 * key kept for good left a live repo on its path key.
 */
/** How long the daemon keeps a folder's key before asking git again: a remote renamed under a running daemon is seen within this. */
export const PROJECT_KEY_TTL_MS = 5 * 60_000
/** How long a folder whose git timed out waits before git is asked again. */
export const GIT_RETRY_AFTER_TIMEOUT_MS = 30_000
/** How long a folder whose history walk timed out waits before the walk is tried again; the walk would most likely time out again. */
export const ROOT_RETRY_AFTER_TIMEOUT_MS = 60 * 60_000

export interface ResolverOptions extends ResolveOptions {
  now?: () => number
}

export interface CachingProjectKeyResolver extends ProjectKeyResolver {
  /**
   * The key without the first commit, for a request that waits on it (the
   * prompt path): finding the first commit walks the whole history, which on
   * a large repo is the slow half, and only the merge of one repo under two
   * keys needs it. A key the resolver already holds is reused as it is.
   */
  keyOnly: ProjectKeyResolver
}

export function createProjectKeyResolver(git: GitRunner = runGit, options: ResolverOptions = {}): CachingProjectKeyResolver {
  const now = options.now ?? Date.now
  /** `until` is when git is asked again: a refresh for a key git gave, sooner for one a timeout left. */
  type Kept = { key: ProjectKey; until: number }
  const cache = new Map<string, Kept>()
  // A folder's first commit never changes, and finding it walks the whole history: asked once per folder.
  const roots = new Map<string, string>()
  /** Folders whose history walk timed out, and when to try it again. */
  const rootRetryAt = new Map<string, number>()
  const rootFor = (cwd: string, key: ProjectKey): ProjectKey => {
    if (options.withRoot !== true || key.kind === 'path') return key
    const known = roots.get(cwd)
    if (known !== undefined) return { ...key, rootCommit: known }
    const retryAt = rootRetryAt.get(cwd)
    if (retryAt !== undefined && now() < retryAt) return key
    try {
      const root = rootCommitOf(cwd, git)
      rootRetryAt.delete(cwd)
      if (root === null) return key
      roots.set(cwd, root)
      return { ...key, rootCommit: root }
    } catch (error: unknown) {
      if (!(error instanceof GitTimeoutError)) throw error
      // A long history can outlast the timeout, and would again at the next refresh; the key found already stands without it.
      rootRetryAt.set(cwd, now() + ROOT_RETRY_AFTER_TIMEOUT_MS)
      return key
    }
  }
  const attempt = (cwd: string): ProjectKey | null => {
    try {
      return rootFor(cwd, resolveProjectKey(cwd, git))
    } catch (error: unknown) {
      if (error instanceof GitTimeoutError) return null
      throw error
    }
  }
  const keysOnly = new Map<string, Kept>()
  const keyOnly: ProjectKeyResolver = (cwd) => {
    const at = now()
    const fresh = [cache.get(cwd), keysOnly.get(cwd)].find((entry) => entry !== undefined && at < entry.until)
    if (fresh !== undefined) return fresh.key
    try {
      const key = resolveProjectKey(cwd, git)
      keysOnly.set(cwd, { key, until: at + PROJECT_KEY_TTL_MS })
      return key
    } catch (error: unknown) {
      if (!(error instanceof GitTimeoutError)) throw error
      const key = cache.get(cwd)?.key ?? keysOnly.get(cwd)?.key ?? pathKey(cwd)
      keysOnly.set(cwd, { key, until: at + GIT_RETRY_AFTER_TIMEOUT_MS })
      return key
    }
  }
  const resolver = (cwd: string): ProjectKey => {
    const at = now()
    const cached = cache.get(cwd)
    if (cached !== undefined && at < cached.until) return cached.key
    const resolved = attempt(cwd) ?? attempt(cwd)
    if (resolved === null) {
      // A slow git keeps the key it had until the next refresh. With no key yet, the path key stands in, for a short while only.
      // A key the key-only lookup got from git stands in before the path key does: both lookups then name one project.
      const known = cached !== undefined && cached.key.kind !== 'path' ? cached.key : keysOnly.get(cwd)?.key
      const kept: Kept = known === undefined || known.kind === 'path' ? { key: pathKey(cwd), until: at + GIT_RETRY_AFTER_TIMEOUT_MS } : { key: known, until: cached?.key === known ? at + PROJECT_KEY_TTL_MS : at + GIT_RETRY_AFTER_TIMEOUT_MS }
      cache.set(cwd, kept)
      return kept.key
    }
    cache.set(cwd, { key: resolved, until: at + PROJECT_KEY_TTL_MS })
    return resolved
  }
  return Object.assign(resolver, { keyOnly })
}
