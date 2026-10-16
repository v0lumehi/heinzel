-- Heinzel initial schema.
-- Keys: a channel is identified across platforms by channel_key = '<platform>:<platform channel id>'.

CREATE TABLE channels (
  channel_key              TEXT PRIMARY KEY,
  platform                 TEXT NOT NULL,
  external_id              TEXT NOT NULL,
  name                     TEXT,
  ambient_enabled          BOOLEAN NOT NULL,
  instructions             TEXT NOT NULL DEFAULT '',
  daily_unsolicited_limit  INTEGER,            -- NULL = use AMBIENT_DAILY_LIMIT
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every message Heinzel sees, normalized across platforms.
CREATE TABLE events (
  id            BIGSERIAL PRIMARY KEY,
  platform      TEXT NOT NULL,
  channel_key   TEXT NOT NULL REFERENCES channels(channel_key) ON DELETE CASCADE,
  thread_ref    TEXT NOT NULL,                 -- root message id of the thread (= message_ref for top-level messages)
  message_ref   TEXT NOT NULL,                 -- platform message id
  user_ref      TEXT NOT NULL,
  user_name     TEXT,
  text          TEXT NOT NULL,
  is_bot        BOOLEAN NOT NULL DEFAULT false,
  is_self       BOOLEAN NOT NULL DEFAULT false, -- posted by Heinzel itself
  mentions_bot  BOOLEAN NOT NULL DEFAULT false,
  is_direct     BOOLEAN NOT NULL DEFAULT false,
  sent_at       TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, channel_key, message_ref)
);
CREATE INDEX events_thread_idx ON events (channel_key, thread_ref, sent_at);
CREATE INDEX events_channel_time_idx ON events (channel_key, sent_at DESC);

-- Durable job queue (claimed with FOR UPDATE SKIP LOCKED).
CREATE TABLE jobs (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  dedupe_key    TEXT,
  run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  last_error    TEXT,
  locked_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX jobs_ready_idx ON jobs (run_at, id) WHERE status = 'queued';
-- At most one pending job per dedupe key (e.g. one follow-up per thread).
CREATE UNIQUE INDEX jobs_dedupe_idx ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

-- Team memory. scope: 'channel' (scope_key = channel_key), 'org' (scope_key = '*'), 'user' (scope_key = '<platform>:<user id>').
CREATE TABLE memories (
  id            BIGSERIAL PRIMARY KEY,
  scope         TEXT NOT NULL CHECK (scope IN ('channel', 'org', 'user')),
  scope_key     TEXT NOT NULL,
  content       TEXT NOT NULL,
  source_event  BIGINT REFERENCES events(id) ON DELETE SET NULL,
  created_by    TEXT NOT NULL,                 -- 'agent' | 'triage' | '<platform>:<user id>'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  tsv           TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE INDEX memories_scope_idx ON memories (scope, scope_key, created_at DESC);
CREATE INDEX memories_tsv_idx ON memories USING GIN (tsv);

-- What Heinzel posted, used for budgets and cooldowns.
CREATE TABLE bot_posts (
  id            BIGSERIAL PRIMARY KEY,
  channel_key   TEXT NOT NULL REFERENCES channels(channel_key) ON DELETE CASCADE,
  thread_ref    TEXT NOT NULL,
  message_ref   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('reply', 'ambient', 'followup')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bot_posts_channel_idx ON bot_posts (channel_key, created_at DESC);
CREATE INDEX bot_posts_thread_idx ON bot_posts (channel_key, thread_ref, created_at DESC);

-- LLM usage per call (cost tracking independent of the gateway).
CREATE TABLE llm_usage (
  id                 BIGSERIAL PRIMARY KEY,
  channel_key        TEXT,
  purpose            TEXT NOT NULL,            -- 'agent' | 'triage'
  model              TEXT NOT NULL,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX llm_usage_channel_idx ON llm_usage (channel_key, created_at DESC);
