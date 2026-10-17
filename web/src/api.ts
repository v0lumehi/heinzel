export type * from "../../src/admin/types";

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export class NotSignedInError extends Error {}

/** JSON call to the admin API. Writes carry the session's CSRF token. */
export async function api<T>(path: string, init: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  const res = await fetch(path, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), credentials: "same-origin" });
  if (res.status === 401) throw new NotSignedInError("Not signed in");
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}
