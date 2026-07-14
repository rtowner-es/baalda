<div align="center">

# OpenContext

**A local-first "second brain" where your notes are plain Markdown files — that an AI can edit directly _and_ your team edits together in real time.**

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![Built with Tauri v2](https://img.shields.io/badge/built%20with-Tauri%20v2-24C8DB)
![Rust](https://img.shields.io/badge/core-Rust-000000?logo=rust&logoColor=white)
![TypeScript](https://img.shields.io/badge/UI-TypeScript-3178C6?logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-released-brightgreen)
![License](https://img.shields.io/badge/license-Apache%202.0-blue)

</div>

<!-- Add a screenshot or short demo GIF here for the best first impression:
     ![OpenContext](docs/screenshot.png) -->

> _Add a screenshot or short demo GIF here — it's the single biggest upgrade a README can get._

---

## What is OpenContext?

OpenContext is an Obsidian-like desktop app for notes and knowledge — your **second brain**. Every note is a plain `.md` file on your own disk, so your data is always yours. What makes it different is that those same files are:

- **Editable by AI** — connect Claude or any AI assistant and it reads and writes your notes directly, like a teammate would.
- **Shared in real time** — invite people, share a folder, and edit the same note together with live cursors.

You get the openness of local Markdown files *and* the collaboration of a Google Doc, in one app.

---

## The problem it solves

Every open-source "second brain" app forces a choice:

| You can have… | …but not… |
|---|---|
| Notes as plain files an AI can edit | Real-time team collaboration |
| Real-time team collaboration | Notes as plain files an AI can edit |

Why? The two are built on **incompatible foundations**. AI-editable notes need loose Markdown on disk as the source of truth. Real-time collaboration is built on CRDTs, whose state is an opaque binary blob. No tool combined them.

We scanned **41** open-source Obsidian-like apps against **12 core requirements**. **None satisfied all 12.** OpenContext is the missing bridge between the two worlds — and that bridge is the whole product.

---

## Highlights

- 📄 **Your notes are just files.** Plain `.md` on disk — no lock-in, works with Git, and survives even if the server disappears.
- 🤖 **AI-editable.** A built-in [MCP](#-connect-an-ai-mcp) endpoint lets any AI client read and write your vault — gated by the exact same permissions as a human.
- 👥 **Real-time collaboration.** Invite teammates, share folders or single files (view / edit), and see live cursors and who's viewing a note.
- 🔒 **Local-first & private.** A full desktop app that works offline. Your Markdown never travels the network in plain text — only opaque binary sync updates do; each device re-derives its own `.md` files.
- 🔎 **Fast search & links.** Built-in full-text search (SQLite FTS5), backlinks, and tags, all indexed locally.
- 🖥️ **Native & cross-platform.** A lightweight Tauri v2 app for macOS, Windows, and Linux (iOS planned).
- 🛠️ **Self-hostable.** Runs entirely on your own infrastructure (Tauri + Node + Postgres). No vendor lock-in.
- 📎 **Attachments included.** Images and files sync alongside your notes.

---

## How it works

The core idea in one sentence: **the `.md` file on disk is the durable source of truth, and a live CRDT keeps every open copy in sync.**

- When you (or an AI) change a file, a watcher turns the change into CRDT **operations**.
- When a teammate edits the shared note, those operations flow back and are written to your file.

Because every change — from a person typing, an AI rewriting a paragraph, or a teammate across the world — funnels through the same CRDT as *operations* (never whole-file overwrites), edits **merge** instead of overwriting each other.

```
   You / AI / Git                       Teammates
        │                                   │
   edit .md file                     edit in real time
        │                                   │
        ▼                                   ▼
  ┌───────────────┐   operations    ┌────────────────┐
  │  Markdown on  │ ◀────────────▶  │   Live CRDT     │
  │     disk      │   (two-way)     │  (Yjs Y.Text)   │
  └───────────────┘                 └────────────────┘
   durable truth                     live sync + merge
```

Everything else — the desktop app, the search index, the sync server — is a rebuildable layer on top of your files.

---

## Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | **Tauri v2** (Rust core) |
| UI | **React + Vite + TypeScript** |
| Editor | **CodeMirror 6** |
| Files & watcher | **Rust** (`std::fs` / `tokio::fs`) |
| Local index | **SQLite** (FTS5 search + backlinks + tags) |
| Real-time sync | **Yjs** CRDT + **Hocuspocus** server |
| Database | **Postgres** (binary sync store) |
| Accounts & teams | **Better Auth** (argon2id, organizations) |
| AI access | **MCP** (Model Context Protocol) endpoint |

---

## Getting started

### Prerequisites

- **Node.js** ≥ 22
- **Rust** & Cargo ([rustup.rs](https://rustup.rs))
- **Docker** (for the Postgres database)

### 1. Install dependencies

```bash
cd app
npm install
```

### 2. Start the server

```bash
cd apps/server
cp .env.example .env      # adjust JWT_SECRET for anything real
npm run db:up             # start Postgres in Docker (host port 5439)
npm run migrate           # create the database schema
npm run dev               # HTTP API :3010 · sync WS :3011
```

### 3. Start the desktop app

From the `app/` directory:

```bash
npm run dev:desktop       # launches the Tauri app (Vite on :1420)
```

Open a folder of Markdown files (or create a new one) and start writing.

---

## 🤖 Connect an AI (MCP)

OpenContext exposes a **Model Context Protocol** endpoint, so any MCP-speaking AI client can work with your vault exactly like a person — limited by the same per-folder permissions.

1. In the app, go to **Workspace settings → MCP** and create a token.
2. Register the endpoint with your AI client, e.g. Claude Code:

```bash
claude mcp add --transport http opencontext http://localhost:3010/api/mcp \
  --header "Authorization: Bearer mcp_…"
```

The AI can now `read_note`, `search_notes`, `create_note`, `update_note`, and more — writes flow through the same sync engine, so if the note is open you'll watch the AI type in real time.

---

## Project status

🟢 **Released.** The core product is built, wired end-to-end, and tested — delivering **10 of the 12** target requirements, including the two no other open-source tool combined: AI-editable plain files **and** built-in real-time collaboration.

| Phase | Scope | Status |
|---|---|---|
| 0 | Single-user local app (open folder, edit, save, search) | ✅ Done |
| 1 | Local file ↔ CRDT bridge | ✅ Done |
| 2 | Sync server + accounts (multi-device) | ✅ Done |
| 3 | Team collaboration (sharing, permissions, live cursors, attachments) | ✅ Done |
| 4 | Polish & upgrades (WYSIWYG, semantic search, OAuth, iOS) | ⬜ Planned |

See [`docs/STATUS.md`](docs/STATUS.md) for the detailed checklist.

---

## Project structure

```
app/
├── apps/desktop/   Tauri v2 app — Rust core (src-tauri/) + React/Vite/TS UI (src/)
└── apps/server/    Node/TS — Hono HTTP + Hocuspocus sync + Postgres + Better Auth + MCP
docs/               Product overview, build status, specs, and reference research
```

Deep dives live in [`docs/`](docs/): the [product overview](docs/OpenContext.md), the design [specs](docs/specs/), and the [build status](docs/STATUS.md).

---

## Contributing

Issues and pull requests are welcome. If you're planning a larger change, please open an issue first to discuss it. Read the design docs in [`docs/`](docs/) to understand the architecture before diving in.

---

## License

OpenContext is open source under the **[Apache License 2.0](LICENSE)** — use it,
self-host it, modify it, and build commercial products on it, freely.

The **OpenContext** name and brand are trademarks and are **not** covered by the
code license — see the [Trademark Policy](TRADEMARK.md). You're welcome to fork
and run the code; please give your version its own name.

Contributions are welcome under the same license — **no CLA required**. See
[CONTRIBUTING.md](CONTRIBUTING.md), and report vulnerabilities via
[SECURITY.md](SECURITY.md).

> One exception: the [`ee/`](ee/) directory holds future commercial-only
> features under a separate [Enterprise License](ee/LICENSE). Everything else —
> the entire core — is Apache-2.0.
