import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";
import { orgRole } from "../permissions/lookup.js";

/**
 * MCP access tokens (migration 006).
 *
 * A token authenticates an AI client to POST /api/mcp AS one user WITHIN one
 * workspace. We persist only sha256(token) so a DB leak can't reveal live
 * tokens; the plaintext is shown to the human exactly once, at creation.
 */

type Queryable = Pick<pg.Pool, "query">;

const PREFIX = "mcp_";
/** How many leading chars we keep for display (prefix + a short peek). */
const DISPLAY_LEN = PREFIX.length + 6;

export interface McpTokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface McpAuth {
  userId: string;
  organizationId: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A URL-safe opaque token: `mcp_` + 24 random bytes (base64url ≈ 32 chars). */
function generateToken(): string {
  return PREFIX + randomBytes(24).toString("base64url");
}

/**
 * Mint a token for (userId, organizationId). Returns the PLAINTEXT token (shown
 * once) plus the stored row. Caller must have verified the user's role in the org.
 */
export async function createMcpToken(
  auth: McpAuth,
  name: string,
  db: Queryable = defaultPool,
): Promise<{ token: string; row: McpTokenRow }> {
  const token = generateToken();
  const id = randomUUID();
  const tokenPrefix = token.slice(0, DISPLAY_LEN) + "…";
  const { rows } = await db.query<{ created_at: string }>(
    `INSERT INTO mcp_tokens (id, user_id, organization_id, name, token_hash, token_prefix)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING created_at`,
    [id, auth.userId, auth.organizationId, name, hashToken(token), tokenPrefix],
  );
  return {
    token,
    row: {
      id,
      name,
      tokenPrefix,
      createdAt: rows[0].created_at,
      lastUsedAt: null,
    },
  };
}

/** List a user's tokens for one workspace (never returns hashes). */
export async function listMcpTokens(
  auth: McpAuth,
  db: Queryable = defaultPool,
): Promise<McpTokenRow[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    token_prefix: string;
    created_at: string;
    last_used_at: string | null;
  }>(
    `SELECT id, name, token_prefix, created_at, last_used_at
       FROM mcp_tokens
      WHERE user_id = $1 AND organization_id = $2
      ORDER BY created_at DESC`,
    [auth.userId, auth.organizationId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tokenPrefix: r.token_prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/** Revoke a token the caller owns. Returns true if a row was deleted. */
export async function revokeMcpToken(
  userId: string,
  tokenId: string,
  db: Queryable = defaultPool,
): Promise<boolean> {
  const { rowCount } = await db.query(
    "DELETE FROM mcp_tokens WHERE id = $1 AND user_id = $2",
    [tokenId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Resolve a presented token to its auth context. Returns null when the token is
 * unknown OR the user is no longer a member of the workspace it was scoped to
 * (membership can be revoked out from under a live token). Bumps last_used_at
 * best-effort. This is the single gate every MCP request passes through.
 */
export async function verifyMcpToken(
  token: string,
  db: Queryable = defaultPool,
): Promise<McpAuth | null> {
  if (!token || !token.startsWith(PREFIX)) return null;
  const { rows } = await db.query<{
    id: string;
    user_id: string;
    organization_id: string;
  }>(
    "SELECT id, user_id, organization_id FROM mcp_tokens WHERE token_hash = $1",
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;

  // Membership can be revoked after the token was minted — re-check every time.
  const role = await orgRole(row.organization_id, row.user_id, db);
  if (!role) return null;

  // Best-effort usage stamp; never block the request on it.
  db.query("UPDATE mcp_tokens SET last_used_at = now() WHERE id = $1", [row.id]).catch(
    () => {},
  );

  return { userId: row.user_id, organizationId: row.organization_id };
}
