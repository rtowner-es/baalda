import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer`);
  return n;
}

export const config = {
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://context:context@localhost:5439/context",
  ),
  /** Shared secret: Better Auth crypto + HS256 per-doc sync JWTs. */
  jwtSecret: required("JWT_SECRET", "dev-only-insecure-change-me-please-32bytes"),
  betterAuthUrl: required("BETTER_AUTH_URL", "http://localhost:3010"),
  port: int("PORT", 3010),
  hocuspocusPort: int("HOCUSPOCUS_PORT", 3011),
  syncTokenTtlSeconds: int("SYNC_TOKEN_TTL_SECONDS", 600),
  compactionThreshold: int("COMPACTION_THRESHOLD", 50),
  invitationExpiresInSeconds: 48 * 60 * 60, // 48h per spec 04 §2
} as const;

export type AppConfig = typeof config;
