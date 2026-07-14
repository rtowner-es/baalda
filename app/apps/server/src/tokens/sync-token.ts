import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { config } from "../config.js";

/**
 * Short-lived per-doc sync JWT (spec 03 §7, 04 §4). HS256, signed with the
 * shared secret. The Hocuspocus socket consumes this; TTL is short (~10m) so
 * revocation is near-instant.
 */
export interface SyncTokenClaims {
  docId: string;
  vaultId: string;
  readOnly: boolean;
}

const secret = new TextEncoder().encode(config.jwtSecret);
const ISSUER = "opencontext";
const AUDIENCE = "hocuspocus";

export async function mintSyncToken(
  claims: SyncTokenClaims,
  ttlSeconds: number = config.syncTokenTtlSeconds,
): Promise<string> {
  return new SignJWT({
    docId: claims.docId,
    vaultId: claims.vaultId,
    readOnly: claims.readOnly,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

export async function verifySyncToken(token: string): Promise<SyncTokenClaims> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (
    typeof payload.docId !== "string" ||
    typeof payload.vaultId !== "string" ||
    typeof payload.readOnly !== "boolean"
  ) {
    throw new Error("Malformed sync token claims");
  }
  return {
    docId: payload.docId,
    vaultId: payload.vaultId,
    readOnly: payload.readOnly,
  };
}

export { joseErrors };
