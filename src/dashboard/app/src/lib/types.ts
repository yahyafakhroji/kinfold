// The daemon's answers, as the pages read them. These mirror the daemon's own
// types (src/store/list-reads.ts, src/dashboard/overview.ts, saved.ts and the
// settings routes); the app is built apart from the daemon, so they are
// restated here rather than imported.

export type SortDir = 'asc' | 'desc'

export interface ListPage<T> {
  rows: T[]
  total: number
  page: number
  pageSize: number
  sort: string
  dir: SortDir
}

export type Saved =
  | { kind: 'measured'; status: 'saving' | 'cost' | 'no-difference'; tokens: number | null; turnsCompared: number }
  | { kind: 'estimate'; tokens: number; partial: boolean }
  | { kind: 'none' }

export interface SessionRow {
  id: number
  startedAt: number
  lastEventAt: number
  endedAt: number | null
  host: string
  projectKey: string
  project: string
  device: string | null
  prompts: number
  promptsWithMemory: number
  saved: Saved
}

export interface SessionHeader extends SessionRow {
  cwd: string
  startMemories: number
}

export interface Recalled {
  id: number
  title: string
  part: 'new' | 'related'
}

export interface SessionTurn {
  promptNumber: number
  at: number
  prompt: string
  reply: string | null
  expired: boolean
  recalled: Recalled[]
  recallKnown: boolean
  heldOut: boolean
  late: boolean
  saved: { id: number; title: string; type: string }[]
  summary: { request: string | null; learned: string | null; completed: string | null; nextSteps: string | null } | null
}

export interface TurnsPage {
  turns: SessionTurn[]
  nextAfter: number | null
}

export interface MemoryRow {
  id: number
  title: string
  type: string
  projectKey: string
  project: string
  host: string
  device: string | null
  sessionId: number | null
  occurredAt: number
  recallCount: number
  contradicted: boolean
}

export interface MemoryLink {
  id: number
  title: string
  evidence: string
  kind: 'confirms' | 'updates' | 'contradicts'
  direction: 'outgoing' | 'incoming'
  applied: boolean
  current: boolean
}

export interface MemoryDetail {
  id: number
  title: string
  type: string
  evidence: string
  projectKey: string
  projectName: string | null
  host: string
  device: string | null
  sessionId: number | null
  promptNumber: number | null
  narrative: string
  facts: string[]
  files: string[]
  occurredAt: number
  createdAt: number
  recallCount: number
  contradictedBy: number | null
  related: { id: number; title: string; evidence: string; relation: 'contradicted_by' | 'contradicts' }[]
  links: MemoryLink[]
}

export const ACTIVITY_KINDS = ['recall', 'save', 'summary', 'observer-failed', 'backup', 'restore', 'update-installed', 'sign-in', 'device-paired'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export interface ActivityRow {
  id: number
  at: number
  kind: ActivityKind
  host: string | null
  projectKey: string | null
  project: string | null
  sessionId: number | null
  device: string | null
  count: number | null
  detail: string | null
}

export interface DeviceRow {
  device: string
  name: string | null
  sessions: number
  lastSeenAt: number | null
}

export interface ProjectRow {
  key: string
  name: string
  memories: number
  sessions: number
  lastActiveAt: number | null
}

export interface Kept<T> {
  value: T
  asOf: number
  refreshing: boolean
}

export interface SavedTotals {
  measured: { tokens: number; sessions: number }
  estimate: { tokens: number; sessions: number; partial: boolean }
}

export interface Overview {
  memories: number
  projects: number
  sessions: number
  week: { sessions: number; prompts: number; promptsWithMemory: number }
  saved: SavedTotals
  failing: { host: string; provider: string; errorClass: string; at: number }[]
  recordsSince: number | null
}

export type Measured =
  | { status: 'not-enough'; heldOut: number; normal: number; minSample: number }
  | { status: 'saving' | 'cost' | 'no-difference'; perTurn: number; low: number; high: number; heldOut: number; normal: number }

export interface Impact {
  window: string
  since: number
  countingSince: number | null
  context: { host: string; sessions: number; prompts: number; startTokens: number; promptTokens: number; tokens: number; heldOut: number; tokensPerSession: number | null; tokensPerPrompt: number | null }[]
  observer: { host: string; runs: number; reported: number; inputTokens: number; outputTokens: number }[]
  embedding: { calls: number; texts: number }
  holdout: { on: boolean; hosts: string[] }
  measured: [string, Measured][]
  saved: SavedTotals
}

export type CentralStatus =
  | { role: 'local' }
  | { role: 'hub'; listening: string | null; hubName: string | null; error: string | null; devices: { id: string; name: string; pairedAt: number }[] }
  /** failure: the last call's failure kind ('timeout' is a busy hub); absent from a daemon older than 0.6.0. */
  | { role: 'device'; hub: string; address: string; deviceId: string; reachable: boolean; failure?: string | null; problem: string | null; queued: number; lastContactAt: number | null }

export interface UpdateView {
  notice: { version: string; message: string } | null
  release: { version: string; changes: string[]; breaking: string[]; staged: boolean; installable: boolean } | null
  settings?: { level: 'off' | 'notify' | 'patch'; beta: boolean }
  install: { version: string; state: string; message?: string | null } | null
}

export interface RestoreStatus {
  state: 'idle' | 'running' | 'done' | 'failed'
  step: string | null
  lines: string[]
  error: string | null
  kept?: { replacedAt: number } | null
  lastBackupAt?: number | null
}

export interface Facets {
  projects: { value: string; label: string; observations: number }[]
  hosts: { value: string; label: string; observations: number }[]
  types: { value: string; label: string; observations: number }[]
}
