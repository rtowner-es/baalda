import { describe, expect, it } from "vitest";
import { deriveWsUrl } from "../syncManager";

describe("deriveWsUrl", () => {
  it("appends /sync on the same origin/port for a no-port https host", () => {
    expect(deriveWsUrl("https://api.baalda.com")).toBe("wss://api.baalda.com/sync");
  });

  it("appends /sync on the same origin/port for a no-port http host", () => {
    expect(deriveWsUrl("http://myserver")).toBe("ws://myserver/sync");
  });

  it("keeps a custom explicit port and appends /sync", () => {
    expect(deriveWsUrl("http://myserver:8080")).toBe("ws://myserver:8080/sync");
  });

  it("preserves a reverse-proxy path prefix ahead of /sync", () => {
    expect(deriveWsUrl("https://host/baalda")).toBe("wss://host/baalda/sync");
  });

  it("collapses a trailing slash instead of double-slashing /sync", () => {
    expect(deriveWsUrl("https://api.baalda.com/")).toBe("wss://api.baalda.com/sync");
  });

  it("swaps legacy dev port 3010 to the dedicated 3011, no path change", () => {
    expect(deriveWsUrl("http://localhost:3010")).toBe("ws://localhost:3011");
  });

  it("falls back to the local default for unparseable input", () => {
    expect(deriveWsUrl("not a url")).toBe("ws://localhost:3011");
  });
});
