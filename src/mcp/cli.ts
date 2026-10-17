// `pnpm mcp` — connects to the servers in MCP_CONFIG and lists their tools, to help write `tools` / `exclude` lists.
import pino from "pino";
import { loadDotEnv } from "../config.js";
import { loadMcpConfig } from "./config.js";
import { McpHub } from "./hub.js";

loadDotEnv();
const path = process.env.MCP_CONFIG;
if (!path) {
  console.error("MCP_CONFIG is not set (see .env.example and docs/TOOLS.md).");
  process.exit(1);
}

const hub = new McpHub({ log: pino({ level: "silent" }), maxResultChars: 16_000 });
await hub.start(loadMcpConfig(path));
let failed = false;
for (const r of hub.report) {
  console.log(`\n${r.server}`);
  if (r.error) {
    failed = true;
    console.log(`  ✗ unavailable: ${r.error}`);
    continue;
  }
  for (const t of r.tools) console.log(t.exposedAs ? `  ✓ ${t.exposedAs}` : `  · ${t.name} (hidden by tools/exclude)`);
}
await hub.stop();
process.exit(failed ? 1 : 0);
