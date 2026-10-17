-- Admin UI: who changed what (from the UI or by chat command), and login sessions.

CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  actor        TEXT NOT NULL,                 -- 'admin:<subject>' | '<platform>:<user id>' | 'system'
  actor_name   TEXT,
  action       TEXT NOT NULL,                 -- e.g. 'channel.update', 'memory.delete'
  target       TEXT,                          -- e.g. channel key, memory id
  details      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_time_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target, created_at DESC);

-- Server-side sessions, so logins can be revoked and work across replicas. The cookie holds only the random id.
CREATE TABLE admin_sessions (
  id_hash      TEXT PRIMARY KEY,              -- sha256 of the cookie value
  subject      TEXT NOT NULL,
  name         TEXT,
  email        TEXT,
  role         TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
  csrf_token   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions (expires_at);
