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

type ProgressListener = (percent: number | null) => void;

type RunningInstall = {
  promise: Promise<void>;
  percent: number | null;
  listeners: Set<ProgressListener>;
};

/**
 * The install that is running right now, shared by every caller (audit A39).
 * The update card lives in the Hub and forgets its state when it unmounts, so
 * leaving Account and coming back mid-download used to offer "Update now"
 * again — and a second `downloadAndInstall` would race the first over the
 * same bundle swap. Now a second request joins the running one.
 */
let running: RunningInstall | null = null;

/** The running install's last reported progress, or null when none is running. */
export function installInFlight(): { percent: number | null } | null {
  return running ? { percent: running.percent } : null;
}

/**
 * Follows the install that is already running, without ever starting one —
 * for a card remounting mid-download. Null when nothing is running any more
 * (it may have finished in the meantime: see `pendingRestartVersion`).
 */
export function joinInstall(onProgress?: ProgressListener): Promise<void> | null {
  if (!running) return null;
  if (onProgress) {
    running.listeners.add(onProgress);
    onProgress(running.percent);
  }
  return running.promise;
}

/** Stops sending progress to `onProgress` (the card that passed it unmounted). */
export function stopInstallProgress(onProgress: ProgressListener): void {
  running?.listeners.delete(onProgress);
}

/**
 * Downloads and installs the update found by `checkForUpdate`, or joins the
 * install that is already running. `onProgress` gets 0-100, or null when the
 * server sends no content length.
 */
export function installUpdate(onProgress?: ProgressListener): Promise<void> {
  const joined = joinInstall(onProgress);
  if (joined) return joined;
  if (!pending) return Promise.reject(new Error("No update available to install."));
  const update = pending;
  const current: RunningInstall = {
    promise: Promise.resolve(),
    percent: 0,
    listeners: new Set<ProgressListener>(onProgress ? [onProgress] : []),
  };
  const report = (percent: number | null) => {
    current.percent = percent;
    for (const listener of current.listeners) listener(percent);
  };
  current.promise = (async () => {
    try {
      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          report(total ? 0 : null);
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          report(total ? Math.min(100, Math.round((received / total) * 100)) : null);
        } else if (event.event === "Finished") {
          report(100);
        }
      });
      // Only after the bundle on disk has been replaced: a failed install leaves
      // the running app intact, with nothing to restart for.
      markUpdateInstalled(update.version);
    } finally {
      running = null;
    }
  })();
  running = current;
  return current.promise;
}

/** Relaunch into the freshly installed version. */
export async function restartApp(): Promise<void> {
  if (!hasTauriRuntime()) return;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
