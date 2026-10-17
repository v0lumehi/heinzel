import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import { BlockList, isIP } from "node:net";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { Agent, fetch } from "undici";
import { z } from "zod";
import type { AgentTool } from "./tools.js";

/** Tool name and the "system" it belongs to (for the prompt and !status). */
export const WEB_FETCH_TOOL = "web__fetch_url";
export const WEB_SOURCE = "web";

const MAX_REDIRECTS = 5;
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; HeinzelBot/0.1; +https://github.com/v0lumehi/heinzel)";

/**
 * Addresses Heinzel must never connect to: loopback, private networks, link-local (cloud metadata at 169.254.169.254),
 * carrier-grade NAT, multicast and other special ranges. Heinzel usually runs inside a company network, so without
 * this anyone in a channel could make it read internal services (SSRF).
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1]!, "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true; // not an IP at all: refuse
}

class BlockedHostError extends Error {}

/** DNS lookup that refuses private addresses. Runs on every connection, so DNS rebinding and redirects are covered too. */
function safeLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad || addresses.length === 0) return callback(new BlockedHostError(`${hostname} resolves to a private or reserved address`), "");
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

export interface WebFetchOptions {
  /** Characters returned per call; the model can page on with `start`. */
  maxChars: number;
  /** Tests only: allow loopback/private targets. */
  allowPrivateHosts?: boolean;
}

export interface FetchedPage {
  url: string;
  contentType: string;
  title: string | null;
  text: string;
}

function checkUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https URLs can be fetched, not ${url.protocol}`);
  if (url.username || url.password) throw new Error("URLs with credentials are not fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // Literal IPs skip DNS, so check them here; hostnames are checked in safeLookup.
  if (!allowPrivate && isIP(host) && isBlockedAddress(host)) throw new BlockedHostError(`${host} is a private or reserved address`);
  return url;
}

async function readLimited(body: AsyncIterable<Uint8Array> | null, limit: number): Promise<{ bytes: Buffer; cut: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (!body) return { bytes: Buffer.alloc(0), cut: false };
  for await (const chunk of body) {
    const buf = Buffer.from(chunk);
    if (size + buf.length > limit) {
      chunks.push(buf.subarray(0, limit - size));
      return { bytes: Buffer.concat(chunks), cut: true };
    }
    chunks.push(buf);
    size += buf.length;
  }
  return { bytes: Buffer.concat(chunks), cut: false };
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|javascript)\b)/i;

export function htmlToMarkdown(html: string): { title: string | null; markdown: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || null;
  const markdown = NodeHtmlMarkdown.translate(html, {
    ignore: ["script", "style", "noscript", "svg", "nav", "footer", "form", "iframe", "button", "head"],
    keepDataImages: false,
    maxConsecutiveNewlines: 2,
  });
  return { title, markdown: markdown.trim() };
}

/** Fetches a public web page and returns it as text (HTML converted to markdown). */
export async function fetchPage(rawUrl: string, opts: Pick<WebFetchOptions, "allowPrivateHosts"> & { dispatcher: Agent }): Promise<FetchedPage> {
  const allowPrivate = !!opts.allowPrivateHosts;
  let url = checkUrl(rawUrl, allowPrivate);
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  for (let hop = 0; ; hop++) {
    const res = await fetch(url, {
      dispatcher: opts.dispatcher,
      redirect: "manual",
      signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
      url = checkUrl(new URL(res.headers.get("location")!, url).toString(), allowPrivate);
      continue;
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() || "unknown";
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    if (contentType !== "unknown" && !TEXT_TYPES.test(contentType)) {
      await res.body?.cancel();
      throw new Error(`Cannot read ${contentType} content (only web pages and text).`);
    }
    const { bytes, cut } = await readLimited(res.body, MAX_BYTES);
    const raw = bytes.toString("utf8");
    const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml" || (contentType === "unknown" && /<html[\s>]/i.test(raw));
    const { title, markdown } = isHtml ? htmlToMarkdown(raw) : { title: null, markdown: raw.trim() };
    return { url: url.toString(), contentType, title, text: cut ? `${markdown}\n\n[page larger than ${MAX_BYTES} bytes; rest not loaded]` : markdown };
  }
}

export function createWebFetchTool(opts: WebFetchOptions): AgentTool<{ url: string; start: number }> {
  const dispatcher = new Agent({
    connect: opts.allowPrivateHosts ? {} : { lookup: safeLookup },
    headersTimeout: TIMEOUT_MS,
    bodyTimeout: TIMEOUT_MS,
  });
  return {
    name: WEB_FETCH_TOOL,
    description:
      "Read a public web page (or other text URL) and get its content as markdown. Use it when someone shares a link or " +
      "when you need the full text of a page you found. Long pages come in parts: call again with `start` to continue. " +
      "Internal/private network addresses cannot be fetched.",
    source: WEB_SOURCE,
    args: z.object({ url: z.string().min(1).max(2000), start: z.number().int().min(0).default(0) }),
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full http(s) URL." },
        start: { type: "integer", description: "Character offset to continue a long page from (default 0)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async run(args) {
      let page: FetchedPage;
      try {
        page = await fetchPage(args.url, { dispatcher, allowPrivateHosts: opts.allowPrivateHosts });
      } catch (err) {
        // Expected failures go back to the model as text; the runner logs real exceptions.
        const cause = err instanceof Error && err.cause instanceof BlockedHostError ? err.cause : err;
        if (cause instanceof BlockedHostError) return `Refused: ${cause.message}. Only public internet addresses can be fetched.`;
        if (err instanceof Error && err.name === "TimeoutError") return `Timed out after ${TIMEOUT_MS / 1000}s fetching ${args.url}.`;
        throw err;
      }
      const total = page.text.length;
      const chunk = page.text.slice(args.start, args.start + opts.maxChars);
      const end = args.start + chunk.length;
      const header = [`URL: ${page.url}`, page.title ? `Title: ${page.title}` : null, `Type: ${page.contentType}`]
        .filter(Boolean)
        .join("\n");
      if (args.start >= total && total > 0) return `${header}\n\n(start ${args.start} is past the end; the page has ${total} characters)`;
      const more = end < total ? `\n\n[characters ${args.start}–${end} of ${total}; call again with start=${end} to continue]` : "";
      return `${header}\n\n${chunk || "(no readable text)"}${more}`;
    },
  };
}
