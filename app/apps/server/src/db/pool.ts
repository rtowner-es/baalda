import pg from "pg";
import { config } from "../config.js";

// Yjs updates are stored as BYTEA. node-postgres returns BYTEA as Buffer by
// default (type 17 = bytea), which is what we want — no parser override needed.

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

// node-postgres requires an error listener on the pool itself — an idle
// client that hits a backend/network error (e.g. a managed Postgres closing
// an idle connection) otherwise throws an unhandled 'error' event, which
// crashes the whole Node process. Log and let the pool recover; it drops the
// dead client and opens a fresh one on next use.
pool.on("error", (err) => {
  console.error("[db] idle client error on pool", err);
});

export type Pool = pg.Pool;

export async function closePool(): Promise<void> {
  await pool.end();
}
