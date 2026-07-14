// Per-item accent colors for folders and notes. Colors are a local, per-vault
// preference (like Finder tags): stored next to the vault choice in
// localStorage, keyed by vault-relative path, applied to the tree glyphs.

export interface ItemColor {
  id: string;
  label: string;
  /** Glyph tint — reads on both themes against the sidebar surfaces. */
  value: string;
}

export const ITEM_COLORS: ItemColor[] = [
  { id: "violet", label: "Violet", value: "#7c5cff" },
  { id: "blue", label: "Blue", value: "#2f7de1" },
  { id: "teal", label: "Teal", value: "#0d9488" },
  { id: "green", label: "Green", value: "#3f9d54" },
  { id: "amber", label: "Amber", value: "#d99114" },
  { id: "orange", label: "Orange", value: "#e0702f" },
  { id: "rose", label: "Rose", value: "#d94f77" },
  { id: "slate", label: "Slate", value: "#64748b" },
];

export function itemColorValue(id: string | undefined): string | undefined {
  return ITEM_COLORS.find((c) => c.id === id)?.value;
}

const STORE_PREFIX = "context.itemColors:";
const LEGACY_STORE_PREFIX = "opencontext.itemColors:";

/** One-time migration of legacy-prefixed keys to the neutral prefix. */
function migrateItemColorKeys(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(LEGACY_STORE_PREFIX)) continue;
      const suffix = key.slice(LEGACY_STORE_PREFIX.length);
      const newKey = STORE_PREFIX + suffix;
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, localStorage.getItem(key) ?? "{}");
      }
      localStorage.removeItem(key);
    }
  } catch {
    /* quota/unavailable — colors are a convenience only */
  }
}

export function readItemColors(vaultPath: string | undefined): Record<string, string> {
  if (!vaultPath) return {};
  migrateItemColorKeys();
  try {
    return JSON.parse(localStorage.getItem(STORE_PREFIX + vaultPath) ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

export function writeItemColors(vaultPath: string, colors: Record<string, string>): void {
  try {
    localStorage.setItem(STORE_PREFIX + vaultPath, JSON.stringify(colors));
  } catch {
    /* quota/unavailable — colors are a convenience only */
  }
}
