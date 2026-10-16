import pg from "pg";

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // Idle client errors must not crash the process; pg will reconnect.
  pool.on("error", () => {});
  return pool;
}
