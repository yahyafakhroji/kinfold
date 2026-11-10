// Windows runs the daemon as a per-user scheduled task and keeps the keys in
// Credential Manager. The runner has neither sh nor expect, so the observer
// shim is a compiled claude.exe and the key conversions run through a ConPTY
// driven by pywinpty.
//
// Task Scheduler starts the daemon with the user's logon environment, not the
// smoke's, so a fakeBin only on the smoke's PATH would never reach the
// observer. The shim folder therefore also goes at the front of the user's
// PATH in the registry, which the task's environment is built from; the
// runner script installs the real CLIs outside the machine PATH and its
// cleanup takes the folder off the user PATH again.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { TASK_NAME, taskConfigPath } from '../../src/install/service/scheduled-task-service'
import { windowsSystemTool } from '../../src/install/windows-system-path'
import { SmokeError } from './platform'
import type { SmokePlatform, SmokeResult, SmokeWorld } from './platform'

export const PYWINPTY_VERSION = '2.0.15'

const CONVERSION_TIMEOUT_MS = 200_000
const BUILD_TIMEOUT_MS = 120_000
const REGISTRY_TIMEOUT_MS = 60_000
const SHIM_SOURCE_FILE = 'claude-shim.ts'
const DRIVER_FILE = 'conpty-drive.py'

function systemTool(env: Readonly<Record<string, string | undefined>>, relativePath: string): string {
  const envVars: Record<string, string> = {}
  if (env.SystemRoot !== undefined) envVars.SystemRoot = env.SystemRoot
  return windowsSystemTool({ envVars }, relativePath)
}

/** cmd runs a .cmd or .bat; anything else is started directly. */
function needsCmd(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path)
}

/**
 * The observer's stand-in for a logged-in claude. The print call gets one
 * observation that cites the event it was given; every other argv goes to
 * the real CLI, so version detection and MCP registration stay real.
 */
export function observerShimSource(marker: string, realClaude: string): string {
  const cmd = needsCmd(realClaude) ? JSON.stringify(systemTool(process.env, 'System32\\cmd.exe')) : 'null'
  return [
    `const MARKER = ${JSON.stringify(marker)}`,
    `const REAL = ${JSON.stringify(realClaude)}`,
    `const CMD: string | null = ${cmd}`,
    '',
    '// CommandLineToArgvW quoting, so cmd hands node the argv it was given.',
    'function quote(value: string): string {',
    '  if (value !== "" && !/[\\s"]/.test(value)) return value',
    '  let out = \'"\'',
    '  let slashes = 0',
    '  for (const char of value) {',
    '    if (char === "\\\\") { slashes += 1; continue }',
    '    out += char === \'"\' ? "\\\\".repeat(slashes * 2 + 1) + \'"\' : "\\\\".repeat(slashes) + char',
    '    slashes = 0',
    '  }',
    '  return out + "\\\\".repeat(slashes * 2) + \'"\'',
    '}',
    '',
    'function delegate(args: string[]): never {',
    '  const child = CMD === null',
    '    ? Bun.spawnSync([REAL, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })',
    '    : Bun.spawnSync([CMD, "/d", "/s", "/c", `"${[REAL, ...args].map(quote).join(" ")}"`], {',
    '        stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsVerbatimArguments: true,',
    '      })',
    '  process.exit(child.exitCode ?? 1)',
    '}',
    '',
    'const args = process.argv.slice(2)',
    "if (args[0] !== '--print') delegate(args)",
    '',
    'const input = await new Response(Bun.stdin.stream()).text()',
    'const idLine = /Valid event_id values: *(.*)/.exec(input)',
    'const id = (idLine?.[1] ?? "").split(".")[0]?.split(",")[0]?.replace(/ /g, "") ?? ""',
    'const raw = /"assistant":"([^"]*)"/.exec(input)?.[1] ?? ""',
    'if (id === "" || raw === "") process.exit(1)',
    'let text = raw',
    'try { text = JSON.parse(`"${raw}"`) } catch {}',
    'const payload = {',
    '  observations: [{',
    '    type: "discovery",',
    '    title: `Smoke event ${MARKER}`,',
    '    narrative: text,',
    '    facts: [MARKER],',
    '    files: [],',
    '    evidence: { strength: "interpretation", sourceEventIds: [id] },',
    '    relations: [],',
    '  }],',
    '  summary: null,',
    '}',
    'process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(payload), modelUsage: { "claude-haiku": {} } })}\\n`)',
    '',
  ].join('\n')
}

/**
 * Drives encrypt or decrypt through a ConPTY and answers its prompts the way
 * the expect scripts do, with the same exit codes. It prints nothing: the
 * encrypt output holds the recovery code.
 */
export function conptyDriverSource(): string {
  return [
    'import re',
    'import sys',
    'import threading',
    'import time',
    '',
    'from winpty import PtyProcess',
    '',
    "CODE = re.compile(r'([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}')",
    "ENCRYPT_PROMPT = 'to confirm you saved it: '",
    "DECRYPT_PROMPT = 'Type decrypt to go on: '",
    '# The console redraws the screen and may drop a trailing space, so prompts match without it.',
    "ESCAPES = re.compile(r'\\x1b\\[[0-?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1b[@-_]')",
    'TIMEOUT = 180',
    'EXIT_WAIT = 30',
    '',
    '',
    'class Screen:',
    '    def __init__(self, proc):',
    '        self.proc = proc',
    "        self.raw = ''",
    '        self.closed = False',
    '        self.lock = threading.Lock()',
    '        threading.Thread(target=self.pump, daemon=True).start()',
    '',
    '    def pump(self):',
    '        while True:',
    '            try:',
    '                chunk = self.proc.read(4096)',
    '            except Exception:',
    '                break',
    '            if chunk:',
    '                with self.lock:',
    '                    self.raw += chunk',
    '            elif not self.proc.isalive():',
    '                break',
    '            else:',
    '                time.sleep(0.05)',
    '        self.closed = True',
    '',
    '    def text(self):',
    '        with self.lock:',
    "            return ESCAPES.sub('', self.raw).replace('\\r', '')",
    '',
    '    def ended(self):',
    '        return self.closed or not self.proc.isalive()',
    '',
    '    def wait(self, find, start):',
    "        \"\"\"('match', m) when find matches after start, else ('eof', None) or ('timeout', None).\"\"\"",
    '        deadline = time.monotonic() + TIMEOUT',
    '        while True:',
    '            ended = self.ended()',
    '            found = find(self.text(), start)',
    '            if found is not None:',
    "                return 'match', found",
    '            if ended:',
    '                time.sleep(0.5)',
    '                found = find(self.text(), start)',
    "                return ('match', found) if found is not None else ('eof', None)",
    '            if time.monotonic() >= deadline:',
    "                return 'timeout', None",
    '            time.sleep(0.05)',
    '',
    '',
    'def find_code(text, start):',
    '    return CODE.search(text, start)',
    '',
    '',
    'def find_prompt(prompt):',
    '    needle = prompt.rstrip()',
    '',
    '    def find(text, start):',
    '        index = text.find(needle, start)',
    '        return None if index < 0 else index + len(needle)',
    '    return find',
    '',
    '',
    'def never(text, start):',
    '    return None',
    '',
    '',
    'def exit_code(proc):',
    '    deadline = time.monotonic() + EXIT_WAIT',
    '    while proc.isalive() and time.monotonic() < deadline:',
    '        time.sleep(0.1)',
    '    status = proc.exitstatus',
    '    return 1 if status is None else status',
    '',
    '',
    'def encrypt(proc, screen):',
    '    state, code = screen.wait(find_code, 0)',
    "    if state == 'timeout':",
    '        sys.exit(4)',
    "    if state == 'eof':",
    '        sys.exit(5)',
    "    groups = code.group(0).split('-')",
    '    tail = groups[-2] + groups[-1]',
    '    state, _ = screen.wait(find_prompt(ENCRYPT_PROMPT), code.end())',
    "    if state == 'timeout':",
    '        sys.exit(2)',
    "    if state == 'eof':",
    '        sys.exit(3)',
    "    proc.write(tail + '\\r')",
    '    del tail, groups, code',
    '    state, _ = screen.wait(never, 0)',
    "    if state == 'timeout':",
    '        sys.exit(6)',
    '',
    '',
    'def decrypt(proc, screen):',
    '    start = 0',
    '    while True:',
    '        state, end = screen.wait(find_prompt(DECRYPT_PROMPT), start)',
    "        if state == 'timeout':",
    '            sys.exit(2)',
    "        if state == 'eof':",
    '            return',
    '        start = end',
    "        proc.write('decrypt\\r')",
    '',
    '',
    'def main():',
    '    if len(sys.argv) != 3 or sys.argv[2] not in (\'encrypt\', \'decrypt\'):',
    '        sys.exit(64)',
    '    program, operation = sys.argv[1], sys.argv[2]',
    '    # Wide enough that the recovery code and the prompts never wrap.',
    '    proc = PtyProcess.spawn([program, operation], dimensions=(50, 400))',
    '    screen = Screen(proc)',
    "    if operation == 'encrypt':",
    '        encrypt(proc, screen)',
    '    else:',
    '        decrypt(proc, screen)',
    '    sys.exit(exit_code(proc))',
    '',
    '',
    "if __name__ == '__main__':",
    '    main()',
    '',
  ].join('\n')
}

interface Captured {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

async function capture(argv: readonly string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<Captured> {
  const child = Bun.spawn([...argv], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

function pathOf(env: Readonly<Record<string, string>>): string {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  return key === undefined ? '' : env[key] ?? ''
}

/** python found on the smoke's PATH by full path, so a python.exe in the project folder never runs. */
function python(world: SmokeWorld): string {
  const found = Bun.which('python', { PATH: pathOf(world.env) })
  if (found === null) throw new SmokeError('setup', 'python is not on PATH; the ConPTY driver needs it')
  return found
}

async function runConversion(world: SmokeWorld, operation: 'encrypt' | 'decrypt'): Promise<SmokeResult> {
  const driver = join(world.root, DRIVER_FILE)
  writeFileSync(driver, conptyDriverSource(), { mode: 0o600 })
  const result = await capture([python(world), driver, world.program, operation], world.project, world.env, CONVERSION_TIMEOUT_MS)
  // The driver prints nothing of the program's, so its own output is safe to keep; a timeout shows none of it anyway.
  if (result.timedOut) throw new SmokeError('timeout', `the ConPTY ${operation} did not finish in ${CONVERSION_TIMEOUT_MS} ms`)
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

/** Puts the shim folder first on the user PATH that the scheduled task's environment is built from. */
async function addToUserPath(world: SmokeWorld, folder: string): Promise<void> {
  const script = [
    "$old = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$parts = @($env:KINFOLD_SMOKE_SHIM_DIR) + @(if ($old) { $old -split ';' | Where-Object { $_ -ne '' } })",
    "[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')",
  ].join('; ')
  const powershell = systemTool(world.env, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  const env = { ...world.env, KINFOLD_SMOKE_SHIM_DIR: folder }
  const result = await capture([powershell, '-NoProfile', '-NonInteractive', '-Command', script], world.root, env, REGISTRY_TIMEOUT_MS)
  if (result.timedOut || result.code !== 0) {
    throw new SmokeError('setup', `the shim folder could not be added to the user PATH (exit ${result.code})\n${result.stderr.trim()}`)
  }
}

async function writeObserverShim(world: SmokeWorld, realClaude: string | null): Promise<void> {
  if (realClaude === null) throw new SmokeError('setup', 'claude is not on PATH; the workflow installs it before the smoke')
  mkdirSync(world.fakeBin, { recursive: true, mode: 0o700 })
  const source = join(world.root, SHIM_SOURCE_FILE)
  writeFileSync(source, observerShimSource(world.marker, realClaude), { mode: 0o600 })
  const outfile = win32.join(world.fakeBin, 'claude.exe')
  const built = await capture([process.execPath, 'build', '--compile', source, '--outfile', outfile], world.root, world.env, BUILD_TIMEOUT_MS)
  if (built.timedOut || built.code !== 0) {
    throw new SmokeError('setup', `bun build --compile could not make the claude shim (exit ${built.code})\n${built.stderr.trim()}`)
  }
  await addToUserPath(world, world.fakeBin)
}

export const smokePlatform: SmokePlatform = {
  name: 'windows',
  programName: 'kinfold.exe',
  keyStoreLabel: 'Credential Manager',
  serviceLoaded(env) {
    const result = Bun.spawnSync([systemTool(env, 'System32\\schtasks.exe'), '/Query', '/TN', TASK_NAME], {
      env: { ...env },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return result.exitCode === 0
  },
  serviceFiles(home) {
    // taskConfigPath joins with backslashes on every OS, so the shared tests
    // see the same Windows path wherever they run.
    return [taskConfigPath({ homeDir: home, envVars: {} })]
  },
  childEnv(home) {
    return {
      USERPROFILE: home,
      LOCALAPPDATA: win32.join(home, 'AppData', 'Local'),
      APPDATA: win32.join(home, 'AppData', 'Roaming'),
    }
  },
  writeObserverShim,
  runConversion,
  statusLines(world) {
    return [
      'service (scheduled task): config present; running: yes',
      `data dir ${world.dataDir}: access list ok (only you, SYSTEM and Administrators can read it)`,
    ]
  },
}
