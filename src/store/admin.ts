import { createHash, randomBytes } from "node:crypto";
import type { AdminRole } from "../admin/types.js";
import type { Db } from "../db/pool.js";

export type { AdminRole };

export interface AdminSession {
  subject: string;
  name: string | null;
  email: string | null;
  role: AdminRole;
  csrfToken: string;
  expiresAt: Date;
}

/** Admin UI login sessions. Only a hash of the cookie value is stored. */
export class AdminSessionStore {
  constructor(private readonly db: Db) {}

  /** Creates a session and returns the cookie value. */
  async create(s: { subject: string; name?: string | null; email?: string | null; role: AdminRole; ttlHours: number }): Promise<string> {
    const id = randomBytes(32).toString("base64url");
    await this.db.query(
      `INSERT INTO admin_sessions (id_hash, subject, name, email, role, csrf_token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))`,
      [hashId(id), s.subject, s.name ?? null, s.email ?? null, s.role, randomBytes(24).toString("base64url"), s.ttlHours],
    );
    await this.db.query(`DELETE FROM admin_sessions WHERE expires_at < now()`);
    return id;
  }

  async get(id: string): Promise<AdminSession | null> {
    const { rows } = await this.db.query(`SELECT * FROM admin_sessions WHERE id_hash = $1 AND expires_at > now()`, [hashId(id)]);
    const r = rows[0];
    return r ? { subject: r.subject, name: r.name, email: r.email, role: r.role, csrfToken: r.csrf_token, expiresAt: r.expires_at } : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.query(`DELETE FROM admin_sessions WHERE id_hash = $1`, [hashId(id)]);
  }
}

function hashId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}
