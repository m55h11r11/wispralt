// In-app updates. Each release ships a `latest.json` signed with our own
// minisign key; Tauri verifies that signature before installing anything, so a
// tampered manifest or archive is rejected even if GitHub itself were swapped.
// Checking is silent, but installing is always user-initiated.
import type { Update as TauriUpdate } from "@tauri-apps/plugin-updater";
import { hasTauriRuntime } from "./store";

export type UpdateInfo = { version: string; notes: string | null };

/** The update found by the last successful check, kept so install() can reuse it. */
let pending: TauriUpdate | null = null;

/**
 * Written when an update has been installed but this process has not restarted
 * (audit A36). The installer moves the running bundle away and deletes it, so
 * until the restart this process runs from a deleted file and macOS refuses
 * every permission check it makes: the microphone and Accessibility paste would
 * fail with errors that point at the wrong fix. localStorage is shared by the
 * app's windows, so the FlowBar sees what the Hub installed.
 */
export const RESTART_PENDING_KEY = "lirrly:update-installed";

export function markUpdateInstalled(
  version: string,
  storage: Storage = localStorage,
  now: number = Date.now()
): void {
  try {
    storage.setItem(RESTART_PENDING_KEY, JSON.stringify({ version, at: now }));
  } catch {
    /* storage unavailable: the Hub's button still says Restart */
  }
}

/**
 * The installed version still waiting for a restart, or null. Only a marker
 * written during this run counts: any restart — into whichever version — runs
 * from the bundle on disk, so an older marker is stale and is removed here.
 * `sessionStart` is when this window was created, which for the FlowBar and
 * the Hub is when the app launched.
 */
export function pendingRestartVersion(
  sessionStart: number = performance.timeOrigin,
  storage: Storage = localStorage
): string | null {
  let raw: string | null;
  try {
    raw = storage.getItem(RESTART_PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let marker: { version?: unknown; at?: unknown } | null;
  try {
    marker = JSON.parse(raw) as { version?: unknown; at?: unknown };
  } catch {
    marker = null;
  }
  const at = typeof marker?.at === "number" ? marker.at : NaN;
  if (typeof marker?.version === "string" && at >= sessionStart) return marker.version;
  try {
    storage.removeItem(RESTART_PENDING_KEY);
  } catch {
    /* nothing to clean up */
  }
  return null;
}

/** Returns the pending update, or null when up to date (or outside Tauri). */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!hasTauriRuntime()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const found = await check();
  pending = found ?? null;
  return found ? { version: found.version, notes: found.body ?? null } : null;
}

/**
 * Downloads and installs the update found by `checkForUpdate`.
 * `onProgress` gets 0-100, or null when the server sends no content length.
 */
export async function installUpdate(
  onProgress?: (percent: number | null) => void
): Promise<void> {
  if (!pending) throw new Error("No update available to install.");
  const update = pending;
  let total = 0;
  let received = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      onProgress?.(total ? 0 : null);
    } else if (event.event === "Progress") {
      received += event.data.chunkLength;
      onProgress?.(total ? Math.min(100, Math.round((received / total) * 100)) : null);
    } else if (event.event === "Finished") {
      onProgress?.(100);
    }
  });
  // Only after the bundle on disk has been replaced: a failed install leaves
  // the running app intact, with nothing to restart for.
  markUpdateInstalled(update.version);
}

/** Relaunch into the freshly installed version. */
export async function restartApp(): Promise<void> {
  if (!hasTauriRuntime()) return;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
