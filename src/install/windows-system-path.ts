// Absolute paths to the Windows tools install and status run. Bun on Windows
// resolves a bare program name through the current folder before PATH, so a
// powershell.exe or schtasks.exe planted in a cloned repo would run instead;
// every tool is therefore named by its full path under SystemRoot.

import type { InstallEnv } from './env'

const DEFAULT_SYSTEM_ROOT = 'C:\\Windows'

/** Joined with backslashes whatever OS runs this, since the path is for Windows. */
export function windowsJoin(base: string, ...parts: string[]): string {
  return [base.replace(/[\\/]+$/, ''), ...parts].join('\\')
}

/** A drive or UNC root with no `..` part: anything else would turn a tool back into a path under the current folder. */
function isAbsoluteWindowsRoot(root: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(root) && !root.split(/[\\/]/).includes('..')
}

/** <SystemRoot>\<relativePath>, with C:\Windows when SystemRoot is unset, empty or not an absolute path. Never a bare name. */
export function windowsSystemTool(env: Pick<InstallEnv, 'envVars'>, relativePath: string): string {
  const root = env.envVars?.SystemRoot
  return windowsJoin(root !== undefined && isAbsoluteWindowsRoot(root) ? root : DEFAULT_SYSTEM_ROOT, relativePath)
}
