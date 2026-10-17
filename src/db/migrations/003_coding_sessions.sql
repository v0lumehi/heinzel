-- Coding sessions: a coding agent works on a repository in an isolated container and opens a draft merge request.
CREATE TABLE coding_sessions (
  id                 BIGSERIAL PRIMARY KEY,
  channel_key        TEXT NOT NULL REFERENCES channels(channel_key) ON DELETE CASCADE,
  thread_ref         TEXT NOT NULL,
  requested_by       TEXT NOT NULL,          -- '<platform>:<user id>'; only this person can confirm
  requested_by_name  TEXT,
  backend            TEXT NOT NULL DEFAULT 'opencode',
  repository         TEXT NOT NULL,          -- project path on the git host, e.g. 'group/project'
  base_branch        TEXT,                   -- NULL = repository default
  branch             TEXT NOT NULL,          -- branch the agent works on
  title              TEXT NOT NULL,
  task               TEXT NOT NULL,
  context            TEXT NOT NULL DEFAULT '', -- conversation snapshot handed to the agent
  status             TEXT NOT NULL DEFAULT 'awaiting_confirmation',
  runner_ref         TEXT,                   -- container id
  status_message_ref TEXT,                   -- chat message that shows live progress
  log_cursor         TEXT,                   -- last processed log timestamp
  progress           JSONB NOT NULL DEFAULT '{}'::jsonb,
  result             JSONB,
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ
);
CREATE INDEX coding_sessions_thread_idx ON coding_sessions (channel_key, thread_ref, created_at DESC);
CREATE INDEX coding_sessions_active_idx ON coding_sessions (status) WHERE status IN ('queued', 'running', 'cancelling');
