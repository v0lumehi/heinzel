import { crc32, deflateSync } from "node:zlib";

/**
 * The Teams app package: manifest.json plus two icons, zipped. Teams needs it to install the bot
 * (Apps → Manage your apps → Upload a custom app). Built by `pnpm teams:package`.
 */

export interface ManifestOptions {
  appId: string;
  botName: string;
  version: string;
}

export function buildManifest(o: ManifestOptions): Record<string, unknown> {
  return {
    $schema: "https://developer.microsoft.com/en-us/json-schemas/teams/v1.19/MicrosoftTeams.schema.json",
    manifestVersion: "1.19",
    version: o.version,
    id: o.appId,
    developer: {
      name: o.botName,
      websiteUrl: "https://github.com/v0lumehi/heinzel",
      privacyUrl: "https://github.com/v0lumehi/heinzel#readme",
      termsOfUseUrl: "https://github.com/v0lumehi/heinzel/blob/main/LICENSE",
    },
    name: { short: o.botName.slice(0, 30), full: `${o.botName} – AI teammate`.slice(0, 100) },
    description: {
      short: "Self-hosted AI teammate: answers when tagged, follows threads, remembers.",
      full: `${o.botName} is a self-hosted AI teammate. Tag it in a channel or write to it directly; it answers in the thread. With ambient mode on (!ambient on) it follows a channel and speaks up when it can clearly help. Send !help for all commands.`,
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: "#4F6BED",
    bots: [{ botId: o.appId, scopes: ["personal", "team", "groupChat"], supportsFiles: false, isNotificationOnly: false }],
    permissions: ["identity", "messageTeamMembers"],
    validDomains: [],
    // Resource-specific consent: receive channel and group chat messages without an @-mention (ambient mode).
    webApplicationInfo: { id: o.appId, resource: `api://${o.appId}` },
    authorization: {
      permissions: {
        resourceSpecific: [
          { name: "ChannelMessage.Read.Group", type: "Application" },
          { name: "ChatMessage.Read.Chat", type: "Application" },
        ],
      },
    },
  };
}

export const APP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The complete app package (zip) to upload in Teams. */
export function teamsAppPackage(o: ManifestOptions): Buffer {
  return zip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(buildManifest(o), null, 2)) },
    { name: "color.png", data: iconPng("color") },
    { name: "outline.png", data: iconPng("outline") },
  ]);
}

/** A square "H" icon: 192 px on the accent color (color icon), or 32 px white on transparent (outline icon). */
export function iconPng(kind: "color" | "outline"): Buffer {
  const size = kind === "color" ? 192 : 32;
  const bg = kind === "color" ? [0x4f, 0x6b, 0xed, 0xff] : [0, 0, 0, 0];
  const fg = [0xff, 0xff, 0xff, 0xff];
  const u = size / 32; // the glyph is drawn on a 32×32 grid
  const inH = (x: number, y: number) => y >= 7 && y < 25 && ((x >= 9 && x < 13) || (x >= 19 && x < 23) || (y >= 14 && y < 18 && x >= 13 && x < 19));
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0, then RGBA
    for (let x = 0; x < size; x++) Buffer.from(inH(Math.floor(x / u), Math.floor(y / u)) ? fg : bg).copy(row, 1 + x * 4);
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 bit, RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.concat(rows))), pngChunk("IEND", Buffer.alloc(0))]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Minimal zip writer (stored, no compression): enough for three small files. */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, f.data);
    centrals.push(central, name);
    offset += local.length + name.length + f.data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
