// `pnpm teams:package` — builds the Teams app package (manifest + icons) for TEAMS_APP_ID, ready to upload in Teams.
import { readFileSync, writeFileSync } from "node:fs";
import { loadDotEnv } from "../../config.js";
import { APP_ID_PATTERN, teamsAppPackage } from "./manifest.js";

loadDotEnv();
const appId = process.env.TEAMS_APP_ID;
if (!appId || !APP_ID_PATTERN.test(appId)) {
  console.error("TEAMS_APP_ID must be set to the Microsoft App ID of the Azure Bot (a GUID). See docs/TEAMS.md.");
  process.exit(1);
}
const botName = process.env.BOT_NAME || "Heinzel";
const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };

const out = process.argv[2] ?? "heinzel-teams.zip";
writeFileSync(out, teamsAppPackage({ appId, botName, version }));
console.log(`Wrote ${out} (${botName}, app id ${appId}, version ${version}).`);
console.log("Upload it in Teams: Apps → Manage your apps → Upload an app → Upload a custom app.");
