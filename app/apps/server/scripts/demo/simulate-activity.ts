// ============================================================================
//  DEMO ACTIVITY SIMULATOR — live teammates for a recording
//  Connects the demo org's members to the sync server as headless clients,
//  concentrates them on a "hot set" of notes, and drives:
//    • presence  — each connection publishes a `user` awareness field so the
//                  profile circles light up (coloured exactly like the app does)
//    • cursors   — a wandering `cursor` (Yjs relative position) so remote carets
//                  glide around, each labelled with the teammate's name/colour
//    • activity  — an `activity` line marker ("Editing line N")
//    • edits     — occasional transient typing on SAFE notes (Team Journal /
//                  index notes), inserted then removed so content is unchanged
//
//  Run:   npm run demo:activity          (after npm run seed:demo)
//         DEMO_FOCUS="Projects" npm run demo:activity   (crowd one area)
//         DEMO_SKIP_EMAIL="ava@testorg.demo" npm run demo:activity
//
//  Ctrl-C to stop (disconnects everyone cleanly).
// ============================================================================

import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

import { pool, closePool } from "../../src/db/pool.js";
import { mintSyncToken } from "../../src/tokens/sync-token.js";
import { buildTeam, colorForUser, demoConfig, mulberry32 } from "./config.js";

const TOKEN_TTL = 12 * 60 * 60; // 12h so tokens outlast a long recording
const FOCUS = process.env.DEMO_FOCUS ?? "";

interface Member {
  id: string;
  name: string;
  email: string;
}
interface NoteRow {
  id: string;
  relPath: string;
}

/** One live teammate-on-a-note connection. */
interface Client {
  provider: HocuspocusProvider;
  doc: Y.Doc;
  member: Member;
  note: NoteRow;
  pos: number;
  timer: ReturnType<typeof setInterval> | null;
  rand: () => number;
}

const clients: Client[] = [];
let stopping = false;

function isSafeToEdit(relPath: string): boolean {
  return (
    relPath.startsWith("Team Journal/") ||
    relPath.endsWith("_Index.md") ||
    relPath === "_Workspace Index.md"
  );
}

async function loadWorld(): Promise<{ vaultId: string; members: Member[]; notes: NoteRow[] }> {
  const org = await pool.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
    demoConfig.orgSlug,
  ]);
  const orgId = org.rows[0]?.id;
  if (!orgId) throw new Error(`No org "${demoConfig.orgSlug}". Run: npm run seed:demo`);

  const vault = await pool.query<{ id: string }>(
    "SELECT id FROM vaults WHERE organization_id = $1 ORDER BY created_at LIMIT 1",
    [orgId],
  );
  const vaultId = vault.rows[0]?.id;
  if (!vaultId) throw new Error("Org has no vault — reseed.");

  const mem = await pool.query<{ id: string; name: string; email: string }>(
    `SELECT u.id, u.name, u.email FROM member m
     JOIN "user" u ON u.id = m."userId"
     WHERE m."organizationId" = $1`,
    [orgId],
  );
  const members = mem.rows.filter((m) => m.email !== demoConfig.skipEmail);

  const noteRows = await pool.query<{ id: string; rel_path: string }>(
    "SELECT id, rel_path FROM notes WHERE vault_id = $1 AND deleted_at IS NULL",
    [vaultId],
  );
  const notes = noteRows.rows.map((r) => ({ id: r.id, relPath: r.rel_path }));
  return { vaultId, members, notes };
}

/** Choose the notes we crowd: focus filter if set, else nice showcase notes. */
function pickHotNotes(notes: NoteRow[], memberCount: number): NoteRow[] {
  const capacity = Math.max(2, Math.floor((memberCount * demoConfig.docsPerUser) / 2));
  const wanted = Math.min(demoConfig.hotSetSize, capacity);

  let pool_ = notes;
  if (FOCUS) pool_ = notes.filter((n) => n.relPath.includes(FOCUS));
  if (pool_.length === 0) pool_ = notes;

  // Rank: generated index/journal notes first (guaranteed content), then
  // shallow top-level notes (read nicely), then everything else.
  const score = (n: NoteRow): number => {
    if (n.relPath.endsWith("_Index.md") || n.relPath === "_Workspace Index.md") return 0;
    if (n.relPath.startsWith("Team Journal/")) return 1;
    return 2 + n.relPath.split("/").length;
  };
  const ranked = [...pool_].sort((a, b) => score(a) - score(b) || a.relPath.localeCompare(b.relPath));
  return ranked.slice(0, wanted);
}

async function makeClient(vaultId: string, member: Member, note: NoteRow, seed: number): Promise<void> {
  const doc = new Y.Doc();
  const name = `vault:${vaultId}/note:${note.id}`;
  const provider = new HocuspocusProvider({
    url: demoConfig.wsUrl,
    name,
    document: doc,
    token: async () => mintSyncToken({ docId: note.id, vaultId, readOnly: false }, TOKEN_TTL),
    onAuthenticationFailed: ({ reason }) =>
      console.warn(`   auth failed (${member.name} → ${note.relPath}): ${reason}`),
    // WebSocketPolyfill isn't in this version's config type; pass it via a
    // spread so it slips past the excess-property check (same trick the desktop
    // client uses). The provider forwards it to its internal websocket.
    ...({ WebSocketPolyfill: WebSocket } as object),
  });
  // A bare ws 'error' (transient reset, server restart) is emitted on the
  // socket's EventEmitter; without a listener Node would crash the whole run.
  (provider.configuration.websocketProvider as unknown as {
    on?: (e: string, f: (err: unknown) => void) => void;
  })?.on?.("error", () => {
    /* swallow — the provider will retry on its own backoff */
  });

  const client: Client = {
    provider,
    doc,
    member,
    note,
    pos: 0,
    timer: null,
    rand: mulberry32(seed),
  };
  clients.push(client);

  // Presence circle: publish the `user` field the moment we connect.
  provider.setAwarenessField("user", {
    id: member.id,
    name: member.name,
    color: colorForUser(member.id),
    status: "online",
  });

  provider.on("synced", () => {
    if (stopping) return;
    client.pos = Math.floor(client.rand() * Math.max(1, doc.getText("content").length));
    client.timer = setInterval(() => tick(client), 1000 + Math.floor(client.rand() * 900));
  });
}

/** One animation step for a client: wander the caret, mark activity, maybe type. */
function tick(client: Client): void {
  if (stopping) return;
  const ytext = client.doc.getText("content");
  const len = ytext.length;
  if (len <= 0) return;

  // Wander: hop forward/back by up to ~48 chars, wrapping around the doc.
  const delta = Math.floor((client.rand() - 0.35) * 96);
  client.pos = ((client.pos + delta) % len + len) % len;
  const i = Math.min(client.pos, len);

  const anchor = Y.createRelativePositionFromTypeIndex(ytext, i);
  const head = Y.createRelativePositionFromTypeIndex(ytext, i);
  client.provider.setAwarenessField("cursor", { anchor, head });

  const line = ytext.toString().slice(0, i).split("\n").length;
  client.provider.setAwarenessField("activity", { line, at: Date.now() });

  // Occasional transient "typing" on safe notes only — inserted then removed so
  // the note's content is left exactly as seeded.
  if (isSafeToEdit(client.note.relPath) && client.rand() < 0.18) {
    const word = " ✍";
    ytext.insert(i, word);
    setTimeout(() => {
      if (stopping) return;
      const cur = client.doc.getText("content");
      if (i + word.length <= cur.length) cur.delete(i, word.length);
    }, 600);
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("\n👋  Disconnecting teammates…");
  for (const c of clients) {
    if (c.timer) clearInterval(c.timer);
    try {
      c.provider.destroy();
    } catch {
      /* ignore */
    }
    c.doc.destroy();
  }
  await closePool().catch(() => {});
  process.exit(0);
}

async function main(): Promise<void> {
  const { vaultId, members, notes } = await loadWorld();
  if (members.length === 0) throw new Error("No members to simulate (all skipped?).");

  const hot = pickHotNotes(notes, members.length);
  console.log(
    `\n🎬  Simulating ${members.length} teammates across ${hot.length} hot notes ` +
      `(${members.length * demoConfig.docsPerUser} live connections)`,
  );
  if (FOCUS) console.log(`   focus filter: rel_path contains "${FOCUS}"`);

  // Stagger each member across the hot set so every hot note gets ~2-3 people.
  const opens: Array<{ member: Member; note: NoteRow }> = [];
  members.forEach((member, k) => {
    for (let j = 0; j < demoConfig.docsPerUser; j++) {
      const note = hot[(k * demoConfig.docsPerUser + j) % hot.length];
      opens.push({ member, note });
    }
  });

  // Open connections with a small stagger to avoid a thundering herd.
  let seed = 1;
  for (const { member, note } of opens) {
    if (stopping) break;
    await makeClient(vaultId, member, note, seed++);
    await new Promise((r) => setTimeout(r, 40));
  }

  console.log("\n🎥  Open any of these files on camera to see live teammates:\n");
  for (const n of hot.slice(0, 20)) console.log(`   • ${n.relPath}`);
  if (hot.length > 20) console.log(`   … and ${hot.length - 20} more`);
  console.log("\n   (Ctrl-C to stop.)\n");
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// Backstop: a stray socket error/rejection should never tear down the demo.
process.on("uncaughtException", (e) => console.warn("   (ignored)", (e as Error)?.message));
process.on("unhandledRejection", (e) => console.warn("   (ignored)", (e as Error)?.message));

main().catch(async (err) => {
  console.error("\n❌  Simulator failed:\n", err);
  await closePool().catch(() => {});
  process.exit(1);
});
