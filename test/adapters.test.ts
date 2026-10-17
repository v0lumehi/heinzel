// The chat adapters end to end: Teams over its real HTTP endpoint against a fake Bot Connector, Slack with a fake Web API client.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SlackAdapter } from "../src/adapters/slack/adapter.js";
import { TeamsAdapter } from "../src/adapters/teams/adapter.js";
import type { ChatEvent } from "../src/core/types.js";
import { silentLog } from "./helpers.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function fakeConnector() {
  const requests: { method: string; url: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method!, url: decodeURIComponent(req.url!), body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `act-${requests.length}` }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

describe("TeamsAdapter", () => {
  it("receives a channel reply, answers in the thread, updates, reacts and reports its status", async () => {
    const connector = await fakeConnector();
    const adapter = new TeamsAdapter({ port: 0, playground: true, log: silentLog });
    const events: ChatEvent[] = [];
    await adapter.start(async (e) => void events.push(e));
    cleanup.push(() => adapter.stop());
    const port = ((adapter as unknown as { server: http.Server }).server.address() as AddressInfo).port;
    expect(adapter.status()).toMatchObject({ connected: true, detail: expect.stringContaining("Playground") });

    const channel = "19:abc@thread.tacv2";
    const activity = {
      type: "message",
      id: "1700000000200",
      text: "<at>Heinzel</at> deploy status?",
      timestamp: "2026-10-17T10:00:00.000Z",
      serviceUrl: connector.url,
      channelId: "msteams",
      from: { id: "29:anna", name: "Anna" },
      recipient: { id: "28:bot", name: "Heinzel" },
      conversation: { id: `${channel};messageid=1700000000100`, conversationType: "channel" },
      entities: [{ type: "mention", mentioned: { id: "28:bot", name: "Heinzel" }, text: "<at>Heinzel</at>" }],
      channelData: { channel: { id: channel, name: "deploys" } },
    };
    const res = await fetch(`http://127.0.0.1:${port}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(activity) });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ channelId: channel, threadId: "1700000000100", text: "@Heinzel deploy status?", mentionsBot: true, channelName: "deploys" });

    const sent = await adapter.send({ channelId: channel, threadId: "1700000000100", text: "# Done\n**all good**" });
    expect(sent).toEqual({ messageId: "act-1", threadId: "1700000000100" });
    expect(connector.requests[0]).toMatchObject({ method: "POST", url: `/v3/conversations/${channel};messageid=1700000000100/activities` });
    expect(JSON.parse(connector.requests[0]!.body)).toMatchObject({ type: "message", textFormat: "markdown", text: "**Done**  \n**all good**" });

    await adapter.update(channel, "act-1", "updated");
    expect(connector.requests[1]).toMatchObject({ method: "PUT", url: `/v3/conversations/${channel}/activities/act-1` });
    await adapter.acknowledge(channel, "1700000000200");
    expect(connector.requests[2]!.url).toBe(`/v3/conversations/${channel}/activities/1700000000200/reactions/1f440_eyes`);

    const top = await adapter.send({ channelId: channel, text: "new post" });
    expect(top).toEqual({ messageId: "act-4", threadId: "act-4" });
    expect(connector.requests[3]!.url).toBe(`/v3/conversations/${channel}/activities`);
  });
});

describe("SlackAdapter", () => {
  function setup() {
    const calls: { method: string; args: Record<string, unknown> }[] = [];
    const record = (method: string, result: unknown) => async (args: Record<string, unknown>) => {
      calls.push({ method, args });
      return typeof result === "function" ? (result as (a: Record<string, unknown>) => unknown)(args) : result;
    };
    const client = {
      chat: { postMessage: record("chat.postMessage", { ts: "1700000000.000300" }), update: record("chat.update", { ok: true }) },
      reactions: { add: record("reactions.add", { ok: true }) },
      users: {
        info: record("users.info", (a: Record<string, unknown>) =>
          a.user === "UERR" ? Promise.reject(new Error("user_not_found")) : { user: { name: "anna", profile: { display_name: "Anna" } } },
        ),
      },
      conversations: {
        info: record("conversations.info", { channel: { name: "general" } }),
        replies: record("conversations.replies", {
          messages: [
            { type: "message", user: "U1", text: "root", ts: "1.0" },
            { type: "message", user: "U1", text: "a", ts: "2.0", thread_ts: "1.0" },
            { type: "message", user: "UBOT", bot_id: "BBOT", text: "b", ts: "3.0", thread_ts: "1.0" },
            { type: "message", user: "U1", text: "c <@UERR>", ts: "4.0", thread_ts: "1.0" },
          ],
        }),
        history: record("conversations.history", {
          messages: [
            { type: "message", user: "U1", text: "newer", ts: "6.0" },
            { type: "message", subtype: "channel_join", user: "U1", ts: "5.5" },
            { type: "message", user: "U1", text: "older", ts: "5.0" },
          ],
        }),
      },
    };
    const adapter = new SlackAdapter({ botToken: "xoxb-test", appToken: "xapp-test", botName: "Heinzel", log: silentLog });
    const internals = adapter as unknown as { app: { client: unknown }; me: unknown; userNames: Map<string, string> };
    internals.app.client = client;
    internals.me = { botUserId: "UBOT", botId: "BBOT" };
    internals.userNames.set("UBOT", "Heinzel");
    return { adapter, calls };
  }

  it("sends mrkdwn with real mentions, updates, reacts and reads threads and history", async () => {
    const { adapter, calls } = setup();
    expect(adapter.status()).toEqual({ connected: false, detail: null });

    const thread = await adapter.fetchThread("C1", "1.0", 3);
    expect(thread.map((e) => [e.messageId, e.isSelf, e.text])).toEqual([
      ["1.0", false, "root"],
      ["3.0", true, "b"],
      ["4.0", false, "c @UERR"],
    ]);
    expect(thread[0]).toMatchObject({ userName: "Anna", channelName: "general" });

    const recent = await adapter.fetchRecent("C1", 10);
    expect(recent.map((e) => e.text)).toEqual(["older", "newer"]); // oldest first, joins dropped

    const sent = await adapter.send({ channelId: "C1", threadId: "1.0", text: "**Hi** @Anna, see [docs](https://x.dev)" });
    expect(sent).toEqual({ messageId: "1700000000.000300", threadId: "1.0" });
    expect(calls.find((c) => c.method === "chat.postMessage")!.args).toMatchObject({ channel: "C1", thread_ts: "1.0", text: "*Hi* <@U1>, see <https://x.dev|docs>", unfurl_links: false });

    expect((await adapter.send({ channelId: "C1", text: "top" })).threadId).toBe("1700000000.000300");
    await adapter.update("C1", "1700000000.000300", "**done**");
    expect(calls.find((c) => c.method === "chat.update")!.args).toMatchObject({ ts: "1700000000.000300", text: "*done*" });
    await adapter.acknowledge("C1", "1.0");
    expect(calls.find((c) => c.method === "reactions.add")!.args).toMatchObject({ name: "eyes", timestamp: "1.0" });
  });
});
