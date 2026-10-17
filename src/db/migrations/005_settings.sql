-- Runtime settings and MCP servers managed in the admin UI. Deployment configuration (env, mcp.json) stays outside.

CREATE TABLE settings (
  key          TEXT PRIMARY KEY,               -- name of the environment variable it overrides
  value        TEXT NOT NULL,                  -- same text format as the environment variable
  updated_by   TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Remote (streamable HTTP) MCP servers only: stdio servers run commands on the host and stay in mcp.json.
CREATE TABLE mcp_servers (
  name          TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  headers_enc   TEXT,                          -- JSON object of headers, encrypted with SECRETS_KEY
  header_names  TEXT[] NOT NULL DEFAULT '{}',  -- for display; values are never shown again
  tools         JSONB,                         -- allowlist (null = all)
  exclude       JSONB NOT NULL DEFAULT '[]',
  enabled       BOOLEAN NOT NULL DEFAULT true,
  timeout_ms    INTEGER NOT NULL DEFAULT 60000,
  updated_by    TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
