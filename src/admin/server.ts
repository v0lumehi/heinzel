import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { APP_ID_PATTERN, teamsAppPackage } from "../adapters/teams/manifest.js";
import { slackManifest } from "../adapters/slack/manifest.js";
import type { Config } from "../config.js";
import type { Platform, PlatformStatus } from "../core/types.js";
import { SettingsError, type RuntimeConfig } from "../core/runtime.js";
import type { McpServerReport } from "../mcp/hub.js";
import type { Memory, MemoryStore } from "../memory/memory.js";
import type { AdminSession, AdminSessionStore } from "../store/admin.js";
import type { CodingSession, CodingStore } from "../store/coding.js";
import type { AuditEntry, ChannelOverview, Store } from "../store/store.js";
import { roleFromClaims, splitList, type OidcLogin, type PendingLogin } from "./auth.js";
import type {
  AuditRow,
  ChannelDetailResponse,
  ChannelRow,
  CodingRow,
  ConfigResponse,
  McpServerRow,
  McpTestResponse,
  MeResponse,
  MemoryRow,
  SettingsResponse,
  SetupCheck,
  SetupResponse,
  ToolsResponse,
  UsageResponse,
} from "./types.js";

export interface AdminDeps {
  config: Config;
  store: Store;
  memory: MemoryStore;
  sessions: AdminSessionStore;
  coding?: CodingStore;
  /** Names of the agent tools and the MCP connection report, for the tools page. */
  tools: () => { builtin: string[]; servers: McpServerReport[] };
  oidc?: OidcLogin;
  /** Connection state of the chat platforms that are configured. */
  platforms?: () => { platform: Platform; status: PlatformStatus | null }[];
  /** Runtime settings and MCP servers editable in the UI. */
  runtime?: RuntimeConfig;
  log: Logger;
  /** Built web UI (web/dist). Missing = API only. */
  staticDir?: string;
}

const SESSION_COOKIE = "heinzel_session";
const PENDING_COOKIE = "heinzel_oidc";

declare module "fastify" {
  interface FastifyRequest {
    admin: (AdminSession & { sessionId: string }) | null;
  }
}

export const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

/**
 * The admin UI backend: OIDC sign-in, server-side sessions, a JSON API for the web UI, and the built UI itself.
 * Writes need the admin role and the session's CSRF token in the X-CSRF-Token header.
 */
export async function buildAdminServer(d: AdminDeps): Promise<FastifyInstance> {
  const { config } = d;
  const secure = config.ADMIN_PUBLIC_URL.startsWith("https://");
  const app = Fastify({ loggerInstance: d.log as FastifyBaseLogger, disableRequestLogging: true, trustProxy: secure, bodyLimit: 256 * 1024 });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Mantine injects CSS variables at runtime
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
  });
  await app.register(rateLimit, { global: false });

  app.decorateRequest("admin", null);
  app.addHook("onRequest", async (req) => {
    const id = req.cookies[SESSION_COOKIE];
    if (!id) return;
    const s = await d.sessions.get(id);
    if (s) req.admin = { ...s, sessionId: id };
  });

  const cookieOpts = (maxAgeSeconds: number, path = "/") => ({ httpOnly: true, sameSite: "lax" as const, secure, path, maxAge: maxAgeSeconds });

  async function signIn(reply: FastifyReply, who: { subject: string; name: string | null; email: string | null; role: "admin" | "viewer" }) {
    const id = await d.sessions.create({ ...who, ttlHours: config.ADMIN_SESSION_HOURS });
    reply.setCookie(SESSION_COOKIE, id, cookieOpts(config.ADMIN_SESSION_HOURS * 3600));
    await d.store.recordAudit({ actor: `admin:${who.subject}`, actorName: who.name, action: "admin.sign_in", details: { role: who.role } });
  }

  // ------------------------------------------------------------------ auth

  app.get("/auth/login", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (_req, reply) => {
    if (!d.oidc) return reply.code(404).send({ error: "Single sign-on is not configured" });
    const { url, pending } = await d.oidc.start();
    reply.setCookie(PENDING_COOKIE, JSON.stringify(pending), cookieOpts(600, "/auth"));
    return reply.redirect(url);
  });

  app.get("/auth/callback", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!d.oidc) return reply.code(404).send({ error: "Single sign-on is not configured" });
    const raw = req.cookies[PENDING_COOKIE];
    reply.clearCookie(PENDING_COOKIE, { path: "/auth" });
    if (!raw) return reply.redirect("/?error=expired");
    try {
      const pending = JSON.parse(raw) as PendingLogin;
      const identity = await d.oidc.finish(new URL(req.url, config.ADMIN_PUBLIC_URL), pending);
      const role = roleFromClaims(identity.claims, config.ADMIN_ROLE_CLAIM, splitList(config.ADMIN_ADMIN_ROLES), splitList(config.ADMIN_VIEWER_ROLES));
      if (!role) {
        req.log.warn({ subject: identity.subject }, "admin: sign-in without an admin or viewer role");
        return reply.redirect("/?error=no_role");
      }
      await signIn(reply, { subject: identity.subject, name: identity.name, email: identity.email, role });
      return reply.redirect("/");
    } catch (err) {
      req.log.warn({ err: err instanceof Error ? err.message : String(err) }, "admin: sign-in failed");
      return reply.redirect("/?error=sign_in_failed");
    }
  });

  app.post("/auth/dev-login", async (req, reply) => {
    if (!config.ADMIN_DEV_LOGIN) return reply.code(404).send({ error: "Not found" });
    if (!isLoopback(req.socket.remoteAddress)) return reply.code(403).send({ error: "Development sign-in only works from this machine" });
    await signIn(reply, { subject: "dev", name: "Developer", email: null, role: "admin" });
    return { ok: true };
  });

  app.post("/auth/logout", async (req, reply) => {
    if (req.admin) {
      if (!csrfOk(req)) return reply.code(403).send({ error: "Invalid CSRF token" });
      await d.sessions.delete(req.admin.sessionId);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req): Promise<MeResponse> => ({
    user: req.admin ? { name: req.admin.name ?? req.admin.email ?? req.admin.subject, email: req.admin.email, role: req.admin.role } : null,
    csrfToken: req.admin?.csrfToken ?? null,
    login: { oidc: !!d.oidc, dev: config.ADMIN_DEV_LOGIN },
    botName: config.BOT_NAME,
  }));

  // ------------------------------------------------------------------ API (signed in)

  await app.register(async (api) => {
    api.addHook("preHandler", async (req, reply) => {
      if (!req.admin) return reply.code(401).send({ error: "Not signed in" });
      if (req.method !== "GET" && req.method !== "HEAD") {
        if (req.admin.role !== "admin") return reply.code(403).send({ error: "Only admins can change settings" });
        if (!csrfOk(req)) return reply.code(403).send({ error: "Invalid CSRF token" });
      }
    });
    const actor = (req: FastifyRequest) => ({ actor: `admin:${req.admin!.subject}`, actorName: req.admin!.name ?? req.admin!.email });

    api.get("/api/settings", async (): Promise<SettingsResponse> => ({
      botName: config.BOT_NAME,
      ambientDefault: config.AMBIENT_DEFAULT,
      ambientDailyLimit: config.AMBIENT_DAILY_LIMIT,
      models: {
        agent: config.LLM_MODEL_AGENT,
        triage: config.LLM_MODEL_TRIAGE,
        heavy: config.LLM_MODEL_HEAVY ?? null,
        coding: config.CODING_ENABLED ? (config.CODING_MODEL ?? config.LLM_MODEL_HEAVY ?? config.LLM_MODEL_AGENT) : null,
      },
      codingEnabled: config.CODING_ENABLED,
      platforms: [config.SLACK_BOT_TOKEN ? "slack" : null, config.TEAMS_APP_ID || config.TEAMS_PLAYGROUND ? "teams" : null].filter((p): p is string => !!p),
    }));

    api.get("/api/channels", async (): Promise<ChannelRow[]> => (await d.store.listChannels()).map(channelRow));

    api.get("/api/channels/:key", async (req, reply): Promise<ChannelDetailResponse | undefined> => {
      const { key } = req.params as { key: string };
      const channel = (await d.store.listChannels()).find((c) => c.channelKey === key);
      if (!channel) return reply.code(404).send({ error: "Unknown channel" });
      return {
        channel: channelRow(channel),
        memories: (await d.memory.list({ scope: "channel", scopeKey: key, limit: 100 })).map(memoryRow),
        coding: d.coding ? (await d.coding.recentInChannel(key, 20)).map(codingRow) : [],
        audit: (await d.store.listAudit({ target: key, limit: 50 })).map(auditRow),
      };
    });

    const channelPatch = z
      .object({
        ambientEnabled: z.boolean().optional(),
        dailyUnsolicitedLimit: z.number().int().min(0).max(1000).nullable().optional(),
        instructions: z.string().max(4000).optional(),
      })
      .strict();

    api.patch("/api/channels/:key", async (req, reply): Promise<ChannelRow | undefined> => {
      const { key } = req.params as { key: string };
      const parsed = channelPatch.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
      const before = await d.store.getChannel(key);
      if (!before) return reply.code(404).send({ error: "Unknown channel" });
      await d.store.updateChannel(key, parsed.data);
      const changes = Object.fromEntries(
        Object.entries(parsed.data)
          .filter(([k, v]) => before[k as keyof typeof before] !== v)
          .map(([k, v]) => [k, { from: before[k as keyof typeof before], to: v }]),
      );
      if (Object.keys(changes).length) await d.store.recordAudit({ ...actor(req), action: "channel.update", target: key, details: changes });
      return channelRow((await d.store.listChannels()).find((c) => c.channelKey === key)!);
    });

    api.get("/api/memories", async (req): Promise<MemoryRow[]> => {
      const q = req.query as { scope?: string; q?: string; key?: string };
      const scope = q.scope === "channel" || q.scope === "org" || q.scope === "user" ? q.scope : undefined;
      return (await d.memory.list({ scope, scopeKey: q.key || undefined, text: q.q, limit: 300 })).map(memoryRow);
    });

    api.delete("/api/memories/:id", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const existing = Number.isSafeInteger(id) ? (await d.memory.list({ limit: 1, id })).at(0) : undefined;
      if (!existing || !(await d.memory.remove(id))) return reply.code(404).send({ error: "Unknown memory" });
      await d.store.recordAudit({
        ...actor(req),
        action: "memory.delete",
        target: existing.scope === "channel" ? existing.scopeKey : `memory:${id}`,
        details: { id, scope: existing.scope, scopeKey: existing.scopeKey, content: existing.content },
      });
      return { ok: true };
    });

    api.get("/api/usage", async (req): Promise<UsageResponse> => {
      const days = [1, 7, 30, 90].includes(Number((req.query as { days?: string }).days)) ? Number((req.query as { days?: string }).days) : 7;
      return { days, byChannel: await d.store.usageByChannel(days), byDay: await d.store.usageByDay(days) };
    });

    api.get("/api/coding", async (): Promise<CodingRow[]> => (d.coding ? (await d.coding.recent(200)).map(codingRow) : []));

    api.get("/api/tools", async (): Promise<ToolsResponse> => {
      const t = d.tools();
      return { builtin: t.builtin, servers: t.servers.map((s) => ({ server: s.server, error: s.error ?? null, tools: s.tools })) };
    });

    // ---------------------------------------------------------------- runtime configuration

    const runtime = () => {
      if (!d.runtime) throw new SettingsError("Runtime configuration is not available");
      return d.runtime;
    };
    api.setErrorHandler((err, _req, reply) => {
      if (err instanceof SettingsError) return reply.code(400).send({ error: err.message });
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message });
      d.log.error({ err }, "admin API error");
      return reply.code(500).send({ error: "Internal error" });
    });

    api.get("/api/config", async (): Promise<ConfigResponse> => ({ settings: runtime().settings(), canStoreSecrets: !!config.SECRETS_KEY }));

    api.put("/api/config/:key", async (req) => {
      const body = z.object({ value: z.string().max(2000).nullable() }).strict().safeParse(req.body);
      if (!body.success) throw new SettingsError("Expected { value: string | null }");
      await runtime().updateSetting((req.params as { key: string }).key, body.data.value, actor(req));
      return { ok: true };
    });

    const mcpInput = z
      .object({
        url: z.string().url(),
        headers: z.record(z.string().max(100), z.string().max(4000)).default({}),
        tools: z.array(z.string().min(1).max(200)).max(500).nullable().default(null),
        exclude: z.array(z.string().min(1).max(200)).max(500).default([]),
        enabled: z.boolean().default(true),
        timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
      })
      .strict();
    const parseMcp = (req: FastifyRequest) => {
      const parsed = mcpInput.safeParse(req.body);
      if (!parsed.success) throw new SettingsError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return { name: (req.params as { name: string }).name, ...parsed.data };
    };

    api.get("/api/mcp", async (): Promise<McpServerRow[]> => runtime().mcpServers());
    api.put("/api/mcp/:name", async (req) => {
      await runtime().saveMcpServer(parseMcp(req), actor(req));
      return { ok: true };
    });
    api.delete("/api/mcp/:name", async (req, reply) => {
      if (!(await runtime().deleteMcpServer((req.params as { name: string }).name, actor(req)))) return reply.code(404).send({ error: "Unknown server" });
      return { ok: true };
    });
    // A write (admin + CSRF): it makes an outgoing connection with the given credentials.
    api.post("/api/mcp/:name/test", async (req): Promise<McpTestResponse> => {
      const r = await runtime().testMcpServer(parseMcp(req));
      return { error: r.error ?? null, tools: r.tools };
    });

    // ---------------------------------------------------------------- setup guide

    api.get("/api/setup", async (): Promise<SetupResponse> => {
      const live = new Map((d.platforms?.() ?? []).map((p) => [p.platform, p.status]));
      const last = await d.store.lastEventPerPlatform();
      const platforms = (["slack", "teams"] as const).map((platform) => {
        const status = live.get(platform);
        return {
          platform,
          configured: live.has(platform),
          connected: status?.connected ?? false,
          detail: status?.detail ?? null,
          lastMessageAt: iso(last[platform]),
        };
      });
      const mcpErrors = d.tools().servers.filter((s) => s.error).map((s) => s.server);
      const checks: SetupCheck[] = [
        {
          id: "platform",
          ok: platforms.some((p) => p.connected && p.lastMessageAt),
          level: "required",
          title: "A chat platform delivers messages",
          hint: "Connect Slack or Teams below, then write to the bot once.",
        },
        {
          id: "sso",
          ok: !!config.ADMIN_OIDC_ISSUER,
          level: "required",
          title: "Single sign-on for this admin UI",
          hint: "Set ADMIN_OIDC_ISSUER, ADMIN_OIDC_CLIENT_ID and ADMIN_OIDC_CLIENT_SECRET (docs/ADMIN.md). The development sign-in is for local use only.",
        },
        {
          id: "secrets",
          ok: !!config.SECRETS_KEY,
          level: "recommended",
          title: "Key for stored secrets",
          hint: "Set SECRETS_KEY (openssl rand -base64 32) so tokens of MCP servers can be stored here.",
        },
        {
          id: "retention",
          ok: config.EVENTS_RETENTION_DAYS > 0,
          level: "recommended",
          title: "Retention for message copies",
          hint: "Message copies are kept forever. Decide on a retention period (Settings → Data) that fits your data protection policy.",
        },
        {
          id: "tools",
          ok: mcpErrors.length === 0,
          level: "recommended",
          title: "Tool servers reachable",
          hint: mcpErrors.length ? `Unavailable: ${mcpErrors.join(", ")} (see Tools).` : "All configured MCP servers are connected.",
        },
      ];
      return {
        botName: config.BOT_NAME,
        platforms,
        teams: {
          appId: config.TEAMS_APP_ID ?? null,
          tenantId: config.TEAMS_TENANT_ID ?? null,
          playground: config.TEAMS_PLAYGROUND,
          port: config.TEAMS_PORT,
          packageAvailable: !!config.TEAMS_APP_ID && APP_ID_PATTERN.test(config.TEAMS_APP_ID),
        },
        checks,
      };
    });

    api.get("/api/setup/slack-manifest.yaml", async (_req, reply) =>
      reply.header("content-type", "text/yaml; charset=utf-8").header("content-disposition", 'attachment; filename="slack-app-manifest.yaml"').send(slackManifest(config.BOT_NAME)),
    );

    api.get("/api/setup/teams-app.zip", async (_req, reply) => {
      const appId = config.TEAMS_APP_ID;
      if (!appId || !APP_ID_PATTERN.test(appId)) return reply.code(409).send({ error: "Set TEAMS_APP_ID to the bot's Microsoft App ID first" });
      const pkg = teamsAppPackage({ appId, botName: config.BOT_NAME, version: APP_VERSION });
      return reply.header("content-type", "application/zip").header("content-disposition", 'attachment; filename="heinzel-teams.zip"').send(pkg);
    });

    api.get("/api/audit", async (req): Promise<AuditRow[]> => (await d.store.listAudit({ target: (req.query as { target?: string }).target || undefined, limit: 500 })).map(auditRow));
  });

  // ------------------------------------------------------------------ web UI

  const staticDir = d.staticDir ?? DEFAULT_STATIC_DIR;
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    // Client-side routes (/channels/…) get the app shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/auth/")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  } else {
    d.log.warn({ staticDir }, "admin: web UI not built (pnpm build:web); serving the API only");
  }

  return app;
}

const APP_VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

function csrfOk(req: FastifyRequest): boolean {
  const sent = req.headers["x-csrf-token"];
  const expected = req.admin?.csrfToken;
  if (typeof sent !== "string" || !expected || sent.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
}

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

function channelRow(c: ChannelOverview): ChannelRow {
  return { ...c, lastActivity: iso(c.lastActivity) };
}

function memoryRow(m: Memory & { channelName: string | null }): MemoryRow {
  return { id: m.id, scope: m.scope, scopeKey: m.scopeKey, channelName: m.channelName, content: m.content, createdBy: m.createdBy, createdAt: iso(m.createdAt)! };
}

function codingRow(s: CodingSession): CodingRow {
  return {
    id: s.id,
    channelKey: s.channelKey,
    status: s.status,
    repository: s.repository,
    title: s.title,
    requestedByName: s.requestedByName,
    mergeRequestUrl: s.result?.mergeRequestUrl ?? null,
    error: s.error,
    createdAt: iso(s.createdAt)!,
    finishedAt: iso(s.finishedAt),
  };
}

function auditRow(a: AuditEntry): AuditRow {
  return { ...a, createdAt: iso(a.createdAt)! };
}
