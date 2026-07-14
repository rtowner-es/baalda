import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { pool } from "../../db/pool.js";
import { orgRole, vaultOrg } from "../../permissions/lookup.js";
import { getSession } from "../session.js";

/**
 * Registry API (session-authenticated). Lets the client map local vault files to
 * server doc_ids: create/list vaults, folders, notes, files. doc_id is the join
 * key between the .md file, the Yjs doc, and the relational rows.
 */
export const registryRoutes = new Hono();

// ── vaults ─────────────────────────────────────────────────────────────────
registryRoutes.post("/vaults", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const name = body.name;
  const organizationId = body.organizationId ?? session.activeOrganizationId;
  if (typeof name !== "string" || !name) {
    return c.json({ error: "name is required" }, 400);
  }
  if (typeof organizationId !== "string" || !organizationId) {
    return c.json({ error: "organizationId is required (no active org)" }, 400);
  }

  const role = await orgRole(organizationId, session.userId);
  if (role !== "owner" && role !== "admin") {
    return c.json({ error: "Only workspace owner/admin can create vaults" }, 403);
  }

  const id = randomUUID();
  await pool.query(
    "INSERT INTO vaults (id, organization_id, name) VALUES ($1, $2, $3)",
    [id, organizationId, name],
  );
  return c.json({ id, organizationId, name }, 201);
});

registryRoutes.get("/vaults", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const { rows } = await pool.query(
    `SELECT v.id, v.organization_id, v.name, v.created_at
       FROM vaults v
       JOIN member m ON m."organizationId" = v.organization_id
      WHERE m."userId" = $1
      ORDER BY v.created_at ASC`,
    [session.userId],
  );
  return c.json({ vaults: rows });
});

// ── folders ──────────────────────────────────────────────────────────────
registryRoutes.post("/folders", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const { vaultId, name, path, parentId } = body;
  if (typeof vaultId !== "string" || typeof name !== "string" || typeof path !== "string") {
    return c.json({ error: "vaultId, name, path are required" }, 400);
  }
  const org = await vaultOrg(vaultId);
  if (!org) return c.json({ error: "Unknown vault" }, 404);
  if (!(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this workspace" }, 403);
  }

  const id = randomUUID();
  await pool.query(
    `INSERT INTO folders (id, vault_id, parent_id, name, path, sort)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, vaultId, parentId ?? null, name, path, body.sort ?? 0],
  );
  return c.json({ id, vaultId, parentId: parentId ?? null, name, path }, 201);
});

registryRoutes.get("/folders", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const vaultId = c.req.query("vaultId");
  if (!vaultId) return c.json({ error: "vaultId query param required" }, 400);
  const org = await vaultOrg(vaultId);
  if (!org || !(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this workspace" }, 403);
  }
  const { rows } = await pool.query(
    "SELECT id, vault_id, parent_id, name, path, sort FROM folders WHERE vault_id = $1 ORDER BY sort, path",
    [vaultId],
  );
  return c.json({ folders: rows });
});

// ── notes (markdown docs; id == doc_id) ────────────────────────────────────
registryRoutes.post("/notes", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const { vaultId, folderId, title, relPath } = body;
  if (typeof vaultId !== "string" || typeof relPath !== "string") {
    return c.json({ error: "vaultId and relPath are required" }, 400);
  }
  const org = await vaultOrg(vaultId);
  if (!org) return c.json({ error: "Unknown vault" }, 404);
  if (!(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this workspace" }, 403);
  }

  // Client may supply a stable doc_id (generated locally); else we mint one.
  const id = typeof body.docId === "string" && body.docId ? body.docId : randomUUID();
  await pool.query(
    `INSERT INTO notes (id, vault_id, folder_id, title, rel_path, doc_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $1, $6)`,
    [id, vaultId, folderId ?? null, title ?? null, relPath, session.userId],
  );
  return c.json(
    { id, docId: id, vaultId, folderId: folderId ?? null, title: title ?? null, relPath },
    201,
  );
});

registryRoutes.get("/notes", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const vaultId = c.req.query("vaultId");
  if (!vaultId) return c.json({ error: "vaultId query param required" }, 400);
  const org = await vaultOrg(vaultId);
  if (!org || !(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this workspace" }, 403);
  }
  const { rows } = await pool.query(
    `SELECT id, vault_id, folder_id, title, rel_path, doc_id, created_by, created_at, updated_at
       FROM notes WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY rel_path`,
    [vaultId],
  );
  return c.json({ notes: rows });
});

// ── files (generic vault-file <-> doc mapping; id == doc_id) ────────────────
registryRoutes.post("/files", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const { vaultId, folderId, path } = body;
  if (typeof vaultId !== "string" || typeof path !== "string") {
    return c.json({ error: "vaultId and path are required" }, 400);
  }
  const org = await vaultOrg(vaultId);
  if (!org) return c.json({ error: "Unknown vault" }, 404);
  if (!(await orgRole(org, session.userId))) {
    return c.json({ error: "Not a member of this workspace" }, 403);
  }
  const id = typeof body.docId === "string" && body.docId ? body.docId : randomUUID();
  await pool.query(
    "INSERT INTO files (id, vault_id, folder_id, path) VALUES ($1, $2, $3, $4)",
    [id, vaultId, folderId ?? null, path],
  );
  return c.json({ id, docId: id, vaultId, folderId: folderId ?? null, path }, 201);
});
