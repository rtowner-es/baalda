import type pg from "pg";
import { pool as defaultPool } from "../db/pool.js";

/**
 * Effective-permission resolver (spec 04 §3, plus locks).
 *
 *   1. Workspace owner/admin  -> `edit` on everything in the workspace.
 *   2. Else take the MAX of: a share on the file itself, and any share on a
 *      containing folder (walking parent_id up to the root).
 *   3. `edit > view > none`. Folder grants inherit to descendants; a file
 *      share can only RAISE permission. No matching grant -> `none`.
 *
 * A plain `member` with no share has no content access (`none`).
 *
 * Locks (permission = 'locked') are a DENY overlay resolved AFTER the rules
 * above: when a lock matches the doc or any ancestor folder — for this user
 * (principal_type 'user') or the whole workspace (principal_type 'org') — the
 * result is capped at `view`. Owners/admins are capped too (the point of a
 * lock is protecting content from accidental edits); they can still unlock
 * via the shares API. A lock never GRANTS access: `none` stays `none`.
 */
export type Permission = "edit" | "view" | "none";

const RANK: Record<Permission, number> = { none: 0, view: 1, edit: 2 };

export function maxPermission(a: Permission, b: Permission): Permission {
  return RANK[a] >= RANK[b] ? a : b;
}

type Queryable = Pick<pg.Pool, "query">;

interface DocLocation {
  vaultId: string;
  folderId: string | null;
  organizationId: string;
}

/**
 * Locate a doc's vault/folder/workspace. A doc_id maps to a `notes` row
 * (rich registry) or a `files` row (id == doc_id); we accept either.
 */
async function locateDoc(
  db: Queryable,
  docId: string,
): Promise<DocLocation | null> {
  const { rows } = await db.query<{
    vault_id: string;
    folder_id: string | null;
    organization_id: string;
  }>(
    `SELECT loc.vault_id, loc.folder_id, v.organization_id
       FROM (
         SELECT vault_id, folder_id FROM notes  WHERE id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT vault_id, folder_id FROM files  WHERE id = $1
       ) loc
       JOIN vaults v ON v.id = loc.vault_id
      LIMIT 1`,
    [docId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    vaultId: row.vault_id,
    folderId: row.folder_id,
    organizationId: row.organization_id,
  };
}

/** Walk parent_id up from a folder, collecting all ancestor folder ids (inclusive). */
async function ancestorFolderIds(
  db: Queryable,
  folderId: string | null,
): Promise<string[]> {
  if (!folderId) return [];
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE chain AS (
        SELECT id, parent_id FROM folders WHERE id = $1
        UNION ALL
        SELECT f.id, f.parent_id
          FROM folders f
          JOIN chain c ON f.id = c.parent_id
     )
     SELECT id FROM chain`,
    [folderId],
  );
  return rows.map((r) => r.id);
}

async function memberRole(
  db: Queryable,
  organizationId: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ role: string }>(
    `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
    [organizationId, userId],
  );
  return rows[0]?.role ?? null;
}

/** Highest share permission for a user across the file itself + its folder ancestry. */
async function sharePermission(
  db: Queryable,
  userId: string,
  docId: string,
  folderIds: string[],
): Promise<Permission> {
  const { rows } = await db.query<{ permission: string }>(
    `SELECT permission FROM shares
      WHERE principal_type = 'user'
        AND principal_id = $1
        AND (
          (resource_type = 'file'   AND resource_id = $2)
          OR (resource_type = 'folder' AND resource_id = ANY($3::text[]))
        )`,
    [userId, docId, folderIds],
  );
  let best: Permission = "none";
  for (const r of rows) {
    if (r.permission === "edit" || r.permission === "view") {
      best = maxPermission(best, r.permission);
    }
  }
  return best;
}

/** True when a lock row covers this doc (itself or an ancestor folder) for this user. */
async function isLocked(
  db: Queryable,
  userId: string,
  docId: string,
  folderIds: string[],
): Promise<boolean> {
  const { rows } = await db.query<{ ok: number }>(
    `SELECT 1 AS ok FROM shares
      WHERE permission = 'locked'
        AND (
          principal_type = 'org'
          OR (principal_type = 'user' AND principal_id = $1)
        )
        AND (
          (resource_type = 'file'   AND resource_id = $2)
          OR (resource_type = 'folder' AND resource_id = ANY($3::text[]))
        )
      LIMIT 1`,
    [userId, docId, folderIds],
  );
  return rows.length > 0;
}

export async function effectivePermission(
  userId: string,
  docId: string,
  db: Queryable = defaultPool,
): Promise<Permission> {
  const loc = await locateDoc(db, docId);
  if (!loc) return "none";

  const folderIds = await ancestorFolderIds(db, loc.folderId);

  const role = await memberRole(db, loc.organizationId, userId);
  let granted: Permission;
  if (role === "owner" || role === "admin") {
    granted = "edit";
  } else {
    granted = await sharePermission(db, userId, docId, folderIds);
  }

  // Deny overlay: a matching lock caps at view; it never grants.
  if (granted !== "none" && (await isLocked(db, userId, docId, folderIds))) {
    return "view";
  }
  return granted;
}
