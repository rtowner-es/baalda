import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole } from "../../permissions/lookup.js";
import { getSession } from "../session.js";
import type { DocWriter } from "../../mcp/doc-writer.js";
import { handleMcpMessage, type JsonRpcRequest } from "../../mcp/protocol.js";
import type { McpContext } from "../../mcp/service.js";
import {
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  verifyMcpToken,
} from "../../mcp/tokens.js";

/**
 * The Model Context Protocol surface, part of the same server as everything
 * else (spec: MCP integration):
 *
 *   POST   /api/mcp          → the MCP endpoint AI clients connect to. Auth is a
 *                              minted MCP token (Bearer header or ?key=…). Speaks
 *                              JSON-RPC 2.0 / Streamable-HTTP (single JSON reply).
 *   GET/DELETE /api/mcp       → 405 (we don't offer a server→client SSE stream).
 *
 *   GET    /api/mcp/tokens        → list the caller's tokens for the active workspace
 *   POST   /api/mcp/tokens {name} → mint a token (plaintext returned once)
 *   DELETE /api/mcp/tokens/:id    → revoke a token
 *
 * The token endpoints are session-authenticated (the desktop Settings page);
 * the /api/mcp endpoint is token-authenticated (the AI client).
 */

export interface McpDeps {
  docWriter: DocWriter;
  disconnectDoc: (vaultId: string, docId: string) => void;
}

/** Pull the MCP token from an Authorization: Bearer header or a ?key=/?token= query. */
function extractToken(c: {
  req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined };
}): string | null {
  const auth = c.req.header("authorization") ?? c.req.header("Authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return c.req.query("key") ?? c.req.query("token") ?? null;
}

/** Active workspace: the session's active org, else the user's sole membership. */
async function resolveActiveOrg(
  userId: string,
  activeOrganizationId: string | null,
): Promise<string | null> {
  if (activeOrganizationId) return activeOrganizationId;
  const { rows } = await pool.query<{ organizationId: string }>(
    `SELECT "organizationId" FROM member WHERE "userId" = $1`,
    [userId],
  );
  return rows.length === 1 ? rows[0].organizationId : null;
}

export function createMcpRoutes(deps: McpDeps): Hono {
  const app = new Hono();

  // ── The MCP endpoint (token-authenticated) ────────────────────────────────
  app.post("/mcp", async (c) => {
    const token = extractToken(c);
    if (!token) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ error: "MCP token required" }, 401);
    }
    const auth = await verifyMcpToken(token);
    if (!auth) {
      c.header("WWW-Authenticate", "Bearer");
      return c.json({ error: "Invalid or revoked MCP token" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        400,
      );
    }

    const ctx: McpContext = {
      auth,
      docWriter: deps.docWriter,
      disconnectDoc: deps.disconnectDoc,
    };

    // A batch (array) or a single message. Notifications yield no response.
    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const m of messages) {
      const res = await handleMcpMessage(m as JsonRpcRequest, ctx);
      if (res) responses.push(res);
    }

    if (responses.length === 0) return c.body(null, 202); // notifications only
    return c.json(Array.isArray(body) ? responses : responses[0]);
  });

  // No server-initiated stream; be explicit so clients fall back to POST-only.
  const noStream = (c: { text: (t: string, s: 405) => Response }) =>
    c.text("Method Not Allowed", 405);
  app.get("/mcp", noStream);
  app.delete("/mcp", noStream);

  // ── Token management (session-authenticated; used by desktop Settings) ─────
  app.get("/mcp/tokens", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const org = await resolveActiveOrg(session.userId, session.activeOrganizationId);
    if (!org) return c.json({ error: "No active workspace" }, 400);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this workspace" }, 403);
    }
    const tokens = await listMcpTokens({ userId: session.userId, organizationId: org });
    return c.json({ tokens });
  });

  app.post("/mcp/tokens", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const org = await resolveActiveOrg(session.userId, session.activeOrganizationId);
    if (!org) return c.json({ error: "No active workspace" }, 400);
    if (!(await orgRole(org, session.userId))) {
      return c.json({ error: "Not a member of this workspace" }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : "MCP token";
    const { token, row } = await createMcpToken(
      { userId: session.userId, organizationId: org },
      name,
    );
    // The plaintext token is returned exactly once.
    return c.json({ token, ...row }, 201);
  });

  app.delete("/mcp/tokens/:id", async (c) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Authentication required" }, 401);
    const revoked = await revokeMcpToken(session.userId, c.req.param("id"));
    if (!revoked) return c.json({ error: "Token not found" }, 404);
    return c.json({ revoked: c.req.param("id") });
  });

  return app;
}
