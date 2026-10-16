-- Track agent runs by trace so heavy-model runs can be budgeted per channel.
ALTER TABLE llm_usage ADD COLUMN trace_id TEXT;
CREATE INDEX llm_usage_purpose_idx ON llm_usage (channel_key, purpose, created_at DESC);
