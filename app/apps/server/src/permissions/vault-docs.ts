import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";

type Queryable = Pick<pg.Pool, "query">;

/**
 * The set of doc_ids in a vault a user may **read** (spec 05 §3.1). This is the
 * set-based dual of `effectivePermission` ([[resolver]]) for one whole vault, so
 * the vault channel can compute a subscriber's readable set in a couple of
 * queries instead of one resolve per doc.
 *
 * Mirrors the resolver exactly:
 *   - workspace owner/admin  -> every (non-deleted) note + file in the vault;
 *   - a workspace-scoped view/edit grant (org-wide "Open"/"Read-only" for
 *     members, or per-user) -> likewise every doc in the vault;
 *   - otherwise             -> docs reachable via a **user** share (view/edit)
 *     on the doc itself or any ancestor folder (folder grants inherit down).
 *
 * `locked` is a deny-overlay that only caps edit->view; it never grants read, so
 * it's absent here.
 *
 * Read = view OR edit, so the channel streams content to view-only grantees too.
 */
export async function listReadableDocsInVault(
  userId: string,
  vaultId: string,
  db: Queryable = defaultPool,
): Promise<Set<string>> {
  const org = await db.query<{ organization_id: string; role: string | null }>(
    `SELECT v.organization_id, m.role
       FROM vaults v
       LEFT JOIN member m
         ON m."organizationId" = v.organization_id AND m."userId" = $2
      WHERE v.id = $1`,
    [vaultId, userId],
  );
  const row = org.rows[0];
  if (!row) return new Set(); // unknown vault

  let vaultWide = row.role === "owner" || row.role === "admin";
  if (!vaultWide) {
    // Workspace-scoped grant (spec 04 "Access" model): the org-wide Open/
    // Read-only default (members only), or a per-user workspace grant.
    const orgClause =
      row.role !== null ? "principal_type = 'org' OR" : "";
    const grant = await db.query(
      `SELECT 1 FROM shares
        WHERE resource_type = 'workspace' AND resource_id = $1
          AND permission IN ('view', 'edit')
          AND (${orgClause} (principal_type = 'user' AND principal_id = $2))
        LIMIT 1`,
      [row.organization_id, userId],
    );
    vaultWide = (grant.rowCount ?? 0) > 0;
  }

  if (vaultWide) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM notes WHERE vault_id = $1 AND deleted_at IS NULL
       UNION
       SELECT id FROM files WHERE vault_id = $1`,
      [vaultId],
    );
    return new Set(rows.map((r) => r.id));
  }

  // Non-privileged: walk down from every folder the user has a view/edit share
  // on, plus any directly-shared file, restricted to this vault.
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE shared_folders AS (
        SELECT resource_id AS id FROM shares
         WHERE principal_type = 'user' AND principal_id = $1
           AND resource_type = 'folder' AND permission IN ('view', 'edit')
     ),
     subtree AS (
        SELECT id FROM folders WHERE id IN (SELECT id FROM shared_folders)
        UNION ALL
        SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
     ),
     shared_files AS (
        SELECT resource_id AS id FROM shares
         WHERE principal_type = 'user' AND principal_id = $1
           AND resource_type = 'file' AND permission IN ('view', 'edit')
     )
     SELECT n.id FROM notes n
       WHERE n.vault_id = $2 AND n.deleted_at IS NULL
         AND (n.folder_id IN (SELECT id FROM subtree) OR n.id IN (SELECT id FROM shared_files))
     UNION
     SELECT fi.id FROM files fi
       WHERE fi.vault_id = $2
         AND (fi.folder_id IN (SELECT id FROM subtree) OR fi.id IN (SELECT id FROM shared_files))`,
    [userId, vaultId],
  );
  return new Set(rows.map((r) => r.id));
}
