import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, storeState } = vi.hoisted(() => {
  const storeState: { items: unknown } = { items: undefined };
  return { invokeMock: vi.fn(), storeState };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () =>
    Promise.resolve({
      get: (key: string) => Promise.resolve(key === "items" ? storeState.items : undefined),
      set: () => Promise.resolve(),
      save: () => Promise.resolve(),
    }),
}));

import { clearHistory, deleteHistoryItem, loadHistory, pushHistory } from "./store";

const tauriWindow = window as unknown as Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  storeState.items = undefined;
});

describe("history in the browser preview", () => {
  it("gives legacy entries ids that stay stable across reads", async () => {
    localStorage.setItem(
      "lirrly.history",
      JSON.stringify([
        { text: "same moment", at: 7 },
        { text: "same moment", at: 7 },
      ])
    );
    const first = await loadHistory();
    const second = await loadHistory();
    expect(first.map((it) => it.id)).toEqual(second.map((it) => it.id));
    expect(new Set(first.map((it) => it.id)).size).toBe(2);
  });

  it("deletes exactly one of two entries with identical text and time", async () => {
    localStorage.setItem(
      "lirrly.history",
      JSON.stringify([
        { text: "twin", at: 1 },
        { text: "twin", at: 1 },
      ])
    );
    const [first] = await loadHistory();
    await deleteHistoryItem(first.id);
    await expect(loadHistory()).resolves.toHaveLength(1);
  });

  it("keeps a dictation that landed after the list was loaded", async () => {
    await pushHistory("older");
    const stale = await loadHistory();
    await pushHistory("landed while History was open");
    await deleteHistoryItem(stale[0].id);
    const texts = (await loadHistory()).map((it) => it.text);
    expect(texts).toEqual(["landed while History was open"]);
  });
});

describe("history in the app", () => {
  beforeEach(() => {
    tauriWindow.__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete tauriWindow.__TAURI_INTERNALS__;
  });

  it("reads an up-to-date file directly, without a native write", async () => {
    storeState.items = [{ id: "a", text: "hello", at: 1 }, { corrupt: true }];
    await expect(loadHistory()).resolves.toEqual([{ id: "a", text: "hello", at: 1 }]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("migrates the old localStorage list natively on first read", async () => {
    localStorage.setItem("lirrly.history", JSON.stringify([{ text: "from 0.2", at: 3 }]));
    invokeMock.mockResolvedValueOnce([{ id: "h3-0", text: "from 0.2", at: 3 }]);

    await expect(loadHistory()).resolves.toEqual([{ id: "h3-0", text: "from 0.2", at: 3 }]);
    expect(invokeMock).toHaveBeenCalledWith("history_migrate", {
      legacy: [{ text: "from 0.2", at: 3 }],
    });
    expect(localStorage.getItem("lirrly.history")).toBeNull();
  });

  it("backfills ids natively without re-adopting localStorage", async () => {
    storeState.items = [{ text: "pre-0.4.3", at: 2 }];
    localStorage.setItem("lirrly.history", JSON.stringify([{ text: "stale copy", at: 1 }]));
    invokeMock.mockResolvedValueOnce([{ id: "h2-0", text: "pre-0.4.3", at: 2 }]);

    await loadHistory();
    expect(invokeMock).toHaveBeenCalledWith("history_migrate", { legacy: [] });
  });

  it("sends every change to the native lock — never a whole list", async () => {
    storeState.items = [];
    invokeMock.mockResolvedValue(null);

    await pushHistory("words", 1234, "com.tinyspeck.slackmacgap");
    await deleteHistoryItem("h1-0");
    await clearHistory();

    expect(invokeMock.mock.calls).toEqual([
      [
        "history_push",
        { text: "words", durationMs: 1234, targetApp: "com.tinyspeck.slackmacgap", limit: 200 },
      ],
      ["history_delete", { id: "h1-0" }],
      ["history_clear"],
    ]);
  });

  it("surfaces a failed delete instead of pretending it happened", async () => {
    invokeMock.mockRejectedValueOnce("disk full");
    await expect(deleteHistoryItem("h1-0")).rejects.toBe("disk full");
  });
});
