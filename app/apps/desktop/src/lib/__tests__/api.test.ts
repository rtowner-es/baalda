import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Build a fake `fetch` that records calls and returns scripted responses. */
function fakeFetch(
  script: (call: Call) => { status?: number; json?: unknown; headers?: Record<string, string> },
) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call: Call = { url, method: init?.method ?? "GET", headers, body };
    calls.push(call);
    const r = script(call);
    const status = r.status ?? 200;
    const text = r.json !== undefined ? JSON.stringify(r.json) : "";
    const respHeaders = new Map(Object.entries(r.headers ?? {}));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => respHeaders.get(k) ?? null },
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("ApiClient against a mocked fetch", () => {
  it("captures the set-auth-token header on sign-in and sends it as Bearer", async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/api/auth/sign-in/email")) {
        return {
          json: { user: { id: "u1", email: "a@b.co", name: "Ada" } },
          headers: { "set-auth-token": "sess-xyz" },
        };
      }
      if (call.url.endsWith("/api/auth/get-session")) {
        return { json: { user: { id: "u1", email: "a@b.co", name: "Ada" }, session: { activeOrganizationId: "org1" } } };
      }
      return { json: {} };
    });

    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: impl });
    const { token } = await api.signIn({ email: "a@b.co", password: "pw" });
    expect(token).toBe("sess-xyz");
    expect(api.getToken()).toBe("sess-xyz");

    const session = await api.getSession();
    expect(session?.user.id).toBe("u1");
    expect(session?.activeOrganizationId).toBe("org1");

    // The get-session call must carry the bearer token.
    const sessionCall = calls.find((c) => c.url.endsWith("/api/auth/get-session"))!;
    expect(sessionCall.headers.Authorization).toBe("Bearer sess-xyz");
  });

  it("throws ApiError with the HTTP status on failure (403 sync-token)", async () => {
    const { impl } = fakeFetch(() => ({ status: 403, json: { error: "No access" } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    await expect(api.syncToken("doc1")).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
    });
  });

  it("getSession returns null on 401 instead of throwing", async () => {
    const { impl } = fakeFetch(() => ({ status: 401, json: { error: "unauthenticated" } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "stale", fetchImpl: impl });
    expect(await api.getSession()).toBeNull();
  });

  it("getSession returns null when there is no token (no fetch)", async () => {
    const spy = vi.fn();
    const api = new ApiClient({ baseUrl: "http://localhost:3010", fetchImpl: spy as unknown as typeof fetch });
    expect(await api.getSession()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("mints a sync token and returns readOnly/permission", async () => {
    const { impl, calls } = fakeFetch((call) => {
      expect(call.url).toContain("/api/sync-token");
      return { json: { token: "jwt", docId: "d1", vaultId: "v1", readOnly: true, permission: "view" } };
    });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    const res = await api.syncToken("d1");
    expect(res).toEqual({ token: "jwt", docId: "d1", vaultId: "v1", readOnly: true, permission: "view" });
    expect(calls[0].body).toEqual({ docId: "d1" });
  });

  it("normalizes list responses (vaults/notes/shares)", async () => {
    const { impl } = fakeFetch((call) => {
      if (call.url.includes("/api/vaults")) return { json: { vaults: [{ id: "v1", name: "V" }] } };
      if (call.url.includes("/api/notes")) return { json: { notes: [{ id: "n1", rel_path: "a.md", title: "A" }] } };
      return { json: {} };
    });
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    expect(await api.listVaults()).toHaveLength(1);
    const notes = await api.listNotes("v1");
    expect(notes[0].id).toBe("n1");
  });

  it("base URL trailing slashes are stripped so paths don't double up", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { vaults: [] } }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010/", token: "t", fetchImpl: impl });
    await api.listVaults();
    expect(calls[0].url).toBe("http://localhost:3010/api/vaults");
  });

  it("surfaces ApiError even when the error body is empty", async () => {
    const { impl } = fakeFetch(() => ({ status: 500 }));
    const api = new ApiClient({ baseUrl: "http://localhost:3010", token: "t", fetchImpl: impl });
    await expect(api.listVaults()).rejects.toBeInstanceOf(ApiError);
  });
});
