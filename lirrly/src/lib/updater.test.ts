import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkMock } = vi.hoisted(() => ({ checkMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));

import {
  RESTART_PENDING_KEY,
  checkForUpdate,
  installInFlight,
  installUpdate,
  joinInstall,
  markUpdateInstalled,
  pendingRestartVersion,
  stopInstallProgress,
} from "./updater";

const tauriWindow = window as unknown as Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  checkMock.mockReset();
});

describe("restart after an installed update (A36)", () => {
  it("is not pending when nothing was installed", () => {
    expect(pendingRestartVersion(1_000)).toBeNull();
  });

  it("is pending for an update installed during this run", () => {
    markUpdateInstalled("0.4.3", localStorage, 2_000);
    expect(pendingRestartVersion(1_000)).toBe("0.4.3");
    // Asking again does not consume it: every new take is refused until the restart.
    expect(pendingRestartVersion(1_000)).toBe("0.4.3");
  });

  it("clears a marker left by an earlier run, whatever version is running now", () => {
    markUpdateInstalled("0.4.3", localStorage, 2_000);
    expect(pendingRestartVersion(5_000)).toBeNull();
    expect(localStorage.getItem(RESTART_PENDING_KEY)).toBeNull();
  });

  it("treats a damaged marker as stale instead of blocking dictation", () => {
    localStorage.setItem(RESTART_PENDING_KEY, "not json");
    expect(pendingRestartVersion(1_000)).toBeNull();
    expect(localStorage.getItem(RESTART_PENDING_KEY)).toBeNull();

    localStorage.setItem(RESTART_PENDING_KEY, JSON.stringify({ at: 2_000 }));
    expect(pendingRestartVersion(1_000)).toBeNull();

    localStorage.setItem(RESTART_PENDING_KEY, JSON.stringify({ version: "0.4.3", at: "soon" }));
    expect(pendingRestartVersion(1_000)).toBeNull();
  });

  it("fails open when storage cannot be read", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(pendingRestartVersion(1_000, broken)).toBeNull();
  });
});

describe("installUpdate", () => {
  beforeEach(() => {
    tauriWindow.__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete tauriWindow.__TAURI_INTERNALS__;
  });

  it("marks the restart only once the new bundle is installed", async () => {
    let finish: (() => void) | undefined;
    checkMock.mockResolvedValue({
      version: "0.4.3",
      body: null,
      downloadAndInstall: () =>
        new Promise<void>((resolve) => {
          finish = () => resolve();
        }),
    });
    await checkForUpdate();
    const installing = installUpdate();
    await Promise.resolve();
    // Downloading or swapping the bundle: the running app is still intact.
    expect(pendingRestartVersion(0)).toBeNull();
    finish?.();
    await installing;
    expect(pendingRestartVersion(0)).toBe("0.4.3");
  });

  it("leaves no marker when the install fails", async () => {
    checkMock.mockResolvedValue({
      version: "0.4.3",
      body: null,
      downloadAndInstall: () => Promise.reject(new Error("signature mismatch")),
    });
    await checkForUpdate();
    await expect(installUpdate()).rejects.toThrow("signature mismatch");
    expect(pendingRestartVersion(0)).toBeNull();
    expect(installInFlight()).toBeNull();
  });

  it("joins a running install instead of starting a second one (A39)", async () => {
    let finish: (() => void) | undefined;
    let progress: ((event: unknown) => void) | undefined;
    const downloadAndInstall = vi.fn(
      (onEvent: (event: unknown) => void) =>
        new Promise<void>((resolve) => {
          progress = onEvent;
          finish = () => resolve();
        })
    );
    checkMock.mockResolvedValue({ version: "0.4.4", body: null, downloadAndInstall });
    await checkForUpdate();

    const first = installUpdate();
    progress?.({ event: "Started", data: { contentLength: 200 } });
    progress?.({ event: "Progress", data: { chunkLength: 50 } });
    expect(installInFlight()).toEqual({ percent: 25 });

    // A remounted update card asks again mid-download: it must join, not restart.
    const seen: (number | null)[] = [];
    const second = installUpdate((p) => seen.push(p));
    expect(seen).toEqual([25]);
    // The quiet check of a remounted card may find the same update again.
    await checkForUpdate();
    expect(installUpdate()).toBe(first);

    progress?.({ event: "Progress", data: { chunkLength: 150 } });
    finish?.();
    await Promise.all([first, second]);
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([25, 100]);
    expect(installInFlight()).toBeNull();
    expect(pendingRestartVersion(0)).toBe("0.4.4");
  });

  it("a remounted card only follows a running install, and can stop listening (A39)", async () => {
    let finish: (() => void) | undefined;
    let progress: ((event: unknown) => void) | undefined;
    const downloadAndInstall = vi.fn(
      (onEvent: (event: unknown) => void) =>
        new Promise<void>((resolve) => {
          progress = onEvent;
          finish = () => resolve();
        })
    );
    checkMock.mockResolvedValue({ version: "0.4.4", body: null, downloadAndInstall });
    await checkForUpdate();

    // Nothing running yet: joining never starts a download of the pending update.
    expect(joinInstall(() => undefined)).toBeNull();
    expect(downloadAndInstall).not.toHaveBeenCalled();

    const first = installUpdate();
    progress?.({ event: "Started", data: { contentLength: 100 } });
    const seen: (number | null)[] = [];
    const listener = (p: number | null) => seen.push(p);
    expect(joinInstall(listener)).toBe(first);
    progress?.({ event: "Progress", data: { chunkLength: 40 } });
    // The card unmounted: no more progress reaches it.
    stopInstallProgress(listener);
    progress?.({ event: "Progress", data: { chunkLength: 60 } });
    finish?.();
    await first;
    expect(seen).toEqual([0, 40]);

    // Finished between the card's first render and its effect: nothing to join,
    // and the restart marker tells the card what happened.
    expect(joinInstall(listener)).toBeNull();
    expect(pendingRestartVersion(0)).toBe("0.4.4");
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  it("rejects without an update to install", async () => {
    checkMock.mockResolvedValue(null);
    await checkForUpdate();
    await expect(installUpdate()).rejects.toThrow("No update available");
  });
});
