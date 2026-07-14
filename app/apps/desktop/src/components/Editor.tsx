import { useEffect, useRef, useState, type CSSProperties } from "react";
import "./editor.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { keymap, EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import { createEditorState } from "../lib/editor";
import { bridgeManager } from "../lib/bridge";
import { effectiveLockForPath, lockScopesByPath } from "../lib/locks";
import { playPingSound } from "../lib/presence/ping";
import { syncManager } from "../lib/sync/docSession";
import { colorForUser } from "../lib/presence/color";
import { useStore } from "../store";
import * as ipc from "../lib/ipc";
import { HtmlView } from "./HtmlView";

interface Peer {
  id: string;
  name: string;
  color: string;
  /** Line their cursor is on (from the `activity` awareness field), if known. */
  line: number | null;
}

interface AwarenessPeerState {
  user?: { id?: string; name?: string; color?: string };
  activity?: { line?: number };
  ping?: { to?: string; name?: string; at?: number };
}

/** Derive the unique peers currently present in a doc from awareness states. */
function readPeers(awareness: Awareness): Peer[] {
  const seen = new Map<string, Peer>();
  awareness.getStates().forEach((state) => {
    const s = state as AwarenessPeerState;
    const u = s.user;
    if (!u?.id) return;
    const prev = seen.get(u.id);
    const line = typeof s.activity?.line === "number" ? s.activity.line : null;
    if (!prev) {
      seen.set(u.id, {
        id: u.id,
        name: u.name ?? "Someone",
        color: u.color ?? colorForUser(u.id),
        line,
      });
    } else if (prev.line == null && line != null) {
      prev.line = line;
    }
  });
  return [...seen.values()];
}

/**
 * Build the image-`src` resolver the editor hands to live preview. Local vault
 * paths (relative to the note, or vault-root when prefixed with `/`) become
 * `asset:` URLs the webview can stream; already-loadable URLs pass through. The
 * vault dir is granted to the asset-protocol scope on open (Rust side).
 */
function makeResolveAsset(vaultPath: string | null, notePath: string) {
  return (src: string): string => {
    if (!src || /^(https?:|data:|blob:|asset:|tauri:|mailto:)/i.test(src)) return src;
    if (!vaultPath) return src;
    const noteDir = notePath.includes("/")
      ? notePath.slice(0, notePath.lastIndexOf("/"))
      : "";
    const rootRelative = src.startsWith("/");
    const segs = rootRelative || !noteDir ? [] : noteDir.split("/");
    for (const part of src.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") segs.pop();
      else segs.push(part);
    }
    const abs = `${vaultPath.replace(/\/$/, "")}/${segs.join("/")}`;
    return convertFileSrc(abs);
  };
}

/**
 * Save pasted/dropped image bytes under the vault's `attachments/` dir, named by
 * a short content hash so identical images de-dupe, and return the vault-root
 * markdown `src` to embed. `makeResolveAsset` turns that `/attachments/…` path
 * back into a loadable `asset:` URL for rendering.
 */
async function saveAttachment(bytes: Uint8Array, ext: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const rel = `attachments/${hash}.${ext}`;
  await ipc.writeBinaryFile(rel, bytes);
  return `/${rel}`;
}

/** Max avatars rendered before collapsing the rest into a "+N" chip. */
const MAX_AVATARS = 4;

/**
 * A peer's status ring colour: green while they're actively editing (cursor on a
 * line), amber when they're just viewing the note. Rendered as a coloured border
 * around their avatar via the `--status-color` custom property.
 */
function statusColor(peer: Peer): string {
  return peer.line != null ? "var(--success)" : "var(--warning)";
}

/** "Who's in this note" avatar row (spec 04 §5). Click an avatar for details. */
function PresenceBar({
  peers,
  activeId,
  onPeerClick,
}: {
  peers: Peer[];
  activeId: string | null;
  onPeerClick: (peer: Peer) => void;
}) {
  if (peers.length === 0) return null;
  const shown = peers.slice(0, MAX_AVATARS);
  const overflow = peers.length - shown.length;
  return (
    <div className="presence-bar">
      {shown.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`presence-avatar${activeId === p.id ? " card-open" : ""}`}
          style={
            {
              backgroundColor: p.color,
              "--status-color": statusColor(p),
            } as CSSProperties
          }
          data-name={p.name}
          aria-label={p.name}
          onClick={(e) => {
            e.stopPropagation();
            onPeerClick(p);
          }}
        >
          {p.name.slice(0, 1).toUpperCase()}
        </button>
      ))}
      {overflow > 0 && (
        <span
          className="presence-avatar presence-overflow"
          data-name={peers.slice(MAX_AVATARS).map((p) => p.name).join(", ")}
          aria-label={peers.slice(MAX_AVATARS).map((p) => p.name).join(", ")}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

/**
 * Peer detail card: who they are, where they are in the note, and a Ping
 * button — the ping plays a mention chime on their machine via awareness.
 */
function PeerCard({
  peer,
  isSelf,
  onPing,
  onClose,
}: {
  peer: Peer;
  isSelf: boolean;
  onPing: (peer: Peer) => void;
  onClose: () => void;
}) {
  const [pinged, setPinged] = useState(false);
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [onClose]);
  return (
    <div className="peer-card" onClick={(e) => e.stopPropagation()}>
      <div className="peer-card-head">
        <span
          className="presence-avatar static"
          style={
            {
              backgroundColor: peer.color,
              "--status-color": statusColor(peer),
            } as CSSProperties
          }
        >
          {peer.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="peer-card-meta">
          <span className="peer-card-name">
            {peer.name}
            {isSelf && <span className="muted"> (you)</span>}
          </span>
          <span className="peer-card-status">
            <span className="peer-dot" style={{ backgroundColor: peer.color }} />
            {peer.line != null ? `Editing line ${peer.line}` : "Viewing this note"}
          </span>
        </div>
      </div>
      {!isSelf && (
        <button
          className="primary sm peer-ping"
          disabled={pinged}
          onClick={() => {
            onPing(peer);
            setPinged(true);
          }}
        >
          {pinged ? "Pinged ✓" : "Ping"}
        </button>
      )}
    </div>
  );
}

/**
 * The note editor. CodeMirror is bound to the note's Y.Text through a
 * `y-codemirror.next` (yCollab) binding. Local keystrokes flow into the CRDT
 * (origin 'editor'); the bridge egests to disk on a debounce; external file
 * edits and remote peers merge live into the same Y.Text. When signed in and the
 * doc is shared, a HocuspocusProvider syncs it to the server and supplies live
 * cursors + presence; a view-only grant makes the editor read-only.
 */
export function Editor() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const openNote = useStore((s) => s.openNote);
  const syncEnabled = useStore((s) => s.syncEnabled);
  const locks = useStore((s) => s.locks);
  const session = useStore((s) => s.session);
  const tree = useStore((s) => s.tree);
  const notePath = openNote?.path ?? null;

  const [peers, setPeers] = useState<Peer[]>([]);
  const [readOnly, setReadOnly] = useState(false);
  const [cardPeer, setCardPeer] = useState<Peer | null>(null);
  const [pingFrom, setPingFrom] = useState<string | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  // Pings already played, keyed by sender clientId + timestamp.
  const seenPingsRef = useRef<Set<string>>(new Set());
  const isHtml = notePath != null && /\.html?$/i.test(notePath);

  // Is this note (or a containing folder) locked? Refines the read-only badge
  // copy — a lock is deliberate protection, not a missing grant.
  const lockScope =
    notePath && syncEnabled
      ? effectiveLockForPath(lockScopesByPath(tree, locks, session?.user.id), notePath)
      : null;

  useEffect(() => {
    if (!hostRef.current || notePath == null || /\.html?$/i.test(notePath)) return;
    const docId = useStore.getState().openNote?.id ?? null;
    if (docId == null) return; // wait until the note's doc_id (meta) is known
    const myUserId = useStore.getState().session?.user.id ?? null;

    let cancelled = false;
    let view: EditorView | null = null;
    let awareness: Awareness | null = null;
    let onAwarenessChange: (() => void) | null = null;

    const navigate = async (target: string) => {
      try {
        const resolved = await ipc.resolveWikilink(target);
        if (resolved) {
          await useStore.getState().openNoteByPath(resolved.path);
          return;
        }
        const slash = target.lastIndexOf("/");
        const dir = slash === -1 ? "" : target.slice(0, slash);
        const name = slash === -1 ? target : target.slice(slash + 1);
        const path = await ipc.createNote(dir, name);
        await useStore.getState().refreshTree();
        await useStore.getState().refreshTitles();
        await useStore.getState().openNoteByPath(path);
      } catch (err) {
        console.error("wiki-link navigation failed", err);
      }
    };

    (async () => {
      // Open the bridge; defer the disk-seed when this doc will sync so the
      // server's canonical state is pulled first (spec 03 §5 ordering).
      const willSync = syncManager.willSync(notePath);
      const bridge = await bridgeManager.openNote(notePath, docId, {
        seedFromFile: !willSync,
      });
      if (cancelled || !hostRef.current) return;

      const opened = await syncManager.openDoc(bridge, notePath);
      if (cancelled || !hostRef.current) {
        return;
      }
      awareness = opened.awareness;
      awarenessRef.current = awareness;
      const ro = opened.readOnly;
      setReadOnly(ro);

      const state = createEditorState({
        doc: bridge.text.toString(),
        collab: true,
        getTitles: () => useStore.getState().titles,
        onNavigate: (t) => void navigate(t),
        resolveAsset: makeResolveAsset(
          useStore.getState().vault?.path ?? null,
          notePath
        ),
        saveAttachment,
        extraExtensions: [
          yCollab(bridge.text, awareness, { undoManager: bridge.undoManager }),
          keymap.of(yUndoManagerKeymap),
          // Publish "editing line N" so peers can see where everyone is.
          EditorView.updateListener.of((u) => {
            if (!u.selectionSet && !u.docChanged && !u.focusChanged) return;
            const line = u.state.doc.lineAt(u.state.selection.main.head).number;
            awareness?.setLocalStateField("activity", { line });
          }),
          // View-only grants: the editor cannot be typed into (spec 04 §4).
          ...(ro
            ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
            : []),
        ],
      });

      view = new EditorView({ state, parent: hostRef.current });
      viewRef.current = view;
      if (!ro) view.focus();

      // Live "who's here" avatar row + incoming pings addressed to this user.
      onAwarenessChange = () => {
        if (cancelled || !awareness) return;
        setPeers(readPeers(awareness));
        if (!myUserId) return;
        awareness.getStates().forEach((state, clientId) => {
          if (clientId === awareness!.clientID) return;
          const ping = (state as AwarenessPeerState).ping;
          if (!ping?.at || ping.to !== myUserId) return;
          const key = `${clientId}:${ping.at}`;
          // Only fresh pings ring — stale awareness replays stay silent.
          if (seenPingsRef.current.has(key) || Date.now() - ping.at > 10_000) return;
          seenPingsRef.current.add(key);
          playPingSound();
          setPingFrom(ping.name ?? "Someone");
          window.setTimeout(() => setPingFrom(null), 4000);
        });
      };
      awareness.on("change", onAwarenessChange);
      onAwarenessChange();
    })();

    return () => {
      cancelled = true;
      if (onAwarenessChange && awareness) awareness.off("change", onAwarenessChange);
      if (view) view.destroy();
      viewRef.current = null;
      awarenessRef.current = null;
      seenPingsRef.current.clear();
      setPeers([]);
      setReadOnly(false);
      setCardPeer(null);
      setPingFrom(null);
      // Tear down the network session, then flush + close the bridge.
      syncManager.closeCurrent();
      void bridgeManager.closeCurrent();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notePath, syncEnabled]);

  if (notePath == null) {
    return (
      <div className="editor-empty">
        <p>Select a note, or press ⌘N to create one.</p>
      </div>
    );
  }

  // HTML pages render live in a sandboxed frame instead of the CRDT editor.
  if (isHtml) {
    return <HtmlView path={notePath} />;
  }

  const myId = session?.user.id ?? null;

  const sendPing = (peer: Peer) => {
    const me = useStore.getState().session?.user;
    awarenessRef.current?.setLocalStateField("ping", {
      to: peer.id,
      name: me?.name || me?.email || "Someone",
      at: Date.now(),
    });
  };

  const showToolbar = peers.length > 0 || readOnly;

  return (
    <div className="editor-column">
      {showToolbar && (
        <div className="editor-toolbar">
          <PresenceBar
            peers={peers}
            activeId={cardPeer?.id ?? null}
            onPeerClick={(p) => setCardPeer((c) => (c?.id === p.id ? null : p))}
          />
          {cardPeer && (
            <PeerCard
              // Re-read live data so the card tracks the peer's cursor line.
              peer={peers.find((p) => p.id === cardPeer.id) ?? cardPeer}
              isSelf={cardPeer.id === myId}
              onPing={sendPing}
              onClose={() => setCardPeer(null)}
            />
          )}
          {pingFrom && (
            <span className="ping-toast" role="status">
              🔔 {pingFrom} pinged you
            </span>
          )}
          {readOnly && (
            <span
              className="readonly-badge"
              title={
                lockScope
                  ? "This note is locked — changes won't sync"
                  : "You have view-only access"
              }
            >
              <span className="readonly-lock" aria-hidden="true">
                🔒
              </span>
              {lockScope ? "Locked" : "Read-only"}
            </span>
          )}
        </div>
      )}
      <div className="editor-host" ref={hostRef} />
    </div>
  );
}
