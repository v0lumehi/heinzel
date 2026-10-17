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

export interface ToolsResponse {
  builtin: string[];
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
