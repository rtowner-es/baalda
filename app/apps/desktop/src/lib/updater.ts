// App self-update, backed by the Tauri updater plugin.
//
// The plugin pings the `latest.json` endpoint configured in `tauri.conf.json`
// (a static file published on the GitHub release). If it advertises a version
// newer than the running app — and the bundle's minisign signature verifies
// against our embedded public key — we download, install, and relaunch.
//
// This module is a tiny external store so both the launch-time banner and the
// Settings → Updates tab observe one shared check/install lifecycle instead of
// each firing their own network request.
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useSyncExternalStore } from "react";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "available"; version: string; notes?: string; date?: string }
  | { phase: "downloading"; version: string; downloaded: number; total: number }
  | { phase: "installing"; version: string }
  | { phase: "uptodate" }
  | { phase: "error"; message: string };

let pending: Update | null = null;
let state: UpdateState = { phase: "idle" };
const listeners = new Set<() => void>();

function setState(next: UpdateState) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getSnapshot() {
  return state;
}

/** React hook: current update lifecycle state, shared app-wide. */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Ask the endpoint whether a newer version exists. Returns true if one is
 * available (and stashes it for `installUpdate`). Safe to call anywhere — in a
 * non-bundled dev build the updater is unavailable and this resolves to an
 * `error` state rather than throwing.
 */
export async function checkForUpdate(): Promise<boolean> {
  try {
    setState({ phase: "checking" });
    const update = await check();
    if (update) {
      pending = update;
      setState({
        phase: "available",
        version: update.version,
        notes: update.body || undefined,
        date: update.date || undefined,
      });
      return true;
    }
    pending = null;
    setState({ phase: "uptodate" });
    return false;
  } catch (e) {
    setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

/**
 * Download + install the update discovered by `checkForUpdate`, then relaunch
 * into the new version. Progress is reflected in the shared state.
 */
export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update) return;
  let total = 0;
  let downloaded = 0;
  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          downloaded = 0;
          setState({ phase: "downloading", version: update.version, downloaded, total });
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          setState({ phase: "downloading", version: update.version, downloaded, total });
          break;
        case "Finished":
          setState({ phase: "installing", version: update.version });
          break;
      }
    });
    // New bytes are in place; restart into them. On macOS this quits and
    // relaunches; on Windows the installer hands off to the new process.
    await relaunch();
  } catch (e) {
    setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

/** The running app's version (from tauri.conf.json), for display. */
export function currentVersion(): Promise<string> {
  return getVersion();
}
