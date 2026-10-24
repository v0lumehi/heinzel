// Property-based tests (fast-check): parsers and security checks hold for generated inputs, not only for examples.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { markdownToMrkdwn, slackToPlainText } from "../src/adapters/slack/format.js";
import { splitConversationId, teamsToPlainText } from "../src/adapters/teams/format.js";
import { isBlockedAddress } from "../src/agent/webfetch.js";
import { compareTimestamps, rfc3339ToDockerSince } from "../src/coding/docker.js";
import { kubeLabels } from "../src/coding/kubernetes.js";
import { SecretBox } from "../src/crypto.js";
import { isAllowed, parseAllowList } from "../src/egress/proxy.js";
import { interpolate, matchesPattern } from "../src/mcp/config.js";
import { toOrTsQuery } from "../src/memory/memory.js";

const box = new SecretBox(Buffer.alloc(32, 3).toString("base64"));
const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
const hostname = fc.array(label, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("."));

describe("properties", () => {
  it("SecretBox: what is sealed opens again, and any change to the sealed text is detected", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), fc.nat(), (plain, at) => {
        const sealed = box.seal(plain);
        expect(box.open(sealed)).toBe(plain);
        const data = Buffer.from(sealed.split(":")[3]!, "base64");
        if (data.length === 0) return;
        data[at % data.length]! ^= 1;
        const parts = sealed.split(":");
        parts[3] = data.toString("base64");
        expect(() => box.open(parts.join(":"))).toThrow();
      }),
    );
  });

  it("egress allowlist: a wildcard matches subdomains only, never the bare domain or look-alikes", () => {
    fc.assert(
      fc.property(hostname, hostname, label, (domain, other, sub) => {
        const rules = parseAllowList(`*.${domain}`);
        expect(isAllowed(rules, `${sub}.${domain}`, 443)).toBe(true);
        expect(isAllowed(rules, domain, 443)).toBe(false);
        expect(isAllowed(rules, `${sub}${domain}`, 443)).toBe(false);
        expect(isAllowed(rules, `${sub}.${domain}`, 8443)).toBe(false);
        if (other !== domain && !other.endsWith(`.${domain}`)) expect(isAllowed(rules, other, 443)).toBe(false);
      }),
    );
  });

  it("egress allowlist: an exact host allows itself on 80/443 or its explicit port only", () => {
    fc.assert(
      fc.property(hostname, fc.integer({ min: 1, max: 65535 }), (host, port) => {
        expect(isAllowed(parseAllowList(host), host.toUpperCase(), 443)).toBe(true);
        expect(isAllowed(parseAllowList(`${host}:${port}`), host, port)).toBe(true);
        if (port !== 80 && port !== 443) expect(isAllowed(parseAllowList(host), host, port)).toBe(false);
      }),
    );
  });

  it("web fetch: private and loopback IPv4 addresses are always blocked", () => {
    const octet = fc.integer({ min: 0, max: 255 });
    fc.assert(
      fc.property(fc.constantFrom("10", "127", "192.168", "172.16", "169.254"), octet, octet, octet, (prefix, a, b, c) => {
        const parts = prefix.split(".").concat([String(a), String(b), String(c)]).slice(0, 4);
        expect(isBlockedAddress(parts.join("."))).toBe(true);
      }),
    );
  });

  it("Teams text conversion never leaves a tag behind and never throws", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = teamsToPlainText(s.replace(/&/g, ""));
        expect(out).not.toMatch(/<[^<>]*>/);
      }),
    );
  });

  it("Teams conversation ids: a thread suffix is split off exactly", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^19:[a-z0-9]{1,20}@thread\.tacv2$/), fc.bigInt({ min: 1n, max: 10n ** 15n }), (id, root) => {
        expect(splitConversationId(`${id};messageid=${root}`)).toEqual({ conversationId: id, rootId: String(root) });
        expect(splitConversationId(id)).toEqual({ conversationId: id });
      }),
    );
  });

  it("Slack conversions never throw and keep code spans unchanged", () => {
    fc.assert(
      fc.property(fc.string(), fc.stringMatching(/^[^`\n]{1,20}$/), (text, code) => {
        slackToPlainText(text, new Map([["U1", "Anna"]]));
        expect(markdownToMrkdwn(`${text.replace(/`/g, "")} \`${code}\``)).toContain(`\`${code}\``);
      }),
    );
  });

  it("memory search query contains only words and OR operators", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (text) => {
        expect(toOrTsQuery(text)).toMatch(/^([\p{L}\p{N}_]+( \| [\p{L}\p{N}_]+)*)?$/u);
      }),
    );
  });

  it("tool name patterns: without * only the exact name matches; regex characters are literal", () => {
    fc.assert(
      fc.property(fc.string().filter((s) => !s.includes("*")), fc.string(), (pattern, name) => {
        expect(matchesPattern(name, pattern)).toBe(name === pattern);
        expect(matchesPattern(name, "*")).toBe(true);
      }),
    );
  });

  it("config interpolation replaces set variables and reports missing ones", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z_][A-Z0-9_]{0,15}$/), fc.string({ minLength: 1 }).filter((v) => !v.includes("$")), (name, value) => {
        const missing = new Set<string>();
        expect(interpolate(`x\${${name}}y`, { [name]: value }, missing)).toBe(`x${value}y`);
        interpolate(`\${${name}}`, {}, missing);
        expect([...missing]).toEqual([name]);
      }),
    );
  });

  it("Kubernetes labels are always valid label values", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const v = kubeLabels({ "heinzel.coding.repository": value })["heinzel.dev/coding.repository"]!;
        expect(v).toMatch(/^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$/);
        expect(v.length).toBeLessThanOrEqual(63);
      }),
    );
  });

  it("log timestamps: comparison is consistent and converts to Docker's since format", () => {
    const ts = fc
      .tuple(fc.date({ min: new Date("2020-01-01"), max: new Date("2030-01-01"), noInvalidDate: true }), fc.integer({ min: 0, max: 999_999_999 }))
      .map(([d, ns]) => `${d.toISOString().slice(0, 19)}.${String(ns).padStart(9, "0")}Z`);
    fc.assert(
      fc.property(ts, ts, (a, b) => {
        // Sum instead of negation: toBe uses Object.is, and -0 is not 0.
        expect(compareTimestamps(a, b) + compareTimestamps(b, a)).toBe(0);
        expect(compareTimestamps(a, a)).toBe(0);
        expect(rfc3339ToDockerSince(a)).toMatch(/^\d+\.\d{9}$/);
      }),
    );
  });
});
