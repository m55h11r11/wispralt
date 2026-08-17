import { beforeEach, describe, expect, it } from "vitest";
import {
  clearHistory,
  DEFAULTS,
  getLifetimeCount,
  isRtlText,
  loadHistory,
  loadSettings,
  localDateKey,
  pushHistory,
  resolveActiveTransform,
  saveSettings,
} from "./store";

beforeEach(() => {
  localStorage.clear();
});

describe("loadSettings", () => {
  it("returns defaults on a fresh install", () => {
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("survives corrupt JSON", () => {
    localStorage.setItem("lirrly.settings", "{not json");
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("deep-merges nested objects so schema additions keep defaults", () => {
    localStorage.setItem(
      "lirrly.settings",
      JSON.stringify({ cleanupByCtx: { personal: "high" } })
    );
    const s = loadSettings();
    expect(s.cleanupByCtx.personal).toBe("high");
    expect(s.cleanupByCtx.work).toBe(DEFAULTS.cleanupByCtx.work);
  });

  it("migrates legacy murmur.settings forward", () => {
    localStorage.setItem("murmur.settings", JSON.stringify({ language: "ar" }));
    expect(loadSettings().language).toBe("ar");
    expect(localStorage.getItem("lirrly.settings")).not.toBeNull();
  });

  it("always re-injects current built-in transforms while keeping customs", () => {
    saveSettings({
      ...DEFAULTS,
      transforms: [{ id: "custom1", name: "Mine", prompt: "do it", builtIn: false }],
    });
    const s = loadSettings();
    expect(s.transforms.some((t) => t.id === "custom1")).toBe(true);
    expect(s.transforms.filter((t) => t.builtIn).length).toBeGreaterThanOrEqual(5);
  });

  it("keeps the saved active transform id", () => {
    saveSettings({ ...DEFAULTS, activeTransformId: "summarize" });
    expect(loadSettings().activeTransformId).toBe("summarize");
  });
});

describe("resolveActiveTransform", () => {
  it("resolves the saved transform id", () => {
    expect(resolveActiveTransform({ ...DEFAULTS, activeTransformId: "formal" }).id).toBe("formal");
  });

  it("falls back to the first built-in when the id no longer exists", () => {
    expect(resolveActiveTransform({ ...DEFAULTS, activeTransformId: "custom-deleted" }).id).toBe(
      "rewrite"
    );
  });
});

describe("localDateKey", () => {
  it("formats as local YYYY-MM-DD", () => {
    const d = new Date(2026, 5, 10, 1, 30); // June 10, 01:30 local — UTC key would differ
    expect(localDateKey(d.getTime())).toBe("2026-06-10");
  });
});

describe("isRtlText", () => {
  it("detects Arabic as RTL", () => {
    expect(isRtlText("مرحبا بالعالم")).toBe(true);
  });
  it("treats English as LTR", () => {
    expect(isRtlText("hello world")).toBe(false);
  });
  it("uses the first strong character for mixed text", () => {
    expect(isRtlText("مرحبا hello")).toBe(true);
    expect(isRtlText("hello مرحبا")).toBe(false);
  });
  it("handles punctuation-leading strings", () => {
    expect(isRtlText("«مرحبا»")).toBe(true);
  });
});

describe("history lifetime count", () => {
  it("returns the uncapped lifetime count after history reaches the visible cap", async () => {
    const existing = Array.from({ length: 200 }, (_, i) => ({
      text: `entry ${i}`,
      at: Date.now() - i,
    }));
    localStorage.setItem("lirrly.history", JSON.stringify(existing));
    localStorage.setItem("lirrly.lifetime_count", "499");

    await expect(pushHistory("new entry")).resolves.toBe(500);
    await expect(loadHistory()).resolves.toHaveLength(200);
  });

  it("keeps lifetime progress when visible history is cleared", async () => {
    await pushHistory("first entry");
    await clearHistory();

    await expect(loadHistory()).resolves.toEqual([]);
    await expect(getLifetimeCount()).resolves.toBe(1);
    await expect(pushHistory("second entry")).resolves.toBe(2);
  });

  it("does not let a stale lifetime value go below visible history", async () => {
    localStorage.setItem(
      "lirrly.history",
      JSON.stringify([
        { text: "one", at: 1 },
        { text: "two", at: 2 },
        { text: "three", at: 3 },
      ])
    );
    localStorage.setItem("lirrly.lifetime_count", "1");

    await expect(getLifetimeCount()).resolves.toBe(3);
    await expect(pushHistory("four")).resolves.toBe(4);
  });
});
