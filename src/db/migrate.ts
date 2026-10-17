import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./pool.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Applies all pending *.sql migrations in lexical order, each in its own transaction. */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
  const done = new Set(rows.map((r) => r.name));
  const applied: string[] = [];

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Serialize concurrent migrators (e.g. two replicas starting at once).
      await client.query("SELECT pg_advisory_xact_lock(4242001)");
      const again = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (again.rowCount === 0) {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        applied.push(file);
        log(`applied migration ${file}`);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}

// CLI: `pnpm migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { createPool } = await import("./pool.js");
  const { loadDotEnv } = await import("../config.js");
  loadDotEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = createPool(url);
  const applied = await migrate(db, console.log);
  console.log(applied.length ? `done (${applied.length} applied)` : "already up to date");
  await db.end();
}
