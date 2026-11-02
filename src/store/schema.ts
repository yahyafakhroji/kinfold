// The database schema as an append-only list of migrations. PRAGMA user_version
// records how many have run; never edit a shipped entry, add a new one.
// Every *_at column is epoch milliseconds; occurred_at is the host's event time,
// kept apart from ingest time (claude-mem summary 5490 is why).

import type { Database } from '../sqlite/types'
import { backfillSummarySharing } from './summary-migration'

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

/** Index i holds the migration that takes user_version from i to i + 1. */
export const MIGRATIONS: readonly string[] = [
  V1_CORE + V1_MEMORY + V1_DELIVERY, V2_OBSERVER, V3_CONTEXT, V4_DATA_CONTROL, V5_LINKS, V6_USAGE, V7_SHARED_SUMMARIES, V8_VECTORS, V9_RELATED_SERVED,
  V10_OBSERVER_SAFETY,
]

/**
 * TypeScript run after a migration's SQL, keyed by the version it produces,
 * inside the same transaction: a throw leaves the previous version.
 */
export const MIGRATION_STEPS: Readonly<Record<number, (db: Database) => void>> = {
  7: (db) => {
    backfillSummarySharing(db)
  },
}

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.length
