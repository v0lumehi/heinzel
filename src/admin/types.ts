/**
 * JSON shapes of the admin API. Shared with the web UI (web/), so this file must not import anything.
 * Dates travel as ISO strings.
 */

export type AdminRole = "admin" | "viewer";

export interface MeResponse {
  user: { name: string; email: string | null; role: AdminRole } | null;
  csrfToken: string | null;
  login: { oidc: boolean; dev: boolean };
  botName: string;
}

export interface ChannelRow {
  channelKey: string;
  platform: "slack" | "teams";
  externalId: string;
  name: string | null;
  ambientEnabled: boolean;
  instructions: string;
  dailyUnsolicitedLimit: number | null;
  unsolicitedLast24h: number;
  callsLast7d: number;
  tokensLast7d: number;
  lastActivity: string | null;
}

export interface MemoryRow {
  id: number;
  scope: "channel" | "org" | "user";
  scopeKey: string;
  channelName: string | null;
  content: string;
  createdBy: string;
  createdAt: string;
}

export interface CodingRow {
  id: number;
  channelKey: string;
  status: string;
  repository: string;
  title: string;
  requestedByName: string | null;
  mergeRequestUrl: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AuditRow {
  id: number;
  actor: string;
  actorName: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ChannelDetailResponse {
  channel: ChannelRow;
  memories: MemoryRow[];
  coding: CodingRow[];
  audit: AuditRow[];
}

export interface ChannelPatch {
  ambientEnabled?: boolean;
  /** null resets to the default limit. */
  dailyUnsolicitedLimit?: number | null;
  instructions?: string;
}

export interface UsageResponse {
  days: number;
  byChannel: { channelKey: string | null; name: string | null; calls: number; promptTokens: number; completionTokens: number }[];
  byDay: { day: string; model: string; purpose: string; calls: number; promptTokens: number; completionTokens: number }[];
}

export interface BuiltinToolRow {
  name: string;
  title: string;
  what: string;
  how: string;
  enabled: boolean;
}

export interface CatalogEntryRow {
  id: string;
  name: string;
  description: string;
  verified: boolean;
  defaultName: string;
  docsUrl: string;
  requires: string | null;
  fields: { key: string; label: string; help: string; secret: boolean; placeholder: string | null; default: string | null }[];
  tools: string[] | null;
  exclude: string[];
}

export interface CatalogSaveBody {
  name: string;
  values: Record<string, string>;
  /** Tools chosen after a connection test; omitted = the entry's defaults. */
  tools?: string[] | null;
}

export interface ToolsResponse {
  builtin: BuiltinToolRow[];
  servers: { server: string; error: string | null; tools: { name: string; exposedAs: string | null }[] }[];
}

export interface SettingsResponse {
  botName: string;
  ambientDefault: boolean;
  ambientDailyLimit: number;
  models: { agent: string; triage: string; heavy: string | null; coding: string | null };
  codingEnabled: boolean;
  platforms: string[];
}

export interface ConfigSettingRow {
  key: string;
  kind: "text" | "number" | "boolean";
  group: string;
  label: string;
  help: string;
  value: string;
  /** admin = changed in this UI, deployment = environment / Helm values, default = built-in default. */
  source: "admin" | "deployment" | "default";
  locked: boolean;
  deploymentValue: string;
  updatedBy: string | null;
}

export interface ConfigResponse {
  settings: ConfigSettingRow[];
  /** Whether SECRETS_KEY is set, i.e. MCP servers with headers can be stored. */
  canStoreSecrets: boolean;
}

export interface McpServerInputBody {
  url: string;
  headers: Record<string, string>;
  tools: string[] | null;
  exclude: string[];
  enabled: boolean;
  timeoutMs: number;
}

export interface McpServerRow {
  name: string;
  source: "deployment" | "admin";
  url: string | null;
  headerNames: string[];
  tools: string[] | null;
  exclude: string[];
  enabled: boolean;
  timeoutMs: number;
  updatedBy: string | null;
  status: { server: string; error?: string; tools: { name: string; exposedAs: string | null }[] } | null;
}

export interface McpTestResponse {
  error: string | null;
  tools: { name: string; exposedAs: string | null }[];
}

export interface SetupCheck {
  id: string;
  ok: boolean;
  level: "required" | "recommended";
  title: string;
  hint: string;
  /** What fixes it: a page of this UI, or lines for the deployment configuration. */
  action: { kind: "page"; to: string; label: string } | { kind: "deployment"; snippet: string } | { kind: "generate-key" } | null;
  /** Recommended checks can be marked as decided by an admin (e.g. keeping messages on purpose). */
  dismissed: boolean;
}

export interface SetupResponse {
  botName: string;
  platforms: { platform: "slack" | "teams"; configured: boolean; connected: boolean; detail: string | null; lastMessageAt: string | null }[];
  teams: { appId: string | null; tenantId: string | null; playground: boolean; port: number; packageAvailable: boolean };
  checks: SetupCheck[];
}
