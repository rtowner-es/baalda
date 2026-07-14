import { useEffect, useState } from "react";

/** Deterministic, theme-stable avatar color + initials from a display name. */
function avatarProps(label: string): { color: string; initials: string } {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  const initials =
    label
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?";
  return { color: `hsl(${hue} 58% 55%)`, initials };
}

export function Avatar({ label }: { label: string }) {
  const { color, initials } = avatarProps(label);
  return (
    <span className="avatar" style={{ backgroundColor: color }} aria-hidden="true">
      {initials}
    </span>
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
}: {
  status: string;
  enabled?: boolean;
  /** When set and status is "synced", the badge reads "Synced · 1m ago". */
  lastSyncedAt?: number | null;
}) {
  const now = useNowTick(status === "synced" && lastSyncedAt != null);
  const label =
    status === "synced"
      ? lastSyncedAt != null
        ? `Synced · ${relativeAgo(lastSyncedAt, now)}`
        : "Synced"
      : status === "read-only"
        ? "Read-only"
        : status === "connecting"
          ? "Syncing…"
          : status === "no-access"
            ? "No access"
            : status === "error"
              ? "Retrying…"
              : enabled === false
                ? "Local only"
                : "Offline";
  return (
    <span className={`sync-badge ${status}`}>
      {status === "connecting" ? (
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
