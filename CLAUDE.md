# OpenContext

**Context** is the product; **OpenContext** is the brand. A local-first desktop "second brain" where notes
are plain `.md` files on disk that an AI can edit directly **and** that teammates edit together in real
time. Every OSS competitor does one or the other; the whole product is the *bridge* between them.

- All product docs live under `docs/` (only this `CLAUDE.md` stays at the repo root).
- Docs index: `docs/OpenContext.md` · live build status: `docs/STATUS.md`
- Specs (source of truth for design): `docs/specs/00`–`04` + `docs/specs/REQUIREMENTS.md` (the 12-requirement yardstick)
- Prior art scan: `docs/reference/OSS Second Brain Scan.md`

## The one idea to hold in your head

`.md` files on disk are the **durable source of truth**. A per-note Yjs **`Y.Text` holding the raw
markdown string** is the **live source of truth** while a note is open/syncing. A bidirectional bridge
keeps them equal — both directions apply as CRDT *operations* (never whole-file overwrites), so a human
typing and an AI rewriting a paragraph **merge** instead of clobbering.

Two invariants everything depends on:
- **Key by `doc_id`, never by path.** A note's identity is a stable UUID shared across the `.md` file,
  the Yjs doc, the SQLite row, and the Postgres `notes`/`files` row. Renames/moves must never fork a note.
- **The server stores binary Y.Doc only.** Markdown never travels the wire — only opaque binary Yjs
  updates. Each client re-derives its own `.md` files and search index.

## Repo layout

Monorepo at `app/` (npm workspaces); all docs and specs live under `docs/`.

```
app/
├── apps/desktop/   Tauri v2 app. Rust core (src-tauri/) + React/Vite/TS UI (src/)
└── apps/server/    Node/TS: Hono HTTP + Hocuspocus WS + Postgres + Better Auth + MCP
docs/               OpenContext.md (index) · STATUS.md · specs/ · reference/
```

**Division of labor:** Rust owns *all* disk I/O and a derived SQLite index. The React/TS layer owns the
note buffer via the md↔CRDT bridge and all networked sync. The UI never touches the filesystem directly —
it calls typed Rust commands (`src/lib/ipc.ts`) and hits the server over HTTP (`src/lib/api.ts`).

## Build & run

Prereqs: Node ≥ 22, Rust/cargo, Docker (for Postgres). Run `npm install` once from `app/`.

**Server** (from `app/apps/server/`):
```bash
cp .env.example .env      # change JWT_SECRET for anything real
npm run db:up             # Postgres 16 in Docker, host port 5439
npm run migrate           # apply migrations/*.sql in order
npm run dev               # tsx watch; HTTP :3010, Hocuspocus WS :3011, GET /health
```

**Desktop** (from `app/`): `npm run dev:desktop` (= `npm run tauri dev -w desktop`; Vite on :1420).
Build: `npm run build:desktop`.

## Test

- Everything: `npm test` from `app/` (runs both workspaces).
- Server (`app/apps/server`): `npm test` (vitest). **Requires `db:up` + `migrate` first.** Runs serially
  against a shared Postgres (`fileParallelism: false`).
- Desktop TS (`app/apps/desktop`): `npm test` (vitest, node env). The bridge suites (`echo`, `concurrent`,
  `rewrite`, `roundtrip`) are the crown jewels — they gate correctness of the whole product. The sync
  `integration` test is env-gated (`OPENCONTEXT_IT=1`, needs a live server).
- Desktop Rust: `cargo test` in `src-tauri/` (unit tests inline per module + `tests/index_integration.rs`).

> ⚠️ Running `npm test` in `apps/server` wipes the dev DB (users/orgs/vaults). Re-seed afterward.

## Architecture by layer

### Desktop — Rust core (`app/apps/desktop/src-tauri/src/`)
Commands registered in `lib.rs`; `AppState` (`state.rs`) is one `Mutex` over `{ vault, index, watcher }`.
Errors: single `AppError(String)` (`error.rs`).
- `vault.rs` — path safety (`resolve_in_vault` rejects `..`/absolute/escape); ignores `.opencontext/`, `.git`, dotfiles.
- `tree.rs` — recursive walk to nested `TreeNode`; surfaces `.md`/`.html` only.
- `notefile.rs` — **atomic writes** (temp + rename), `sha256_hex`.
- `parse.rs` — `parse_note` → title / tags / `[[wikilinks]]` / frontmatter.
- `index.rs` — SQLite at `<vault>/.opencontext/index.sqlite` (WAL): `notes` (id=`doc_id`, path UNIQUE),
  FTS5 `notes_fts`, `tags`/`note_tags`, `links`, `folders`, `yjs_updates`, `yjs_snapshot`. Notes keyed by
  `doc_id`; `rebuild` preserves ids and never wipes the CRDT tables; `rename_note` rewrites paths by id so
  backlinks survive moves.
- `watcher.rs` — `notify` recursive watcher, 150ms-debounced, emits `file-changed {path, kind}`.
- `attachments.rs` — path-validated binary I/O under `attachments/`; never enters the note/CRDT pipeline.
- `keychain.rs` — `keyring` crate, service `com.opencontext.context`; trait-based so tests use a fake.

Tauri events to the UI: **`vault-opened`** and **`file-changed`** (the only two).

### Desktop — the bridge (`src/lib/bridge/`)
Pure TS with dependency-injected I/O so it runs under vitest in Node. `adapter.ts` wires production I/O.
`noteBridge.ts` = one `Y.Doc` with a single `Y.Text("content")` per note. Transaction origins:
`ORIGIN_DISK`, `ORIGIN_EDITOR`, `ORIGIN_REMOTE`.

**Loop avoidance — two guards you must never break:**
1. `onTextChange` ignores `disk`-origin transactions (don't write back what we just read in).
2. `lastWrittenHash`: egest hashes the bytes *before* writing; ingest drops any file read whose hash
   equals it (our own echo).

- **Ingest (disk→CRDT):** debounced 150ms; diff current serialization vs file (diff-match-patch), apply as
  `Y.Text` insert/delete under `disk` origin. A large diff ratio (>0.6, e.g. an AI whole-file rewrite)
  takes a recovery snapshot first.
- **Egest (CRDT→disk):** debounced 300ms; set echo hash, atomic write (Rust re-indexes on write).
- CRDT persistence: every `doc.on("update")` appends to the SQLite log; compact into a snapshot past ~64 updates.

### Desktop — sync (`src/lib/sync/`)
- `docSession.ts` (`syncManager`) — owns the registry, current `DocSync`, presence, attachments.
- `syncManager.ts` (`DocSync`) — `HocuspocusProvider` over the bridge's `Y.Doc`; doc name
  `vault:<vaultId>/note:<docId>`. Token is a **function** re-minted per (re)connect via `POST /api/sync-token`;
  403 → `no-access`. WS URL derived by swapping http→ws and 3010→3011.
- `startup.ts` (`decideSeed`) — **split-brain rule**: when signed in, pull from server FIRST, then seed a
  local orphan only if the doc is still empty. Reversing this causes permanent divergence.
- `registry.ts` — reconciles local vault ↔ server vault/folders/notes, persists the doc-id map to
  `.opencontext/config.json`, materializes server-only notes as empty files (hydrate lazily).
- `tokenRefresh.ts` — re-mint 60s before JWT expiry. `attachments.ts` — content-hash (sha256) diff, upload/download.

### Desktop — React (`src/`)
`store.ts` is a Zustand **UI view-state mirror only** (vault, tree, open note, auth/session, org members,
sync status, locks, prefs). Editor is CodeMirror 6 + `y-codemirror.next` (`yCollab`) — the buffer *is* the
markdown. In `collab` mode CM6 history/onChange are dropped so Yjs owns undo. Graph view is a hand-rolled
canvas force sim (no deps). Live-preview and inline-HTML rendering sanitize aggressively (drop
script/style/iframe, strip `on*`/`javascript:`).

### Server (`app/apps/server/src/`)
Two listeners, one Node process (`index.ts`): Hocuspocus WS (:3011) + Hono HTTP (:3010). MCP writes flow
through the same sync server via `createDocWriter` so AI edits persist/broadcast like human edits.
- `auth/auth.ts` — Better Auth; **argon2id** (overrides default scrypt) via `@node-rs/argon2`; `bearer` +
  `organization` plugins (org = workspace; roles owner/admin/member; 48h invitations). Session token is
  opaque (instant revocation), stored client-side only in the OS keychain.
- `http/routes/` — `registry` (vaults/folders/notes/files), `shares` (folder/file ACL), `orgs` (join codes),
  `graph` (nodes/edges + semantic search), `sync-token`, `blobs` (attachment store), `mcp`.
- `sync/hocuspocus.ts` — `onAuthenticate` verifies the per-doc JWT & sets `readOnly` for view grants;
  `onChange` appends the binary update + schedules re-index. `disconnectDoc` force-closes sockets on revoke.
- `yjs/persistence.ts` — binary-only store: `doc_updates` append log + `doc_snapshots` (compact past
  `COMPACTION_THRESHOLD`).
- `permissions/resolver.ts` — `effectivePermission(userId, docId)`: owner/admin → edit; else max of
  file share + ancestor-folder shares (walk `parent_id` up); a `locked` share caps at view even for admins.
  `edit > view > none`; no grant → no sync access (403 at token mint).
- `tokens/sync-token.ts` — HS256 per-doc JWT (`jose`), TTL `SYNC_TOKEN_TTL_SECONDS` (default 600).
- `mcp/` — JSON-RPC 2.0 over Streamable HTTP at `POST /api/mcp` (no SSE; GET/DELETE → 405). Tools:
  `list_vaults/list_folders/create_folder/delete_folder/list_notes/read_note/search_notes/create_note/update_note/append_note/delete_note`.
  Token = `mcp_…` minted from desktop Workspace Settings → MCP; scoped to one (user, workspace), gated by
  the **same** per-file ACL. Only a sha256 hash is stored.
- `index/` — `embedder.ts` is a dependency-free 256-dim hashed bag-of-words (works air-gapped;
  `OPENAI_API_KEY` swap noted but not wired). `indexer.ts` derives search + wikilink graph from Yjs state.
- `db/migrate.ts` — plain SQL in `migrations/*.sql`, applied in filename order, tracked in `_migrations`.

**Postgres tables** — Better Auth (`user`, `session`, `account`, `organization`, `member`, `invitation`;
camelCase quoted, migration 001), app tables (all ids `TEXT`, migration 002+): `vaults`, `folders`, `notes`
(id==doc_id, soft-delete via `deleted_at`), `files` (id==doc_id), `shares`, `doc_updates`, `doc_snapshots`,
`blobs`, `org_join_codes`, `note_index`, `note_links`, `mcp_tokens`.

## Server env vars (`app/apps/server/.env`)
`DATABASE_URL` (Docker host port **5439**→5432) · `JWT_SECRET` (Better Auth crypto **and** sync JWTs —
change in prod) · `BETTER_AUTH_URL` · `PORT` (3010) · `HOCUSPOCUS_PORT` (3011) · `SYNC_TOKEN_TTL_SECONDS`
(600) · `COMPACTION_THRESHOLD` (50) · `CORS_ORIGINS` (optional) · `OPENAI_API_KEY` (optional).

## Conventions & gotchas

- **`doc_id` is identity.** Never resolve or store a note by path across layers.
- **`.opencontext/` is sacred and hidden** — never walk, sync, or index it. It holds `index.sqlite`, the CRDT
  store, and `config.json` (server vault id + doc-id map; travels with the vault).
- **Reuse patterns, not code.** We study OSS references (Noteriv, Relay, Hocuspocus, Better Auth) but write
  our own implementation.
- **Debounce timings are load-bearing:** watcher/ingest ~150ms, egest ~300ms. Changing them affects the
  echo-loop and convergence tests.
- **IDs are `TEXT`, not `UUID`** server-side (Better Auth emits TEXT; lets `shares.resource_id` reference a
  folder or a file, and lets clients supply stable doc_ids).
- **Intentional spec deviations** (documented in-code): `index.rs` uses a *self-contained* FTS5 table (not
  the spec's contentless one) because `snippet()` needs content; `SearchPanel` renders the Rust FTS snippet
  via `dangerouslySetInnerHTML`, relying on Rust emitting only sanitized `<mark>` tags.
- Product identifier: `co.opencontext.context`; Tauri `productName` is "OpenContext".

## Build state (see `docs/STATUS.md`)

Phases 0–3 are complete and wired end-to-end: local Obsidian-lite → local CRDT bridge → sync server
(multi-device) → team collaboration (orgs, folder ACL, presence, attachments) — plus MCP, locks, join
codes, semantic search, and a graph view. Deferred to Phase 4: structural WYSIWYG CRDT, richer vector
search, AI-as-CRDT-peer, at-rest encryption, OAuth, and an iOS app.
