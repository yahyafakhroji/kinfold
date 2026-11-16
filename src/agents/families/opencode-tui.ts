// The recall toast in OpenCode. OpenCode 2.x gives a server plugin no way to
// show the user anything: its setup context has no UI, and its event API only
// subscribes (checked against 2.2.5). A toast comes from a TUI plugin part,
// through `context.ui.toast.show` (opencode.ai/docs/build/plugins/cli, checked
// 2026-11-15). OpenCode loads a folder in its plugins directory as one plugin,
// taking the parts from the root files named `server` and `tui`, and the TUI
// loads the TUI part of every plugin its server loaded. So Kinfold adds one
// small folder beside its plugin file:
//   server.js  a server part that does nothing; it is what makes the server
//              list the folder, so the TUI loads the part next to it
//   tui.js     asks the Kinfold daemon once a second for the prompts OpenCode
//              sent (GET /watch, the route `kinfold watch` reads) and shows
//              each one's recall line as a toast; a session that starts
//              gets its first-screen list the same way, from the pack the
//              daemon recorded as sent to it
// Both files are plain JavaScript with no Kinfold code in them, so they load
// whatever build of OpenCode runs them. The toast is for the user only:
// nothing here reaches a model. The daemon's token is read from the data
// folder on each poll and sent only to 127.0.0.1.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { InstallEnv } from '../../install/env'
import { describeTextChange, readTextOrNull } from '../../install/files'
import type { Action } from '../../install/plan'
import { LEGACY_SHIM_MARKER, SHIM_MARKER } from '../../names'

const DIR_MODE = 0o755
const FILE_MODE = 0o644

/** The folder's name in OpenCode's plugins directory. */
export const OPENCODE_TUI_DIR = 'kinfold-recall'
export const OPENCODE_TUI_FILE = 'tui.js'
export const OPENCODE_TUI_SERVER_FILE = 'server.js'
/** The id both parts declare; OpenCode pairs the parts of one plugin by it. */
export const OPENCODE_TUI_PLUGIN_ID = 'kinfold.recall'

const POLL_MS = 1_000
const TOAST_MS = 8_000
/** How long a session's list stays up when nothing follows it. */
const LIST_MS = 12_000
/** How long a list is left alone before the next toast may replace it. */
const LIST_HOLD_MS = 6_000

const header = (what: string): string[] => [
  `// ${SHIM_MARKER}: written by \`kinfold install\`, removed by \`kinfold uninstall\`.`,
  `// ${what}`,
]

/** Where the folder goes: beside Kinfold's plugin file, in OpenCode's plugins directory. */
export function opencodeTuiDir(env: InstallEnv): string {
  return join(env.homeDir, '.config', 'opencode', 'plugins', OPENCODE_TUI_DIR)
}

const isOurs = (text: string): boolean => {
  const first = text.split('\n', 1)[0] ?? ''
  return first.startsWith(`// ${SHIM_MARKER}:`) || first.startsWith(`// ${LEGACY_SHIM_MARKER}:`)
}

function parts(env: InstallEnv): { path: string; content: string }[] {
  const dir = opencodeTuiDir(env)
  return [
    { path: join(dir, OPENCODE_TUI_SERVER_FILE), content: opencodeTuiServerContent() },
    { path: join(dir, OPENCODE_TUI_FILE), content: opencodeTuiContent(env.dataDir) },
  ]
}

/**
 * The folder's two files, written when missing or out of date. A file there
 * that Kinfold did not write is never replaced: the toast is then left out and
 * the install goes on, since capture and memory do not depend on it.
 */
export function opencodeTuiInstallActions(env: InstallEnv): Action[] {
  const dir = opencodeTuiDir(env)
  const current = parts(env).map((part) => ({ ...part, before: readTextOrNull(part.path) }))
  const foreign = current.find((part) => part.before !== null && part.before.trim() !== '' && !isOurs(part.before))
  if (foreign !== undefined) {
    env.out(`opencode: ${foreign.path} is not a Kinfold file; the recall toast is not installed`)
    return []
  }
  const writes = current.filter((part) => part.before !== part.content)
    .map((part): Action => ({ kind: 'write', path: part.path, content: part.content, mode: FILE_MODE, summary: describeTextChange(part.before, part.content) ?? 'unchanged' }))
  if (writes.length === 0) return []
  return [...(existsSync(dir) ? [] : [{ kind: 'mkdir', path: dir, mode: DIR_MODE } as const]), ...writes]
}

/** Our files out, and the folder with them when nothing else is in it. */
export function opencodeTuiUninstallActions(env: InstallEnv): Action[] {
  const dir = opencodeTuiDir(env)
  if (!existsSync(dir)) return []
  const ours = parts(env).filter((part) => {
    const text = readTextOrNull(part.path)
    return text !== null && isOurs(text)
  })
  const removals = ours.map((part): Action => ({ kind: 'remove', path: part.path, summary: 'the Kinfold recall toast for OpenCode' }))
  const names = new Set(ours.map((part) => part.path))
  const others = readdirSync(dir).filter((name) => !names.has(join(dir, name)))
  return others.length === 0 ? [...removals, { kind: 'remove', path: dir, summary: 'the folder of the Kinfold recall toast for OpenCode', recursive: true }] : removals
}

/** The server part: present so OpenCode's server lists this folder, which is what makes the TUI load tui.js. */
export function opencodeTuiServerContent(): string {
  return [
    ...header('Kinfold\'s recall toast lives in tui.js beside this file; this part registers nothing.'),
    `export default { id: ${JSON.stringify(OPENCODE_TUI_PLUGIN_ID)}, setup() {} };`,
    '',
  ].join('\n')
}

/**
 * The part both agents share, as source: `startRecallToasts(show)` polls the
 * daemon and hands each toast to `show`, and returns the function that stops
 * it. It asks for the prompts the agent sent (their recall line) and for the
 * sessions that started (their first-screen list). A new toast replaces the
 * one on screen (seen in OpenCode 2.2.5), and a session's list and its first
 * prompt's line arrive within a second or two of each other, so a toast that
 * follows a list waits until the list has been up for LIST_HOLD_MS.
 */
export function recallWatcherSource(dataDir: string, host: string): string {
  return `import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = ${JSON.stringify(dataDir)};
const HOST = ${JSON.stringify(host)};
const POLL_MS = ${POLL_MS};
const TOAST_MS = ${TOAST_MS};
const LIST_MS = ${LIST_MS};
const LIST_HOLD_MS = ${LIST_HOLD_MS};

function readText(name) {
  try {
    return readFileSync(join(DATA_DIR, name), 'utf8');
  } catch {
    return null;
  }
}

function readJson(name) {
  try {
    return JSON.parse(readText(name) ?? 'null');
  } catch {
    return null;
  }
}

// Where the daemon listens, read each time: a daemon that restarted has a new port and token.
function endpoint() {
  const info = readJson('daemon.json');
  const token = (readText('daemon.token') ?? '').trim();
  return info !== null && Number.isInteger(info.port) && token !== '' ? { port: info.port, token } : null;
}

// The recall line is a setting: display.json says whether to show it. Missing means shown.
function shown() {
  return readJson('display.json')?.showRecall !== false;
}

function startRecallToasts(show) {
  let cursor = null;
  let startCursor = null;
  let busy = false;
  let stopped = false;
  // When the next toast may go up without wiping a list that has not had its time.
  let freeAt = 0;
  const waiting = new Set();
  const put = (text, sessionId, duration, hold) => {
    const toast = {
      title: 'Kinfold',
      message: text.replace(/^kinfold · /, ''),
      variant: 'info',
      duration,
      ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionID: sessionId } : {}),
    };
    const now = Date.now();
    const at = Math.max(now, freeAt);
    freeAt = at + hold;
    if (at <= now) {
      show(toast);
      return;
    }
    const timer = setTimeout(() => {
      waiting.delete(timer);
      if (!stopped) show(toast);
    }, at - now);
    waiting.add(timer);
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const at = endpoint();
      if (at === null) return;
      const query = new URLSearchParams({ host: HOST });
      if (cursor !== null) query.set('after', String(cursor));
      query.set('startsAfter', startCursor === null ? 'now' : String(startCursor));
      const response = await fetch('http://127.0.0.1:' + at.port + '/watch?' + query, {
        headers: { authorization: 'Bearer ' + at.token },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return;
      const body = await response.json();
      if (!Number.isSafeInteger(body?.cursor) || !Array.isArray(body.rows)) return;
      // The first answer only says where "now" is: prompts and sessions from before this TUI opened are not replayed.
      const first = cursor === null;
      const firstStarts = startCursor === null;
      cursor = body.cursor;
      // A daemon from before session starts sends no start cursor; it is asked again each time, at no cost.
      if (Number.isSafeInteger(body.startCursor)) startCursor = body.startCursor;
      if (stopped || !shown()) return;
      // The list before the line: a session starts before its first prompt is answered.
      for (const start of !firstStarts && Array.isArray(body.starts) ? body.starts : []) {
        if (typeof start?.list !== 'string' || start.list === '') continue;
        put(start.list, start.hostSessionId, LIST_MS, LIST_HOLD_MS);
      }
      for (const row of first ? [] : body.rows) {
        if (typeof row?.line !== 'string' || row.line === '') continue;
        put(row.line, row.hostSessionId, TOAST_MS, 0);
      }
    } catch {
      // A daemon that is down or slow shows nothing; the next tick asks again.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, POLL_MS);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const pending of waiting) clearTimeout(pending);
    waiting.clear();
  };
}
`
}

/** The TUI part. `host` is the agent id the daemon knows this agent's prompts by. */
export function opencodeTuiContent(dataDir: string, host: string = 'opencode'): string {
  return `${header('Shows what Kinfold recalled as toasts: a list when a session starts, a line for each prompt. For the user only: nothing here reaches a model.').join('\n')}
import { Plugin } from '@opencode/plugin/tui';
${recallWatcherSource(dataDir, host)}
export default Plugin.define({
  id: ${JSON.stringify(OPENCODE_TUI_PLUGIN_ID)},
  setup(context) {
    return startRecallToasts((toast) => context.ui.toast.show(toast));
  },
});
`
}
