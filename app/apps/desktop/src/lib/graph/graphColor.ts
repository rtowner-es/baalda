import type { ColorMode } from "./graphSettings";
import type { GraphNode } from "./buildGraph";

/** One row of the legend the panel renders alongside the canvas. */
export interface LegendEntry {
  label: string;
  color: string;
  count: number;
}

/** Result of a coloring pass: a per-node lookup plus a summarizing legend. */
export interface ColorResult {
  colorById: Map<string, string>;
  legend: LegendEntry[];
}

/**
 * Muted, slightly desaturated hues chosen to stay legible on BOTH a light and a
 * deep-dark canvas. Pure primaries wash out or vibrate against dark bg, so these
 * sit in the mid-luminance / mid-saturation band that reads on either.
 */
export const PALETTE: string[] = [
  "#7c7cff", // indigo
  "#25d6bf", // teal
  "#ffc24d", // amber
  "#ff5f8f", // rose
  "#46d96f", // green
  "#b06bff", // violet
  "#38c6ff", // cyan
  "#ff8a3d", // orange
  "#b6e02a", // lime
  "#ff6fd0", // pink
  "#4d8dff", // blue
  "#9fb0d8", // steel
];

/** Clamp to a byte so channel math never overflows the 0–255 range. */
function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Parse "#rrggbb" (or "#rgb") into [r,g,b]; falls back to mid-grey if unparseable. */
function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return [128, 128, 128];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: [number, number, number]): string {
  const s = (n: number) => clampByte(n).toString(16).padStart(2, "0");
  return `#${s(r)}${s(g)}${s(b)}`;
}

/**
 * Deterministic per-channel linear interpolation between two hex colors.
 * t is clamped to [0,1]; t=0 → a, t=1 → b. Kept intentionally simple (no
 * gamma/HSL) — the degree ramp only needs a visually monotonic blend.
 */
export function lerpHex(a: string, b: string, t: number): string {
  const clampT = Math.max(0, Math.min(1, t));
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex([
    ca[0] + (cb[0] - ca[0]) * clampT,
    ca[1] + (cb[1] - ca[1]) * clampT,
    ca[2] + (cb[2] - ca[2]) * clampT,
  ]);
}

/** Top-level folder segment of a note path; notes at the root bucket as "Root". */
function topFolder(path: string): string {
  return path.includes("/") ? path.split("/")[0] : "Root";
}

function assignByFolder(nodes: GraphNode[]): ColorResult {
  // Stable colors: sort distinct folders alphabetically, then index into PALETTE.
  const folders = Array.from(new Set(nodes.map((n) => topFolder(n.path)))).sort();
  const folderColor = new Map<string, string>();
  folders.forEach((f, i) => folderColor.set(f, PALETTE[i % PALETTE.length]));

  const colorById = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const f = topFolder(n.path);
    colorById.set(n.id, folderColor.get(f)!);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }

  const legend: LegendEntry[] = folders
    .map((f) => ({ label: f, color: folderColor.get(f)!, count: counts.get(f) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return { colorById, legend };
}

function assignByDegree(nodes: GraphNode[], accent: string): ColorResult {
  // Muted base → accent ramp across 4 tiers: {0, low, mid, high}.
  const base = "#7a8290"; // slate, the "cold"/low end of the ramp
  const shades = [0, 1, 2, 3].map((i) => lerpHex(base, accent, i / 3));

  const maxDeg = nodes.reduce((m, n) => Math.max(m, n.linkCount), 0);

  // Tier boundaries over the positive range [1, maxDeg], split into thirds.
  // tierOf returns 0 for orphans (0 links), else 1..3.
  const span = Math.max(1, maxDeg - 1);
  const lowMax = 1 + Math.floor(span / 3);
  const midMax = 1 + Math.floor((span * 2) / 3);

  const tierOf = (deg: number): number => {
    if (deg <= 0) return 0;
    if (deg <= lowMax) return 1;
    if (deg <= midMax) return 2;
    return 3;
  };

  const colorById = new Map<string, string>();
  const counts = [0, 0, 0, 0];
  for (const n of nodes) {
    const t = tierOf(n.linkCount);
    colorById.set(n.id, shades[t]);
    counts[t]++;
  }

  const labels = [
    "0",
    lowMax <= 1 ? "1" : `1–${lowMax}`,
    midMax <= lowMax + 1 ? `${lowMax + 1}` : `${lowMax + 1}–${midMax}`,
    maxDeg <= midMax + 1 ? `${Math.max(midMax + 1, maxDeg)}` : `${midMax + 1}–${maxDeg}`,
  ];

  const legend: LegendEntry[] = [0, 1, 2, 3].map((i) => ({
    label: labels[i],
    color: shades[i],
    count: counts[i],
  }));

  return { colorById, legend };
}

/**
 * Assign a fill color to every node according to `mode`. Pure and deterministic
 * so the canvas layer can recolor on demand without side effects.
 */
export function assignColors(
  nodes: GraphNode[],
  mode: ColorMode,
  accent: string,
): ColorResult {
  switch (mode) {
    case "folder":
      return assignByFolder(nodes);
    case "degree":
      return assignByDegree(nodes, accent);
    case "uniform":
    default: {
      const colorById = new Map<string, string>();
      for (const n of nodes) colorById.set(n.id, accent);
      return { colorById, legend: [] };
    }
  }
}
