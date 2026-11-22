// The plugin file Kinfold puts in Amp's plugins folder. Amp loads a .ts file
// there with Bun and calls its default export with the plugin API
// (ampcode.com/manual/plugin-api and /manual/plugins, checked 2026-11-13). The
// file carries no Kinfold code: each handler hands the event to the same
// `kinfold hook --host amp` a command-hook agent runs, by argv through
// Bun.spawn (no shell, so Windows needs no quoting), and reads the one line it
// prints. Only top-level plugin APIs are used; nothing under amp.experimental.
//   session.start has no return channel, so the pack it fetches waits for the
//     thread's next agent.start. A run that ends first drops it, and only the
//     latest few threads' packs are held, so the map can't grow with threads
//     that never prompt.
//   agent.start returns { message: { content, display: false } }, which Amp
//     appends after the user's text: the pack (first turn) and the delta. The
//     delta is asked for at once, beside a pack still on its way, so the
//     prompt waits for the slower of the two rather than both in turn.
//   tool.result and agent.end return nothing, keeping Amp's own result, and
//     do not wait for the hook; agent.end's message list stays behind.
//   What the hook says to show the user (its `notify` line: what Kinfold
//     recalled, or the list at session start) goes to ctx.ui.notify, which Amp
//     shows as a notification and never adds to the conversation. An Amp
//     without that function, or one that throws from it, shows nothing and
//     still gets its context.
// A hook that fails, times out or prints nothing adds nothing.

import type { EntryCommand } from '../../../resources/install-plan/entry'
import { SHIM_MARKER } from '../../../system/names'

/** How long a handler waits for the hook; the hook's own context budget is 300 ms. */
const HOOK_TIMEOUT_MS = 5000

/** Threads whose session pack can wait for a first prompt at once. */
const MAX_PENDING_PACKS = 16

export function ampPluginContent(entry: EntryCommand): string {
  return `// ${SHIM_MARKER}: written by \`kinfold install\`, removed by \`kinfold uninstall\`.
// Hands Amp's events to Kinfold's hook and returns the context it prints.
import { fileURLToPath } from 'node:url';

const HOOK = ${JSON.stringify([entry.command, ...entry.args])};
const TIMEOUT_MS = ${HOOK_TIMEOUT_MS};
const MAX_PENDING = ${MAX_PENDING_PACKS};
const starts = new Map();
const NOTHING = { content: null, notify: null };

export const description = 'Kinfold: shared memory across coding agents';

// A file: URI goes through node:url, which gives C:\\... on Windows where a
// URI's own path would read /C:/...; Amp's helper covers any other scheme.
function cwdOf(amp, ctx) {
  try {
    const root = ctx?.system?.workspaceRoot ?? amp?.system?.workspaceRoot ?? null;
    if (root !== null && root !== undefined) {
      const text = String(root);
      const path = text.startsWith('file:') ? fileURLToPath(text) : typeof amp?.helpers?.filePathFromURI === 'function' ? amp.helpers.filePathFromURI(root) : text;
      if (typeof path === 'string' && path !== '') return path;
    }
  } catch {}
  return process.cwd();
}

async function send(payload) {
  try {
    const child = Bun.spawn(HOOK, { stdin: new Blob([JSON.stringify(payload)]), stdout: 'pipe', stderr: 'ignore' });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    const out = await new Response(child.stdout).text();
    await child.exited;
    clearTimeout(timer);
    const line = out.trim();
    if (line === '') return NOTHING;
    const answer = JSON.parse(line);
    const content = answer?.message?.content;
    const notify = answer?.notify;
    return {
      content: typeof content === 'string' && content !== '' ? content : null,
      notify: typeof notify === 'string' && notify !== '' ? notify : null,
    };
  } catch {
    return NOTHING;
  }
}

// For the user only: a notification, never part of the conversation.
function tell(ctx, text) {
  try {
    if (text !== null && typeof ctx?.ui?.notify === 'function') ctx.ui.notify(text);
  } catch {}
}

const threadOf = (event) => ({ id: event?.thread?.id });

export default function (amp) {
  amp.on('session.start', (event, ctx) => {
    const id = event?.thread?.id;
    starts.delete(id);
    starts.set(id, send({ event: 'session.start', thread: threadOf(event), cwd: cwdOf(amp, ctx) }).then((answer) => {
      tell(ctx, answer.notify);
      return answer.content;
    }));
    if (starts.size > MAX_PENDING) starts.delete(starts.keys().next().value);
  });

  amp.on('agent.start', async (event, ctx) => {
    const id = event?.thread?.id;
    const start = starts.get(id);
    starts.delete(id);
    const [pack, delta] = await Promise.all([
      start ?? null,
      send({ event: 'agent.start', thread: threadOf(event), cwd: cwdOf(amp, ctx), message: event?.message, id: event?.id }),
    ]);
    tell(ctx, delta.notify);
    const content = [pack, delta.content].filter((text) => text !== null).join('\\n\\n');
    return content === '' ? undefined : { message: { content, display: false } };
  });

  amp.on('tool.result', (event, ctx) => {
    void send({ event: 'tool.result', thread: threadOf(event), cwd: cwdOf(amp, ctx), toolUseID: event?.toolUseID, tool: event?.tool, input: event?.input, status: event?.status, error: event?.error, output: event?.output });
    return undefined;
  });

  amp.on('agent.end', (event, ctx) => {
    starts.delete(event?.thread?.id);
    void send({ event: 'agent.end', thread: threadOf(event), cwd: cwdOf(amp, ctx), message: event?.message, id: event?.id, status: event?.status });
    return undefined;
  });
}
`
}
