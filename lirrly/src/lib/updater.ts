// In-app updates. Each release ships a `latest.json` signed with our own
// minisign key; Tauri verifies that signature before installing anything, so a
// tampered manifest or archive is rejected even if GitHub itself were swapped.
// Checking is silent, but installing is always user-initiated.
import type { Update as TauriUpdate } from "@tauri-apps/plugin-updater";
import { hasTauriRuntime } from "./store";

export type UpdateInfo = { version: string; notes: string | null };

/** The update found by the last successful check, kept so install() can reuse it. */
let pending: TauriUpdate | null = null;

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
  let total = 0;
  let received = 0;
  await pending.downloadAndInstall((event) => {
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
}

/** Relaunch into the freshly installed version. */
export async function restartApp(): Promise<void> {
  if (!hasTauriRuntime()) return;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
