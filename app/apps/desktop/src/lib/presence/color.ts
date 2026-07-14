// Deterministic presence colors (spec 04 §5). A user's cursor/selection color is
// derived from their stable id so it's identical across every client and every
// session — no server round-trip, no per-connection randomness.

/**
 * A curated palette harmonized with the violet accent: jewel tones at a
 * consistent depth so white initials/cursor labels stay legible, and no single
 * hue clashes with the UI. Reads on both light and dark surfaces.
 */
export const PRESENCE_PALETTE = [
  "#6366f1", // indigo
  "#2563eb", // blue
  "#0284c7", // sky
  "#0d9488", // teal
  "#059669", // emerald
  "#16a34a", // green
  "#d97706", // amber
  "#ea580c", // orange
  "#e11d48", // rose
  "#db2777", // pink
  "#c026d3", // fuchsia
  "#9333ea", // purple
] as const;

/** Stable 32-bit FNV-1a hash of a string. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in unsigned range.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Pick a deterministic palette color for a user id. */
export function colorForUser(userId: string): string {
  if (!userId) return PRESENCE_PALETTE[0];
  const idx = hashString(userId) % PRESENCE_PALETTE.length;
  return PRESENCE_PALETTE[idx];
}

/** The awareness `user` field every client publishes for cursors + avatars. */
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

export function presenceUser(userId: string, name: string): PresenceUser {
  return { id: userId, name, color: colorForUser(userId) };
}
