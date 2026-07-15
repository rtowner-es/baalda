import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { effectivePermission } from "../src/permissions/resolver.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import {
  seedFolder,
  seedLock,
  seedMember,
  seedNote,
  seedOrg,
  seedShare,
  seedUser,
  seedVault,
  seedWorkspaceGrant,
} from "./helpers/seed.js";

describe("effective-permission resolver matrix (spec 04 §3)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("workspace owner -> edit on everything", async () => {
    const org = await seedOrg("Acme", "acme-owner");
    const owner = await seedUser("owner@a.com");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");
    expect(await effectivePermission(owner, doc)).toBe("edit");
  });

  it("workspace admin -> edit on everything", async () => {
    const org = await seedOrg("Acme", "acme-admin");
    const admin = await seedUser("admin@a.com");
    await seedMember(org, admin, "admin");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");
    expect(await effectivePermission(admin, doc)).toBe("edit");
  });

  it("plain member with no share -> none", async () => {
    const org = await seedOrg("Acme", "acme-none");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");
    expect(await effectivePermission(member, doc)).toBe("none");
  });

  it("member with a folder view-share -> view (inherited by the note)", async () => {
    const org = await seedOrg("Acme", "acme-fview");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Shared", "Shared");
    const doc = await seedNote(vault, folder, "Shared/note.md");
    await seedShare(org, "folder", folder, member, "view");
    expect(await effectivePermission(member, doc)).toBe("view");
  });

  it("file-level edit share raises above a folder view share", async () => {
    const org = await seedOrg("Acme", "acme-override");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Shared", "Shared");
    const doc = await seedNote(vault, folder, "Shared/note.md");
    await seedShare(org, "folder", folder, member, "view");
    await seedShare(org, "file", doc, member, "edit");
    expect(await effectivePermission(member, doc)).toBe("edit");
  });

  it("folder grant inherits to a descendant at depth >= 2", async () => {
    const org = await seedOrg("Acme", "acme-depth");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const top = await seedFolder(vault, null, "Top", "Top");
    const mid = await seedFolder(vault, top, "Mid", "Top/Mid");
    const leaf = await seedFolder(vault, mid, "Leaf", "Top/Mid/Leaf");
    const doc = await seedNote(vault, leaf, "Top/Mid/Leaf/deep.md");
    // share the TOP folder; the doc is three levels down
    await seedShare(org, "folder", top, member, "edit");
    expect(await effectivePermission(member, doc)).toBe("edit");
  });

  it("a non-member with no share -> none", async () => {
    const org = await seedOrg("Acme", "acme-outsider");
    const outsider = await seedUser("out@a.com");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");
    expect(await effectivePermission(outsider, doc)).toBe("none");
  });

  it("view share does not exceed view; highest-wins picks edit when both present on different folders", async () => {
    const org = await seedOrg("Acme", "acme-highest");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const top = await seedFolder(vault, null, "Top", "Top");
    const sub = await seedFolder(vault, top, "Sub", "Top/Sub");
    const doc = await seedNote(vault, sub, "Top/Sub/note.md");
    await seedShare(org, "folder", top, member, "edit"); // ancestor edit
    await seedShare(org, "folder", sub, member, "view"); // nearer view
    // highest-wins -> edit
    expect(await effectivePermission(member, doc)).toBe("edit");
  });

  it("unknown doc -> none", async () => {
    expect(await effectivePermission("nobody", "no-such-doc")).toBe("none");
  });

  it("Open workspace: member gets edit on a ROOT note (folder_id NULL, no folder to share)", async () => {
    const org = await seedOrg("Acme", "acme-open-root");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md"); // vault root, no folder
    await seedWorkspaceGrant(org, "edit");
    expect(await effectivePermission(member, doc)).toBe("edit");
  });

  it("Read-only workspace: member gets view via the org-wide grant", async () => {
    const org = await seedOrg("Acme", "acme-readonly");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");
    await seedWorkspaceGrant(org, "view");
    expect(await effectivePermission(member, doc)).toBe("view");
  });

  it("a workspace grant does not leak to non-members", async () => {
    const org = await seedOrg("Acme", "acme-open-outsider");
    const outsider = await seedUser("out@a.com");
    const vault = await seedVault(org);
    const doc = await seedNote(vault, null, "root.md");
    await seedWorkspaceGrant(org, "edit");
    expect(await effectivePermission(outsider, doc)).toBe("none");
  });

  it("a lock still caps an Open-workspace member at view", async () => {
    const org = await seedOrg("Acme", "acme-open-locked");
    const member = await seedUser("m@a.com");
    await seedMember(org, member, "member");
    const vault = await seedVault(org);
    const folder = await seedFolder(vault, null, "Specs", "Specs");
    const doc = await seedNote(vault, folder, "Specs/frozen.md");
    await seedWorkspaceGrant(org, "edit");
    await seedLock(org, "folder", folder, { type: "org" });
    expect(await effectivePermission(member, doc)).toBe("view");
  });
});
