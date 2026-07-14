import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth } from "../src/auth/auth.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { bearerHeaders, createOrg, signIn, signUp } from "./helpers/auth.js";

describe("auth + organizations", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("signs up, stores an argon2id hash, and signs in", async () => {
    const user = await signUp("alice@example.com");
    expect(user.userId).toBeTruthy();
    expect(user.token).toBeTruthy();

    // Password must be hashed with argon2id (not scrypt / plaintext).
    const { rows } = await pool.query<{ password: string | null }>(
      `SELECT a.password FROM account a WHERE a."userId" = $1 AND a."providerId" = 'credential'`,
      [user.userId],
    );
    expect(rows[0]?.password).toBeTruthy();
    expect(rows[0]!.password!.startsWith("$argon2id$")).toBe(true);

    const again = await signIn("alice@example.com");
    expect(again.userId).toBe(user.userId);
  });

  it("rejects a wrong password", async () => {
    await signUp("bob@example.com", "correct-horse-battery");
    await expect(signIn("bob@example.com", "wrong-password")).rejects.toBeDefined();
  });

  it("creates an org, invites a teammate (48h), and accepts", async () => {
    const owner = await signUp("owner@acme.com");
    const org = await createOrg(owner, "Acme", "acme");
    expect(org.id).toBeTruthy();

    // owner becomes a member with role 'owner'
    const memberRows = await pool.query<{ role: string }>(
      `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
      [org.id, owner.userId],
    );
    expect(memberRows.rows[0]?.role).toBe("owner");

    // invite a teammate
    const invite = (await auth.api.createInvitation({
      headers: bearerHeaders(owner),
      body: { email: "teammate@acme.com", role: "member", organizationId: org.id },
    })) as { id: string; expiresAt: string | Date };
    expect(invite.id).toBeTruthy();

    // expiry ~48h out
    const expires = new Date(invite.expiresAt).getTime();
    const hoursOut = (expires - Date.now()) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(47);
    expect(hoursOut).toBeLessThan(49);

    // invitee signs up (email must match) and accepts
    const teammate = await signUp("teammate@acme.com");
    const accepted = (await auth.api.acceptInvitation({
      headers: bearerHeaders(teammate),
      body: { invitationId: invite.id },
    })) as { member?: { role: string } };
    expect(accepted.member?.role).toBe("member");

    // teammate now a member
    const check = await pool.query<{ role: string }>(
      `SELECT role FROM member WHERE "organizationId" = $1 AND "userId" = $2`,
      [org.id, teammate.userId],
    );
    expect(check.rows[0]?.role).toBe("member");
  });
});
