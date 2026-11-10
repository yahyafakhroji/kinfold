// Project identity: the git remote slug (host included) when
// there is one, then the repo root, then the path. Two tools opened in different subdirectories or
// worktrees of one repo land on the same project.

import { basename, normalize } from 'node:path'

export type ProjectKeyKind = 'git-remote' | 'git-root' | 'path'

export interface ProjectKey {
  key: string
  kind: ProjectKeyKind
  displayName: string
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

export function resolveProjectKey(cwd: string, git: GitRunner = runGit): ProjectKey {
  const remote = git(cwd, ['config', '--get', 'remote.origin.url'])
  const slug = remote === null ? null : remoteSlug(remote)
  if (slug !== null) return { key: slug, kind: 'git-remote', displayName: basename(slug) }

  const topLevel = git(cwd, ['rev-parse', '--show-toplevel'])
  if (topLevel !== null) {
    const root = nativeTopLevel(topLevel)
    return { key: root, kind: 'git-root', displayName: basename(root) }
  }

  return pathKey(cwd)
}

export type ProjectKeyResolver = (cwd: string) => ProjectKey

function pathKey(cwd: string): ProjectKey {
  return { key: cwd, kind: 'path', displayName: basename(cwd) || cwd }
}

/**
 * One git lookup per cwd for the life of the resolver; the daemon keeps one.
 * A timeout is retried once; if git times out again the event gets the path
 * key, which is not cached, so the next event in that cwd asks git again.
 */
export function createProjectKeyResolver(git: GitRunner = runGit): ProjectKeyResolver {
  const cache = new Map<string, ProjectKey>()
  const attempt = (cwd: string): ProjectKey | null => {
    try {
      return resolveProjectKey(cwd, git)
    } catch (error: unknown) {
      if (error instanceof GitTimeoutError) return null
      throw error
    }
  }
  return (cwd) => {
    const cached = cache.get(cwd)
    if (cached !== undefined) return cached
    const resolved = attempt(cwd) ?? attempt(cwd)
    if (resolved === null) return pathKey(cwd)
    cache.set(cwd, resolved)
    return resolved
  }
}
