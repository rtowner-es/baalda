// Shared contract for the Graph View's tunable settings. Every graph module
// imports the types + defaults from here so the simulation, renderer, color
// assignment, and controls panel all agree on one shape.
//
// Settings persist to localStorage under SETTINGS_STORAGE_KEY so a user's tuned
// physics/visual preferences survive app restarts.

/** How node fill colors are derived. */
export type ColorMode = "folder" | "degree" | "uniform";

export interface GraphSettings {
  // ---- Forces (physics) ----
  /** Many-body repulsion. More negative = stronger push-apart. */
  charge: number;
  /** Rest length of link springs, in world units. */
  linkDistance: number;
  /** Link spring stiffness, 0..1. */
  linkStrength: number;
  /** Pull toward the center of gravity, 0..0.5. Higher = tighter circle. */
  gravity: number;

  // ---- Visual ----
  /** Multiplier on every node's base radius. */
  nodeSize: number;
  /** Multiplier on edge line width. */
  edgeThickness: number;
  /** Multiplier on the zoom level at which labels fade in (higher = labels sooner). */
  labelScale: number;
  /** Node fill color strategy. */
  colorMode: ColorMode;

  // ---- Filter ----
  /** Case-insensitive title substring; non-matches are dimmed (empty = no filter). */
  search: string;
  /** Hide nodes whose degree (linkCount) is below this. */
  minDegree: number;
  /** Hide nodes with zero links. */
  hideOrphans: boolean;
}

export const DEFAULT_SETTINGS: GraphSettings = {
  charge: -10.8,
  linkDistance: 1.5,
  linkStrength: 1,
  gravity: 0.5,
  nodeSize: 1,
  edgeThickness: 1,
  labelScale: 1,
  colorMode: "folder",
  search: "",
  minDegree: 0,
  hideOrphans: false,
};

/** Inclusive slider ranges + step for the numeric controls, keyed by setting. */
export const SETTING_RANGES = {
  charge: { min: -1500, max: -1, step: 0.2 },
  linkDistance: { min: 1, max: 400, step: 0.5 },
  linkStrength: { min: 0, max: 1, step: 0.02 },
  gravity: { min: 0, max: 1, step: 0.01 },
  nodeSize: { min: 0.4, max: 4, step: 0.1 },
  edgeThickness: { min: 0.4, max: 4, step: 0.1 },
  labelScale: { min: 0, max: 2, step: 0.05 },
  minDegree: { min: 0, max: 20, step: 1 },
} as const;

// Bumped v1 → v2 so the new physics defaults take effect over any saved values.
export const SETTINGS_STORAGE_KEY = "context.graph.settings.v2";

/** Load persisted settings, merged over defaults (tolerant of missing/old keys). */
export function loadSettings(): GraphSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GraphSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist settings (best-effort; ignores quota/serialization errors). */
export function saveSettings(settings: GraphSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
