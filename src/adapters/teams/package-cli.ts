// `pnpm teams:package` — builds the Teams app package (manifest + icons) for TEAMS_APP_ID, ready to upload in Teams.
import { readFileSync, writeFileSync } from "node:fs";
import { loadDotEnv } from "../../config.js";
import { buildManifest, iconPng, zip } from "./manifest.js";

loadDotEnv();
const appId = process.env.TEAMS_APP_ID;
if (!appId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) {
  console.error("TEAMS_APP_ID must be set to the Microsoft App ID of the Azure Bot (a GUID). See docs/TEAMS.md.");
  process.exit(1);
}
const botName = process.env.BOT_NAME || "Heinzel";
const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };

const out = process.argv[2] ?? "heinzel-teams.zip";
const manifest = buildManifest({ appId, botName, version });
writeFileSync(
  out,
  zip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: "color.png", data: iconPng("color") },
    { name: "outline.png", data: iconPng("outline") },
  ]),
);
console.log(`Wrote ${out} (${botName}, app id ${appId}, version ${version}).`);
console.log("Upload it in Teams: Apps → Manage your apps → Upload an app → Upload a custom app.");
