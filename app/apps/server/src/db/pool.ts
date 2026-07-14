import pg from "pg";
import { config } from "../config.js";

// Yjs updates are stored as BYTEA. node-postgres returns BYTEA as Buffer by
// default (type 17 = bytea), which is what we want — no parser override needed.

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export type Pool = pg.Pool;

export async function closePool(): Promise<void> {
  await pool.end();
}
