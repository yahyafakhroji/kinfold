// The database schema as an append-only list of migrations. PRAGMA user_version
// records how many have run; never edit a shipped entry, add a new one.
// Every *_at column is epoch milliseconds; occurred_at is the host's event time,
// kept apart from ingest time (claude-mem summary 5490 is why).

import type { Database } from '../sqlite/types'
import { backfillSummarySharing } from './summary-migration'
import { backfillReplies } from './visible-migration'

const V1_CORE = `
CREATE TABLE projects (
  key TEXT PRIMARY KEY,
  key_kind TEXT NOT NULL CHECK (key_kind IN ('git-remote', 'git-root', 'path')),
  display_name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  host TEXT NOT NULL,
  host_session_id TEXT NOT NULL,
  project_key TEXT NOT NULL REFERENCES projects(key),
  cwd TEXT NOT NULL,
  host_version TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_event_at INTEGER NOT NULL,
  UNIQUE (host, host_session_id)
);
CREATE INDEX sessions_by_project ON sessions(project_key, last_event_at DESC);

CREATE TABLE prompts (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  host_prompt_id TEXT,
  text TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  UNIQUE (session_id, prompt_number)
);
CREATE INDEX prompts_by_host_id ON prompts(session_id, host_prompt_id);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER,
  kind TEXT NOT NULL,
  tool_name TEXT,
  payload TEXT,
  withheld TEXT,
  redactions TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  observer_state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX events_by_session ON events(session_id, occurred_at);
CREATE INDEX events_pending ON events(session_id, occurred_at) WHERE observer_state = 'pending';
CREATE INDEX events_by_hash ON events(content_hash);
`

const V1_MEMORY = `
CREATE TABLE observations (
  id INTEGER PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key),
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  prompt_number INTEGER,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  narrative TEXT NOT NULL DEFAULT '',
  facts TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL CHECK (evidence IN ('tool-verified', 'interpretation', 'user-stated')),
  source_event_ids TEXT NOT NULL DEFAULT '[]',
  contradicted_by INTEGER REFERENCES observations(id) ON DELETE SET NULL,
  observer_model TEXT,
  content_hash TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX observations_by_project ON observations(project_key, occurred_at DESC);
CREATE INDEX observations_current ON observations(project_key, occurred_at DESC) WHERE contradicted_by IS NULL;

CREATE VIRTUAL TABLE observations_fts USING fts5(
  title, narrative, facts, content = 'observations', content_rowid = 'id'
);
CREATE TRIGGER observations_fts_insert AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, narrative, facts) VALUES (new.id, new.title, new.narrative, new.facts);
END;
CREATE TRIGGER observations_fts_delete AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts)
    VALUES ('delete', old.id, old.title, old.narrative, old.facts);
END;
CREATE TRIGGER observations_fts_update AFTER UPDATE OF title, narrative, facts ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts)
    VALUES ('delete', old.id, old.title, old.narrative, old.facts);
  INSERT INTO observations_fts(rowid, title, narrative, facts) VALUES (new.id, new.title, new.narrative, new.facts);
END;

CREATE TABLE summaries (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  request TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  occurred_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (session_id, prompt_number)
);
`

const V1_DELIVERY = `
CREATE TABLE context_packs (
  id INTEGER PRIMARY KEY,
  project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
  host_profile TEXT NOT NULL,
  body TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  built_from_max_id INTEGER NOT NULL,
  built_at INTEGER NOT NULL,
  UNIQUE (project_key, host_profile)
);

CREATE TABLE injections (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  observation_ids TEXT NOT NULL DEFAULT '[]',
  channel TEXT NOT NULL CHECK (channel IN ('start', 'prompt', 'mcp')),
  tokens INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL
);

CREATE TABLE observer_settings (
  id INTEGER PRIMARY KEY,
  host TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  credential_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE redaction_findings (
  id INTEGER PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  found_at INTEGER NOT NULL,
  action TEXT
);
`

// v2: the observer. An event moves pending -> processing -> done, or
// to failed with an attempt count and a retry time; observer_runs records every
// call, including the failed ones the dashboard has to show (no silent fallback).
const V2_OBSERVER = `
ALTER TABLE events ADD COLUMN observer_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN observer_retry_at INTEGER;
CREATE INDEX events_failed ON events(session_id, observer_retry_at) WHERE observer_state = 'failed';

CREATE TABLE observer_runs (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  error TEXT,
  event_count INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX observer_runs_by_session ON observer_runs(session_id, started_at DESC);

CREATE INDEX observations_by_hash ON observations(project_key, content_hash);
`

// v3: context delivery. A pack keeps the ids it injects so the
// read-only fallback can report them. injections is rebuilt because a CHECK
// cannot be altered in place: channels become the two delivery moments
// ('start' rows map to 'session_start'), and a row can name the host session
// before its sessions row exists (SessionStart is injected before the drain).
// observer_fingerprints holds the last seen settings and credential HMAC per
// host, so a change can send exhausted failed events back to pending.
const V3_CONTEXT = `
ALTER TABLE context_packs ADD COLUMN observation_ids TEXT NOT NULL DEFAULT '[]';

CREATE TABLE injections_v3 (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  host_session_id TEXT,
  project_key TEXT,
  observation_ids TEXT NOT NULL DEFAULT '[]',
  channel TEXT NOT NULL CHECK (channel IN ('session_start', 'request', 'prompt', 'mcp')),
  tokens INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL
);
INSERT INTO injections_v3 (id, session_id, host, observation_ids, channel, tokens, occurred_at)
  SELECT id, session_id, host, observation_ids, CASE channel WHEN 'start' THEN 'session_start' ELSE channel END, tokens, occurred_at
  FROM injections;
DROP TABLE injections;
ALTER TABLE injections_v3 RENAME TO injections;
CREATE INDEX injections_by_host_session ON injections(host, host_session_id);

CREATE TABLE observer_fingerprints (
  host TEXT PRIMARY KEY,
  settings TEXT NOT NULL,
  credential TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);
`

// v4: data control. rules_version is the redaction rules version a
// row's text went through when it was written; scanned_version is the newest
// version the leak scanner checked it under. Rows stored before v4 never
// recorded one, so they read as version 1 and the scanner re-checks them.
// Observer output (observations, summaries) is model text that no rule ran
// over, so the writers store it with scanned_version 0 and the scanner checks
// each new row once. Expiry columns let retention replace text with a marker
// while the row and its metadata stay. data_settings holds retention days
// per table (NULL keeps forever) and the size warning threshold; updated_at 0
// marks a shipped default.
const V4_DATA_CONTROL = `
ALTER TABLE events ADD COLUMN rules_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN scanned_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN payload_expired_at INTEGER;
ALTER TABLE prompts ADD COLUMN rules_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE prompts ADD COLUMN scanned_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE prompts ADD COLUMN text_expired_at INTEGER;
ALTER TABLE observations ADD COLUMN rules_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE observations ADD COLUMN scanned_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE summaries ADD COLUMN rules_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE summaries ADD COLUMN scanned_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX events_by_scan ON events(scanned_version);
CREATE INDEX prompts_by_scan ON prompts(scanned_version);
CREATE INDEX observations_by_scan ON observations(scanned_version);
CREATE INDEX summaries_by_scan ON summaries(scanned_version);
CREATE INDEX events_live_payload ON events(occurred_at) WHERE payload_expired_at IS NULL;
CREATE INDEX prompts_live_text ON prompts(occurred_at) WHERE text_expired_at IS NULL;
CREATE INDEX observations_by_time ON observations(occurred_at);

ALTER TABLE redaction_findings ADD COLUMN field TEXT;
ALTER TABLE redaction_findings ADD COLUMN matches INTEGER NOT NULL DEFAULT 1;
ALTER TABLE redaction_findings ADD COLUMN resolved_at INTEGER;
UPDATE redaction_findings SET action = 'pending' WHERE action IS NULL;
CREATE INDEX findings_by_row ON redaction_findings(table_name, row_id);
CREATE INDEX findings_by_action ON redaction_findings(action, found_at DESC);

CREATE TABLE data_settings (
  key TEXT PRIMARY KEY,
  value INTEGER,
  updated_at INTEGER NOT NULL
);
INSERT INTO data_settings (key, value, updated_at) VALUES
  ('retention.events', 30, 0),
  ('retention.prompts', NULL, 0),
  ('retention.observations', NULL, 0),
  ('retention.summaries', NULL, 0),
  ('size.warn_bytes', 268435456, 0);
`

// v5: observation links. The observer may say a new observation
// confirms, updates or contradicts one the session was shown; every accepted
// link is kept here, and updates/contradicts also set the older row's
// contradicted_by when the evidence rule allows (src/store/observation-links.ts).
// Both ends cascade, so a purge leaves no link behind, and the to_id index
// serves the purge's re-settle and the detail view's incoming links.
const V5_LINKS = `
CREATE TABLE observation_links (
  from_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('confirms', 'updates', 'contradicts')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, kind),
  CHECK (from_id <> to_id)
) WITHOUT ROWID;
CREATE INDEX observation_links_by_to ON observation_links(to_id);
`

// v6: usage metrics. injections.duration_ms is the daemon's time to
// build or match what it served (null for rows written before v6; the
// read-only fallback writes nothing). mcp_reads gets one row per MCP tool
// call, reported by the read-only MCP server to the daemon: which tool,
// which project scope ('*' for all), the observation ids it returned, counts
// and timing. It never holds query text or arguments. project_key has no
// foreign key: a read may name a key the store has never seen. The
// created_at index serves the prompt-time delta ("written since").
const V6_USAGE = `
ALTER TABLE injections ADD COLUMN duration_ms INTEGER;
CREATE INDEX injections_by_time ON injections(occurred_at);
CREATE INDEX observations_by_created ON observations(project_key, created_at);

CREATE TABLE mcp_reads (
  id INTEGER PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  project_key TEXT NOT NULL,
  host TEXT,
  tool TEXT NOT NULL CHECK (tool IN ('search', 'timeline', 'get_observations')),
  returned_ids TEXT NOT NULL DEFAULT '[]',
  rows INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX mcp_reads_by_time ON mcp_reads(occurred_at);
CREATE INDEX mcp_reads_by_project ON mcp_reads(project_key, occurred_at);
`

// v7: shared summaries (src/store/summary-share.ts). prompts.text_hash
// is a sha256 of the trimmed, whitespace-collapsed stored text; a prompt
// identical to a summarized one in the same project points at that summary
// through prompts.summary_id instead of adding a row. repeat_count and
// last_seen_at are recounted from those pointers. The hash backfill and the
// collapse of existing duplicates need sha256, which SQLite lacks, so they
// run as MIGRATION_STEPS[7] in the same transaction.
const V7_SHARED_SUMMARIES = `
ALTER TABLE prompts ADD COLUMN text_hash TEXT;
ALTER TABLE prompts ADD COLUMN summary_id INTEGER REFERENCES summaries(id) ON DELETE SET NULL;
ALTER TABLE summaries ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE summaries ADD COLUMN last_seen_at INTEGER;
CREATE INDEX prompts_by_text_hash ON prompts(text_hash) WHERE text_hash IS NOT NULL;
CREATE INDEX prompts_by_summary ON prompts(summary_id) WHERE summary_id IS NOT NULL;
`

// v8: embeddings for semantic search (src/vectors/). A plain table, not
// a sqlite-vec vec0 virtual table: without the extension loaded SQLite cannot
// even delete from a vec0 table, and an embedding can leak the text it came
// from, so purge, retention and secure_delete must never depend on it. The
// cascade removes a vector with its observation on every connection. The
// embedding is little-endian float32, the layout sqlite-vec's
// vec_distance_cosine reads; only the daemon's search needs the extension.
// A row whose model is not the current one is re-embedded and ignored by search.
const V8_VECTORS = `
CREATE TABLE observation_vectors (
  observation_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL CHECK (dims > 0),
  embedding BLOB NOT NULL CHECK (length(embedding) = dims * 4),
  created_at INTEGER NOT NULL
);
CREATE INDEX observation_vectors_by_model ON observation_vectors(model);
`

/** v9: one row per related line served at prompt time, with the distance and terms that earned it. Ids and numbers only. */
const V9_RELATED_SERVED = `
CREATE TABLE related_served (
  id INTEGER PRIMARY KEY,
  observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  host TEXT NOT NULL,
  distance REAL,
  matched_terms INTEGER NOT NULL CHECK (matched_terms >= 0),
  occurred_at INTEGER NOT NULL
);
CREATE INDEX related_served_by_time ON related_served(occurred_at);
CREATE INDEX related_served_by_observation ON related_served(observation_id);
`

// v10: the daemon's safety gate (src/observer/safety-gate.ts). One row per
// (provider, CLI version, resolved binary path) that ran the planted-instruction
// test, passed or failed with its error class. The model is not part of the key.
const V10_OBSERVER_SAFETY = `
CREATE TABLE observer_safety (
  provider TEXT NOT NULL,
  cli_version TEXT NOT NULL,
  binary_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed','failed')),
  error_class TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (provider, cli_version, binary_path)
);
`

// v11: the vector backlog (which observations still need an embedding in the
// current model and length) is read from this index alone. Without it each
// observation cost a lookup of its vector row, whose embedding fills a page,
// on every indexer tick. The model-only index is a prefix of this one.
const V11_VECTOR_SPACE_INDEX = `
CREATE INDEX observation_vectors_by_space ON observation_vectors(model, dims, observation_id);
DROP INDEX IF EXISTS observation_vectors_by_model;
`

// v12: what the user can see, and what memory costs.
//   prompts.reply_text: the agent's final reply (turn_end's assistantText,
//     already redacted), kept with its prompt and under prompts retention.
//     Replies still in live event payloads are copied by MIGRATION_STEPS[12].
//   injections: which prompt a prompt-time row belongs to (stamped when the
//     prompt is ingested, since the hook asks before the drain), whether recall
//     was held out for the impact test (such a row carries no ids), and how
//     many of its ids were related memory; the rest are new from other sessions.
//   turn_usage: one row per turn whose token usage Kinfold could read (Claude
//     Code's transcript), with held_out, so held-out turns can be compared.
//   observer_runs tokens: what the runner reported, null when it reported none.
//   embedding_calls: calls and texts embedded per UTC day, for the whole
//     store, because the indexer embeds observations of every agent in one batch.
//   data_settings: the two display switches and the date these numbers start.
const V12_VISIBLE = `
ALTER TABLE prompts ADD COLUMN reply_text TEXT;

ALTER TABLE injections ADD COLUMN prompt_number INTEGER;
ALTER TABLE injections ADD COLUMN held_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE injections ADD COLUMN related_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX injections_by_session_prompt ON injections(session_id, prompt_number);

ALTER TABLE observer_runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE observer_runs ADD COLUMN output_tokens INTEGER;
CREATE INDEX observer_runs_by_time ON observer_runs(started_at);

CREATE TABLE turn_usage (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  host TEXT NOT NULL,
  project_key TEXT NOT NULL,
  held_out INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL,
  duration_ms INTEGER,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, prompt_number)
) WITHOUT ROWID;
CREATE INDEX turn_usage_by_time ON turn_usage(occurred_at);

CREATE TABLE embedding_calls (
  day INTEGER PRIMARY KEY,
  calls INTEGER NOT NULL,
  texts INTEGER NOT NULL
);

INSERT INTO data_settings (key, value, updated_at) VALUES
  ('display.show_recall', 1, 0),
  ('impact.holdout', 0, 0),
  ('impact.since', NULL, 0);
`

// v13: an answer that came after the host stopped waiting is recorded too, so
// watch and Sessions can show it. injections.late marks it: those ids were
// probably never shown, so the delta sends them again and the hit-rate and
// cost numbers leave the row out. observations_by_session_prompt serves the
// Sessions turns page (what was saved from each prompt), and prompts_by_time
// the Metrics count of prompts per agent. injections_by_session_prompt stays:
// the observer's injected list and the session purge find rows by session_id
// through it.
const V13_LATE_AND_INDEXES = `
ALTER TABLE injections ADD COLUMN late INTEGER NOT NULL DEFAULT 0;
CREATE INDEX observations_by_session_prompt ON observations(session_id, prompt_number);
CREATE INDEX prompts_by_time ON prompts(occurred_at, session_id);
`

// v14: the base URL of an endpoint observer (the OpenAI-compatible provider
// and Qwen's DashScope region). NULL for every other provider; the URL rules
// live in observer/endpoint.ts, since SQL cannot hold them.
const V14_OBSERVER_ENDPOINT = `
ALTER TABLE observer_settings ADD COLUMN endpoint TEXT;
`

// v15: embedding spaces side by side. observation_vectors is keyed by
// (model, dims, observation_id), so a switch of embedder builds the new space
// while search keeps using the old one. The rebuild copies every row; the
// unique index keeps the name the backlog queries are planned against.
//   vector_spaces: the space search uses ('active') and the one being built
//     ('building'). Each space's vec0 index is vec_space_<id>, made by the
//     daemon, since only it loads sqlite-vec. The space with the most rows
//     starts active, so an existing store searches as before.
//   embedding_settings: the provider the user chose; no row until a choice
//     or the daemon's first-start default.
const V15_EMBEDDING_SPACES = `
CREATE TABLE observation_vectors_v14 (
  id INTEGER PRIMARY KEY,
  observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL CHECK (dims > 0),
  embedding BLOB NOT NULL CHECK (length(embedding) = dims * 4),
  created_at INTEGER NOT NULL
);
INSERT INTO observation_vectors_v14 (observation_id, model, dims, embedding, created_at)
  SELECT observation_id, model, dims, embedding, created_at FROM observation_vectors ORDER BY observation_id;
DROP TABLE observation_vectors;
ALTER TABLE observation_vectors_v14 RENAME TO observation_vectors;
CREATE UNIQUE INDEX observation_vectors_by_space ON observation_vectors(model, dims, observation_id);
CREATE INDEX observation_vectors_by_observation ON observation_vectors(observation_id);

CREATE TABLE vector_spaces (
  id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL CHECK (dims > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'building')),
  -- 1 once vec_space_<id> holds every vector of the space; until then search scans.
  vec_ready INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (model, dims)
);
CREATE UNIQUE INDEX vector_spaces_one_per_state ON vector_spaces(state);
-- A vector deleted anywhere (purge, redaction, retention) leaves its copy in
-- the space's vec0 index, which only the daemon can write. Marking the space
-- not ready sends search back to the scan and the daemon to reconcile at once.
CREATE TRIGGER observation_vectors_deleted AFTER DELETE ON observation_vectors BEGIN
  UPDATE vector_spaces SET vec_ready = 0 WHERE model = OLD.model AND dims = OLD.dims AND vec_ready = 1;
END;
INSERT INTO vector_spaces (model, dims, state, created_at)
  SELECT model, dims, 'active', 0 FROM observation_vectors GROUP BY model, dims ORDER BY count(*) DESC LIMIT 1;

CREATE TABLE embedding_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL CHECK (provider IN ('local', 'openrouter', 'local-llm')),
  llm_url TEXT,
  llm_model TEXT,
  llm_dims INTEGER CHECK (llm_dims IS NULL OR llm_dims > 0),
  updated_at INTEGER NOT NULL
);
`

// v16: one repo, one project. A repo is known by its first commit, so a
// renamed remote, a fork and a clone with no remote are the same repo. A key
// merged into another stays as an alias (merged_into), and each merge keeps
// the row ids it moved, so a split puts back exactly those. A split key is
// held out of automatic merging (merge_held).
const V16_PROJECT_MERGES = `
ALTER TABLE projects ADD COLUMN root_commit TEXT;
ALTER TABLE projects ADD COLUMN merged_into TEXT;
ALTER TABLE projects ADD COLUMN merge_held INTEGER NOT NULL DEFAULT 0;
CREATE INDEX projects_by_root ON projects(root_commit) WHERE root_commit IS NOT NULL;

CREATE TABLE project_merges (
  id INTEGER PRIMARY KEY,
  from_key TEXT NOT NULL,
  into_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('same-repo', 'manual')),
  merged_at INTEGER NOT NULL,
  moved TEXT NOT NULL,
  split_at INTEGER
);
CREATE INDEX project_merges_by_from ON project_merges(from_key, merged_at DESC);
`

// v17: the keyword match at prompt time filters every FTS hit by project,
// contradiction and session. Those columns sit after a row's text, so on the
// table each hit cost a page of text to read (and, encrypted, to decrypt);
// this index holds them alone, and the text is read only for the rows kept.
const V17_RECALL_INDEX = `
CREATE INDEX observations_recall ON observations(id, project_key, contradicted_by, session_id);
`

// v18: what the dashboard shows that nothing recorded before.
//   sessions.device: the machine a session was captured on. A local drain
//     writes 'local'; a hub writes the device id. A device-scoped key
//     (dev-...:path) names its device, so those rows are filled in; any other
//     row stays NULL, shown as not recorded before records.since.
//   observations.recall_count: how many delivered injections carried the
//     row, counted from the injections already stored (late ones left out:
//     they were probably never shown) and kept up by recordInjection.
//   observations.observer_run_id: the run that wrote the row, so the run's
//     tokens can be split over what it made. NULL for rows written before.
//   activity: what happened, for the Activity page. Kinds and counts, never
//     memory text; detail holds a short machine word (an error class, a
//     version). Kept to 90 days and 100,000 rows (src/store/activity-store.ts).
const V18_DASHBOARD_RECORDS = `
ALTER TABLE sessions ADD COLUMN device TEXT;
UPDATE sessions SET device = substr(project_key, 1, instr(project_key, ':') - 1) WHERE project_key GLOB 'dev-?*:?*';
CREATE INDEX sessions_by_started ON sessions(started_at DESC, id DESC);

ALTER TABLE observations ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE observations ADD COLUMN observer_run_id INTEGER REFERENCES observer_runs(id) ON DELETE SET NULL;
CREATE TEMP TABLE recall_counts (id INTEGER PRIMARY KEY, n INTEGER NOT NULL);
INSERT INTO recall_counts (id, n)
  SELECT CAST(j.value AS INTEGER) AS id, count(*) AS n FROM injections i, json_each(i.observation_ids) j
  WHERE i.late = 0 AND i.held_out = 0 GROUP BY CAST(j.value AS INTEGER);
UPDATE observations SET recall_count = (SELECT n FROM recall_counts WHERE recall_counts.id = observations.id)
  WHERE id IN (SELECT id FROM recall_counts);
DROP TABLE recall_counts;
CREATE INDEX observations_by_recalls ON observations(recall_count DESC, id DESC);
CREATE INDEX observations_by_run ON observations(observer_run_id) WHERE observer_run_id IS NOT NULL;

CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  host TEXT,
  project_key TEXT,
  session_id INTEGER,
  device TEXT,
  count INTEGER,
  detail TEXT
);
CREATE INDEX activity_by_time ON activity(at DESC, id DESC);
CREATE INDEX activity_by_kind ON activity(kind, at DESC, id DESC);
`

/** Index i holds the migration that takes user_version from i to i + 1. */
export const MIGRATIONS: readonly string[] = [
  V1_CORE + V1_MEMORY + V1_DELIVERY, V2_OBSERVER, V3_CONTEXT, V4_DATA_CONTROL, V5_LINKS, V6_USAGE, V7_SHARED_SUMMARIES, V8_VECTORS, V9_RELATED_SERVED,
  V10_OBSERVER_SAFETY, V11_VECTOR_SPACE_INDEX, V12_VISIBLE, V13_LATE_AND_INDEXES,
  V14_OBSERVER_ENDPOINT, V15_EMBEDDING_SPACES, V16_PROJECT_MERGES, V17_RECALL_INDEX, V18_DASHBOARD_RECORDS,
]

/**
 * TypeScript run after a migration's SQL, keyed by the version it produces,
 * inside the same transaction: a throw leaves the previous version.
 */
export const MIGRATION_STEPS: Readonly<Record<number, (db: Database) => void>> = {
  7: (db) => {
    backfillSummarySharing(db)
  },
  12: (db) => {
    backfillReplies(db)
  },
  // The date the v18 records start, so a page can say "not recorded before" instead of guessing.
  18: (db) => {
    db.query("INSERT INTO data_settings (key, value, updated_at) VALUES ('records.since', $now, $now) ON CONFLICT (key) DO NOTHING").run({ now: Date.now() })
  },
}

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.length
