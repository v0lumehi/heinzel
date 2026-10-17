import type { ChannelRow } from "./api";

const num = new Intl.NumberFormat("en-US");
export const fmtNumber = (n: number) => num.format(n);

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
export const fmtDate = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : "–");

export function channelLabel(c: Pick<ChannelRow, "platform" | "name" | "externalId">): string {
  if (c.name) return c.platform === "slack" ? `#${c.name}` : c.name;
  return c.externalId.length > 24 ? `${c.externalId.slice(0, 22)}…` : c.externalId;
}

export const platformLabel = (p: string) => (p === "teams" ? "Teams" : p === "slack" ? "Slack" : p);
