import { useEffect, useMemo, useState } from "react";
import { createAvatar } from "@dicebear/core";
import { notionists } from "@dicebear/collection";
import { PRESENCE_PALETTE } from "../lib/presence/color";

/* ============================================================
   Character avatars — every user is auto-assigned a unique illustrated
   character (DiceBear "notionists" — clean, professional Notion-style line
   art) from a stable seed (their id/email/name), so nobody is stuck with a
   flat "TU". Generated as pure SVG on-device: no network, no external avatar
   service (which would break local-first and leak identity), and the same
   seed renders the same character on every machine. Backgrounds are drawn
   from our happy palette so the vibe stays coherent.
   ============================================================ */

// Palette hex values without the leading "#", as DiceBear expects. DiceBear
// deterministically picks one per seed, so each character gets its own colour.
const AVATAR_BG = PRESENCE_PALETTE.map((c) => c.slice(1));

/** Build the illustrated-character SVG for a seed. */
export function characterSvg(seed: string): string {
  return createAvatar(notionists, {
    seed,
    backgroundColor: AVATAR_BG,
    backgroundType: ["solid"],
    radius: 50,
  }).toString();
}

export function Avatar({ label, image }: { label: string; image?: string | null }) {
  const svg = useMemo(() => characterSvg(label || "?"), [label]);
  // Prefer a real profile photo (e.g. from Google) when present; fall back to
  // the generated character if there's no image or it fails to load.
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [image]);

  if (image && !imgFailed) {
    return (
      <span className="avatar" aria-hidden="true">
        <img
          src={image}
          alt=""
          // Google's lh3.googleusercontent.com can 403 when a referrer is sent.
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
        />
      </span>
    );
  }
  return (
    <span
      className="avatar"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** "just now" / "1m ago" / "2h ago" — coarse on purpose; it ticks every 30s. */
export function relativeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Pure label for the sync pill. Extracted so the (surprisingly load-bearing)
 * "Saving…" vs "Synced · just now" logic is unit-testable without a DOM.
 *
 * `pending` (local edits not yet acked) wins over the timestamp: while flushing
 * we show "Saving…"; once acked, the caller has bumped `lastSyncedAt`, so it
 * reads "Synced · just now" and counts up from there.
 */
export function syncBadgeLabel(args: {
  status: string;
  pending?: boolean;
  lastSyncedAt?: number | null;
  now: number;
  enabled?: boolean;
}): string {
  const { status, pending, lastSyncedAt, now, enabled } = args;
  if (status === "synced") {
    if (pending) return "Saving…";
    return lastSyncedAt != null ? `Synced · ${relativeAgo(lastSyncedAt, now)}` : "Synced";
  }
  if (status === "read-only") return "Read-only";
  if (status === "connecting") return "Syncing…";
  if (status === "no-access") return "No access";
  if (status === "error") return "Retrying…";
  return enabled === false ? "Local only" : "Offline";
}

function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export function SyncBadge({
  status,
  enabled,
  lastSyncedAt,
  pending,
}: {
  status: string;
  enabled?: boolean;
  /** When set and status is "synced", the badge reads "Synced · 1m ago". */
  lastSyncedAt?: number | null;
  /** True while local edits are still flushing to the server → "Saving…". */
  pending?: boolean;
}) {
  // Only tick the relative clock once we're settled (synced, nothing pending).
  const now = useNowTick(status === "synced" && !pending && lastSyncedAt != null);
  const label = syncBadgeLabel({ status, pending, lastSyncedAt, now, enabled });
  return (
    <span className={`sync-badge ${status}${pending ? " pending" : ""}`}>
      {status === "connecting" || (status === "synced" && pending) ? (
        <span className="sync-progress" aria-hidden="true">
          <span className="sync-progress-fill" />
        </span>
      ) : status === "read-only" ? (
        <svg
          className="sync-lock"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      ) : (
        <span className="sync-dot" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}
