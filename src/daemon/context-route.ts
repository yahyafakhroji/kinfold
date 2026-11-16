// POST /context in the daemon: resolve the project from cwd, build or match
// what the channel asks for (the pack, or the prompt-time delta), and record
// one injections row with how long that took (duration_ms, schema v6). The
// timer covers project resolution and the build or match, and stops before
// the injection write, so the number is what a host waits on, not our audit.
// A prompt that carries its text also gets related memory (prompt-context.ts), so
// the timer includes its wait on the embedding. Such an answer that took longer
// than its host waits (shownBudgetMs) is recorded with late = 1: watch and
// Sessions show it, marked, and nothing else counts it as delivered, so the
// delta offers its new ids again with the next prompt. Showing a memory twice
// is the cheaper mistake than losing it to the session.
// Logs carry ids, counts and durations; never the text, the prompt or the cwd.

import { DAEMON_SHARE_MS } from '../context/client'
import { DAEMON_ONLY_TIMEOUT_MS } from '../context/daemon'
import { HOLDOUT_HOSTS, HOLDOUT_RATE } from '../context/holdout'
import { type LateMatches, createLateMatches } from '../context/late-matches'
import { type PreparedContext, prepareContext, recordServed } from '../context/packs'
import { type PromptContextDeps, createEmbedSlots, preparePromptContext } from '../context/prompt-context'
import { FIRST_SCREEN_ROWS } from '../context/recall-line'
import { type ContextDisplay, type ContextRequest, type ContextResult, EMPTY_CONTEXT, type UpdateNotice } from '../context/types'
import { firstScreenFor, titlesFor } from '../store/context-store'
import { peekNotice, takeNotice } from '../update/notice'
import type { Database } from '../sqlite/types'
import type { ProjectKeyResolver } from '../store/project-key'
import { type ServedRelated, recordRelatedServed } from '../store/related-served-store'
import type { SemanticAnswer, SemanticRequest } from '../vectors/search'

export interface ContextRouteDeps {
  db: Database
  projectKeyFor: ProjectKeyResolver
  log: (line: string) => void
  /** The daemon's vector search; absent or null means keyword matches only. */
  semantic?: ((request: SemanticRequest) => Promise<SemanticAnswer>) | null
  late?: LateMatches
  gate?: PromptContextDeps['gate']
  semanticDeadlineMs?: number
  now?: () => number
  /** Monotonic ms for the duration. */
  clock?: () => number
  /**
   * The opt-in impact test: `on` reads the setting, `pick` decides one prompt
   * (default: HOLDOUT_RATE at random). Absent means no prompt is ever held out.
   */
  holdout?: { on: () => boolean; pick?: () => boolean }
  /** Where update-check.json lives and which version is running; absent means no update notice. */
  updates?: { dataDir: string; version: string; envVars?: () => Readonly<Record<string, string | undefined>>; /** This daemon applies patch releases itself, so their notice is held back. */ canAutoUpdate?: boolean }
}

/** Past this the hook has likely aborted (it waits DAEMON_SHARE_MS, connection included). */
export const PROMPT_SERVE_BUDGET_MS = DAEMON_SHARE_MS - 20

export { HOLDOUT_HOSTS, HOLDOUT_RATE }

type Prepared = PreparedContext & { promptDetail: string; relatedText: string; relatedServed: ServedRelated[] }

const NOTHING: Prepared = { ...EMPTY_CONTEXT, rebuilt: false, promptDetail: '', relatedText: '', relatedServed: [] }

/** Titles and a header for the ids the answer carries; it adds no id of its own. */
function displayFor(deps: ContextRouteDeps, request: ContextRequest, projectKey: string, prepared: Prepared, heldOut: boolean): ContextDisplay {
  if (heldOut) return { heldOut: true }
  if (request.channel === 'prompt') {
    const titles = titlesFor(deps.db, prepared.observationIds)
    const related = new Set(prepared.relatedServed.map((line) => line.observationId))
    return { recalled: prepared.observationIds.map((id) => ({ id, title: titles.get(id) ?? '', part: related.has(id) ? 'related' as const : 'new' as const })) }
  }
  const firstScreen = firstScreenFor(deps.db, { projectKey, host: request.host, hostSessionId: request.hostSessionId, ids: prepared.observationIds, rows: FIRST_SCREEN_ROWS })
  return firstScreen === null ? {} : { firstScreen }
}

/**
 * Session start and OpenCode's first request carry the notice; prompt deltas never do.
 * It is marked shown only when the answer beat the host's wait: a slower one may
 * have been abandoned, and a notice nobody saw must come again next session.
 */
/** How long a host waits for the answer; an answer inside that was seen. OpenCode's plugin waits longer than the hooks do. */
export function shownBudgetMs(host: string): number {
  return host === 'opencode' ? DAEMON_ONLY_TIMEOUT_MS : PROMPT_SERVE_BUDGET_MS
}

function updateNoticeFor(updates: ContextRouteDeps['updates'], request: ContextRequest, durationMs: number, at: number): UpdateNotice | null {
  if (updates === undefined || request.channel === 'prompt') return null
  try {
    const env = updates.envVars?.() ?? process.env
    const context = { capable: updates.canAutoUpdate === true, now: at }
    return durationMs <= shownBudgetMs(request.host) ? takeNotice(updates.dataDir, request.host, updates.version, env, context) : peekNotice(updates.dataDir, request.host, updates.version, env, context)
  } catch {
    return null
  }
}

/** A release to install rides on the key every hook and plugin has always read; the newer kinds get their own, which an older reader ignores. */
function noticeField(notice: UpdateNotice | null): Pick<ContextResult, 'updateNotice' | 'selfNotice'> {
  if (notice === null) return {}
  return notice.kind === undefined || notice.kind === 'available' ? { updateNotice: notice } : { selfNotice: notice }
}

export function contextHandler(deps: ContextRouteDeps): (request: ContextRequest) => Promise<ContextResult> {
  const now = deps.now ?? Date.now
  const clock = deps.clock ?? (() => performance.now())
  const prompt: PromptContextDeps = {
    db: deps.db,
    semantic: deps.semantic ?? null,
    late: deps.late ?? createLateMatches(),
    log: deps.log,
    slots: createEmbedSlots(),
    now,
    clock,
    ...(deps.gate !== undefined ? { gate: deps.gate } : {}),
    ...(deps.semanticDeadlineMs !== undefined ? { deadlineMs: deps.semanticDeadlineMs } : {}),
  }
  const prepare = async (request: ContextRequest, projectKey: string, at: number, startedAt: number): Promise<Prepared> => {
    if (request.channel !== 'prompt' || request.prompt === undefined) return { ...prepareContext(deps.db, request, projectKey, at), promptDetail: '', relatedText: '', relatedServed: [] }
    const answer = await preparePromptContext(prompt, request, projectKey, at, startedAt)
    return { text: answer.text, observationIds: answer.observationIds, tokens: answer.tokens, rebuilt: false, relatedText: answer.relatedText, relatedServed: answer.relatedServed,
      promptDetail: ` related=${answer.related} semantic=${answer.semantic} delta_ms=${answer.deltaMs} related_ms=${answer.relatedMs}` }
  }
  return async (request) => {
    const startedAt = clock()
    const at = now()
    const projectKey = deps.projectKeyFor(request.cwd).key
    const keyMs = Math.round(clock() - startedAt)
    // Held out before anything is matched: the delta is not computed, so its cursor stays where it was and the
    // same memory arrives with the next prompt that is not held out; parked late hits wait for that prompt too.
    const heldOut = request.channel === 'prompt' && HOLDOUT_HOSTS.includes(request.host) && deps.holdout?.on() === true
      && (deps.holdout.pick ?? (() => Math.random() < HOLDOUT_RATE))()
    const prepared = heldOut || request.displayOnly === true ? NOTHING : await prepare(request, projectKey, at, startedAt)
    const durationMs = Math.round(clock() - startedAt)
    const late = request.prompt !== undefined && durationMs > shownBudgetMs(request.host) && prepared.observationIds.length > 0
    const injectionId = recordServed(deps.db, request, projectKey, prepared, at, durationMs, { relatedCount: prepared.relatedServed.length, heldOut, late })
    // Labels only for lines the host got: an answer past its wait was never shown.
    if (injectionId !== null && !late) recordRelatedServed(deps.db, prepared.relatedServed, { projectKey, host: request.host, occurredAt: at })
    deps.log(`context host=${request.host} channel=${request.channel} injection=${injectionId ?? 'none'}${late ? ' late=1' : ''} ids=${prepared.observationIds.length}`
      + ` tokens=${prepared.tokens} rebuilt=${prepared.rebuilt}${prepared.promptDetail}${heldOut ? ' held_out=1' : ''} key_ms=${keyMs} ms=${durationMs}`)
    const notice = updateNoticeFor(deps.updates, request, durationMs, at)
    return {
      text: prepared.text, observationIds: prepared.observationIds, tokens: prepared.tokens, ...(prepared.relatedText !== '' ? { relatedText: prepared.relatedText } : {}),
      display: displayFor(deps, request, projectKey, prepared, heldOut), ...noticeField(notice),
    }
  }
}
