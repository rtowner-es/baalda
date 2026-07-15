import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({
  getVaultConfig: vi.fn(async () => null),
  setVaultConfig: vi.fn(async () => {}),
  listTree: vi.fn(async () => ({ id: "root", name: "", path: "", isDir: true, children: [] })),
  listNoteTitles: vi.fn(async () => []),
  writeNote: vi.fn(async () => {}),
}));
vi.mock("../../vault/seed", () => ({ seedWelcomeContent: vi.fn(async () => {}) }));

import type { ApiClient } from "../../api";
import * as ipc from "../../ipc";
import type { TreeNode } from "../../ipc";
import { seedWelcomeContent } from "../../vault/seed";
import { VaultRegistry } from "../registry";

const ORG = "org-1";

function emptyTree(): TreeNode {
  return { id: "root", name: "vault", path: "", isDir: true, children: [] };
}

/** Minimal fake of the ApiClient surface reconcile() touches. */
function fakeApi(opts: {
  vaults: Array<{ id: string; name: string; organization_id: string }>;
  notes?: Array<{ id: string; rel_path: string }>;
}) {
  const createVault = vi.fn(async (input: { name: string; organizationId: string }) => {
    const v = { id: `created-${input.name}`, name: input.name, organization_id: input.organizationId };
    opts.vaults.push(v);
    return v;
  });
  const createNote = vi.fn(async (input: { relPath: string }) => ({
    id: `note-${input.relPath}`,
    rel_path: input.relPath,
  }));
  const api = {
    listVaults: vi.fn(async () => opts.vaults),
    createVault,
    listFolders: vi.fn(async () => []),
    createFolder: vi.fn(async (input: { path: string }) => ({ id: `folder-${input.path}` })),
    listNotes: vi.fn(async () => opts.notes ?? []),
    createNote,
  } as unknown as ApiClient;
  return { api, createVault, createNote };
}

beforeEach(() => {
  vi.mocked(ipc.getVaultConfig).mockResolvedValue(null);
  vi.mocked(ipc.writeNote).mockClear();
  vi.mocked(seedWelcomeContent).mockClear();
});

describe("VaultRegistry.reconcile — vault adoption (joining member)", () => {
  it("adopts the workspace's existing vault even when the local folder name differs", async () => {
    // Owner created the vault under a folder named "MyNotes"; the member's fresh
    // per-workspace folder is slugged from the org name ("acme") — no name match.
    const { api, createVault } = fakeApi({
      vaults: [{ id: "v-owner", name: "MyNotes", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Team/hello.md" }],
    });
    const reg = new VaultRegistry(api);
    const { seeded } = await reg.reconcile({ organizationId: ORG, vaultName: "acme" }, emptyTree());

    expect(createVault).not.toHaveBeenCalled();
    expect(reg.vaultId).toBe("v-owner");
    expect(seeded).toBe(false); // populated workspace never gets welcome content
    // Server-only note materialized locally so the sidebar shows it.
    expect(vi.mocked(ipc.writeNote)).toHaveBeenCalledWith("Team/hello.md", "");
    expect(reg.getMapping("Team/hello.md")).toEqual({ vaultId: "v-owner", docId: "n1" });
  });

  it("prefers an exact name match when the org has several vaults", async () => {
    const { api, createVault } = fakeApi({
      vaults: [
        { id: "v-old", name: "Old", organization_id: ORG },
        { id: "v-match", name: "acme", organization_id: ORG },
      ],
    });
    const reg = new VaultRegistry(api);
    await reg.reconcile({ organizationId: ORG, vaultName: "acme" }, emptyTree());
    expect(createVault).not.toHaveBeenCalled();
    expect(reg.vaultId).toBe("v-match");
  });

  it("ignores vaults from other workspaces and creates one when the org has none", async () => {
    const { api, createVault } = fakeApi({
      vaults: [{ id: "v-other", name: "acme", organization_id: "other-org" }],
    });
    const reg = new VaultRegistry(api);
    await reg.reconcile({ organizationId: ORG, vaultName: "acme" }, emptyTree());
    expect(createVault).toHaveBeenCalledWith({ name: "acme", organizationId: ORG });
    expect(reg.vaultId).toBe("created-acme");
  });

  it("keeps the vault recorded in .context/config.json when it still exists", async () => {
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      JSON.stringify({ serverVaultId: "v-cfg", docs: {} }),
    );
    const { api, createVault } = fakeApi({
      vaults: [
        { id: "v-cfg", name: "whatever", organization_id: ORG },
        { id: "v-other", name: "acme", organization_id: ORG },
      ],
    });
    const reg = new VaultRegistry(api);
    await reg.reconcile({ organizationId: ORG, vaultName: "acme" }, emptyTree());
    expect(reg.vaultId).toBe("v-cfg"); // config wins, even over a name match
    expect(createVault).not.toHaveBeenCalled();
  });

  it("heals a stale config vault id (wiped/foreign server) by re-adopting the org vault", async () => {
    vi.mocked(ipc.getVaultConfig).mockResolvedValue(
      JSON.stringify({ serverVaultId: "v-gone", docs: { "old.md": "dead-doc" } }),
    );
    const { api, createVault } = fakeApi({
      vaults: [{ id: "v-live", name: "Team Vault", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Welcome.md" }],
    });
    const reg = new VaultRegistry(api);
    await reg.reconcile({ organizationId: ORG, vaultName: "some-folder" }, emptyTree());
    expect(reg.vaultId).toBe("v-live");
    expect(createVault).not.toHaveBeenCalled();
    // Mapping rebuilt from the live vault, not the dead config.
    expect(reg.getMapping("old.md")).toBeNull();
    expect(reg.getMapping("Welcome.md")).toEqual({ vaultId: "v-live", docId: "n1" });
  });
});

describe("VaultRegistry.reconcile — seeding and materialization rules", () => {
  it("seeds welcome content ONLY when both the server vault and local folder are empty", async () => {
    const { api } = fakeApi({ vaults: [{ id: "v1", name: "fresh", organization_id: ORG }] });
    const reg = new VaultRegistry(api);
    const { seeded } = await reg.reconcile(
      { organizationId: ORG, vaultName: "fresh" },
      emptyTree(),
    );
    expect(seeded).toBe(true);
    expect(seedWelcomeContent).toHaveBeenCalledTimes(1);
  });

  it("does not seed when the local folder already has content", async () => {
    const { api, createNote } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
    });
    const reg = new VaultRegistry(api);
    const tree: TreeNode = {
      id: "root",
      name: "laptop",
      path: "",
      isDir: true,
      children: [{ id: "a", name: "Mine.md", path: "Mine.md", isDir: false }],
    };
    const { seeded } = await reg.reconcile({ organizationId: ORG, vaultName: "laptop" }, tree);
    expect(seeded).toBe(false);
    expect(seedWelcomeContent).not.toHaveBeenCalled();
    // The local-only note was registered on the server instead.
    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({ relPath: "Mine.md" }));
  });

  it("materializes only server-only notes; files already on disk are untouched", async () => {
    const { api } = fakeApi({
      vaults: [{ id: "v1", name: "laptop", organization_id: ORG }],
      notes: [
        { id: "n1", rel_path: "Shared.md" }, // server-only → materialize
        { id: "n2", rel_path: "Mine.md" }, // also local → leave alone
      ],
    });
    const reg = new VaultRegistry(api);
    const tree: TreeNode = {
      id: "root",
      name: "laptop",
      path: "",
      isDir: true,
      children: [{ id: "a", name: "Mine.md", path: "Mine.md", isDir: false }],
    };
    await reg.reconcile({ organizationId: ORG, vaultName: "laptop" }, tree);
    expect(vi.mocked(ipc.writeNote)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ipc.writeNote)).toHaveBeenCalledWith("Shared.md", "");
  });
});

describe("VaultRegistry.registerNote", () => {
  it("returns null before reconcile (sync not enabled yet)", async () => {
    const { api } = fakeApi({ vaults: [] });
    const reg = new VaultRegistry(api);
    expect(await reg.registerNote("New.md", "New")).toBeNull();
  });

  it("registers a new note into the adopted vault and persists the mapping", async () => {
    const { api, createNote } = fakeApi({
      vaults: [{ id: "v1", name: "acme", organization_id: ORG }],
      notes: [{ id: "n1", rel_path: "Welcome.md" }],
    });
    const reg = new VaultRegistry(api);
    await reg.reconcile({ organizationId: ORG, vaultName: "acme" }, emptyTree());
    const mapping = await reg.registerNote("Ideas/New.md", "New");
    expect(createNote).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: "Ideas/New.md", vaultId: "v1" }),
    );
    expect(mapping).toEqual({ vaultId: "v1", docId: "note-Ideas/New.md" });
    // Idempotent: a second call returns the cached mapping without re-creating.
    const again = await reg.registerNote("Ideas/New.md", "New");
    expect(again).toEqual(mapping);
    expect(createNote).toHaveBeenCalledTimes(1);
  });
});
