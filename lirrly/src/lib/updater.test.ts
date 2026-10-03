import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { checkMock } = vi.hoisted(() => ({ checkMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));

import {
  RESTART_PENDING_KEY,
  checkForUpdate,
  installUpdate,
  markUpdateInstalled,
  pendingRestartVersion,
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
  });
});
