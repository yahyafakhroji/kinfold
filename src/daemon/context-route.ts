// POST /context in the daemon: resolve the project from cwd, build or match
// what the channel asks for (the pack, or the prompt-time delta), and record
// one injections row with how long that took (duration_ms, schema v6). The
// timer covers project resolution and the build or match, and stops before
// the injection write, so the number is what a host waits on, not our audit.
// A prompt that carries its text also gets related memory (prompt-context.ts), so
// the timer includes its wait on the embedding. Such an answer that took longer than the hook waits (PROMPT_SERVE_BUDGET_MS) is
// not recorded: the hook gave up, and a row marked sent but never shown would
// be lost to the session. Showing it again later is the cheaper mistake.
// Logs carry ids, counts and durations; never the text, the prompt or the cwd.

import { DAEMON_SHARE_MS } from '../context/client'
import { type LateMatches, createLateMatches } from '../context/late-matches'
import { type PreparedContext, prepareContext, recordServed } from '../context/packs'
import { type PromptContextDeps, createEmbedSlots, preparePromptContext } from '../context/prompt-context'
import type { ContextRequest, ContextResult, UpdateNotice } from '../context/types'
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
  /** Where update-check.json lives and which version is running; absent means no update notice. */
  updates?: { dataDir: string; version: string }
}

/** Past this the hook has likely aborted (it waits DAEMON_SHARE_MS, connection included). */
export const PROMPT_SERVE_BUDGET_MS = DAEMON_SHARE_MS - 20

type Prepared = PreparedContext & { promptDetail: string; relatedText: string; relatedServed: ServedRelated[] }

/**
 * Session start and OpenCode's first request carry the notice; prompt deltas never do.
 * It is marked shown only when the answer beat the hook's wait: a slower one may
 * have been abandoned, and a notice nobody saw must come again next session.
 */
function updateNoticeFor(updates: ContextRouteDeps['updates'], request: ContextRequest, durationMs: number): UpdateNotice | null {
  if (updates === undefined || request.channel === 'prompt') return null
  try {
    return durationMs <= PROMPT_SERVE_BUDGET_MS ? takeNotice(updates.dataDir, request.host, updates.version) : peekNotice(updates.dataDir, request.host, updates.version)
  } catch {
    return null
  }
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
    const prepared = await prepare(request, projectKey, at, startedAt)
    const durationMs = Math.round(clock() - startedAt)
    const overBudget = request.prompt !== undefined && durationMs > PROMPT_SERVE_BUDGET_MS && prepared.observationIds.length > 0
    const injectionId = overBudget ? 'skipped_late' : recordServed(deps.db, request, projectKey, prepared, at, durationMs)
    // Labels only for lines the hook got: an answer past the budget was never shown.
    if (typeof injectionId === 'number') recordRelatedServed(deps.db, prepared.relatedServed, { projectKey, host: request.host, occurredAt: at })
    deps.log(`context host=${request.host} channel=${request.channel} injection=${injectionId ?? 'none'} ids=${prepared.observationIds.length}`
      + ` tokens=${prepared.tokens} rebuilt=${prepared.rebuilt}${prepared.promptDetail} key_ms=${keyMs} ms=${durationMs}`)
    const notice = updateNoticeFor(deps.updates, request, durationMs)
    return { text: prepared.text, observationIds: prepared.observationIds, tokens: prepared.tokens, ...(prepared.relatedText !== '' ? { relatedText: prepared.relatedText } : {}), ...(notice !== null ? { updateNotice: notice } : {}) }
  }
}
