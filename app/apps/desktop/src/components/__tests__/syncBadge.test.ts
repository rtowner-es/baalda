import { describe, expect, it } from "vitest";
import { syncBadgeLabel } from "../Identity";

// The sync pill is the user-facing "is my work safe?" signal. These lock in the
// fix for the bug where it drifted to "Synced · 5m ago" while actively editing:
// pending edits must read "Saving…", and a fresh flush must read "just now".
describe("syncBadgeLabel", () => {
  const now = 1_000_000_000_000;

  it("shows Saving… while local edits are pending, ignoring the timestamp", () => {
    expect(
      syncBadgeLabel({ status: "synced", pending: true, lastSyncedAt: now - 300_000, now }),
    ).toBe("Saving…");
  });

  it("reads 'Synced · just now' immediately after a flush", () => {
    expect(
      syncBadgeLabel({ status: "synced", pending: false, lastSyncedAt: now, now }),
    ).toBe("Synced · just now");
  });

  it("counts up from the last flush once settled", () => {
    expect(
      syncBadgeLabel({ status: "synced", pending: false, lastSyncedAt: now - 300_000, now }),
    ).toBe("Synced · 5m ago");
  });

  it("falls back to 'Synced' when there is no timestamp yet", () => {
    expect(syncBadgeLabel({ status: "synced", lastSyncedAt: null, now })).toBe("Synced");
  });

  it("maps the non-synced statuses to fixed labels", () => {
    expect(syncBadgeLabel({ status: "read-only", now })).toBe("Read-only");
    expect(syncBadgeLabel({ status: "connecting", now })).toBe("Syncing…");
    expect(syncBadgeLabel({ status: "no-access", now })).toBe("No access");
    expect(syncBadgeLabel({ status: "error", now })).toBe("Retrying…");
    expect(syncBadgeLabel({ status: "offline", now })).toBe("Offline");
    expect(syncBadgeLabel({ status: "offline", enabled: false, now })).toBe("Local only");
  });
});
