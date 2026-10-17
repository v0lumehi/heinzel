import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, iconPng, zip } from "../src/adapters/teams/manifest.js";

const appId = "11111111-2222-3333-4444-555555555555";

describe("teams app package", () => {
  it("builds a manifest for the bot with RSC permissions for ambient mode", () => {
    const m = buildManifest({ appId, botName: "Heinzel", version: "0.1.0" }) as any;
    expect(m.id).toBe(appId);
    expect(m.bots[0]).toMatchObject({ botId: appId, scopes: ["personal", "team", "groupChat"] });
    expect(m.webApplicationInfo.id).toBe(appId);
    expect(m.authorization.permissions.resourceSpecific.map((p: { name: string }) => p.name)).toEqual(["ChannelMessage.Read.Group", "ChatMessage.Read.Chat"]);
    expect(m.description.short.length).toBeLessThanOrEqual(80);
  });

  it("draws PNG icons of the sizes Teams requires", () => {
    for (const [kind, size] of [["color", 192], ["outline", 32]] as const) {
      const png = iconPng(kind);
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
    }
  });

  it("writes a zip that unzip accepts", () => {
    const file = join(mkdtempSync(join(tmpdir(), "heinzel-")), "app.zip");
    writeFileSync(file, zip([{ name: "manifest.json", data: Buffer.from("{}") }, { name: "color.png", data: iconPng("color") }]));
    const listing = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
    expect(listing).toContain("No errors detected");
  });
});
