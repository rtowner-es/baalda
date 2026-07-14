import type { AppDeps } from "../../src/http/app.js";
import type { DocWriter } from "../../src/mcp/doc-writer.js";

/** A DocWriter that records writes in memory — for tests that don't run sync. */
export function memoryDocWriter(): DocWriter & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async setContent(_vaultId, docId, content) {
      store.set(docId, content);
    },
    async appendContent(_vaultId, docId, text) {
      store.set(docId, (store.get(docId) ?? "") + text);
    },
    async readContent(_vaultId, docId) {
      return store.get(docId) ?? "";
    },
  };
}

/** Default AppDeps for route tests that don't care about sync/MCP writes. */
export function testAppDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    disconnectDoc: () => {},
    docWriter: memoryDocWriter(),
    ...overrides,
  };
}
