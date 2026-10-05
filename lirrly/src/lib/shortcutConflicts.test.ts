import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHORTCUT_CONFLICTS_KEY,
  clearShortcutConflict,
  onShortcutConflictsChange,
  readShortcutConflicts,
  writeShortcutConflicts,
} from "./shortcutConflicts";

beforeEach(() => localStorage.clear());

describe("shortcut conflicts (A38)", () => {
  it("is empty when nothing failed", () => {
    expect(readShortcutConflicts()).toEqual([]);
  });

  it("records failed actions in a stable order and clears them one by one", () => {
    writeShortcutConflicts(["transform", "dictation"]);
    expect(readShortcutConflicts()).toEqual(["dictation", "transform"]);
    clearShortcutConflict("dictation");
    expect(readShortcutConflicts()).toEqual(["transform"]);
    clearShortcutConflict("transform");
    expect(localStorage.getItem(SHORTCUT_CONFLICTS_KEY)).toBeNull();
  });

  it("an empty write removes the record", () => {
    writeShortcutConflicts(["dictation"]);
    writeShortcutConflicts([]);
    expect(localStorage.getItem(SHORTCUT_CONFLICTS_KEY)).toBeNull();
  });

  it("ignores damaged or unknown values", () => {
    localStorage.setItem(SHORTCUT_CONFLICTS_KEY, "not json");
    expect(readShortcutConflicts()).toEqual([]);
    localStorage.setItem(SHORTCUT_CONFLICTS_KEY, JSON.stringify({ dictation: true }));
    expect(readShortcutConflicts()).toEqual([]);
    localStorage.setItem(SHORTCUT_CONFLICTS_KEY, JSON.stringify(["scratchpad", "transform"]));
    expect(readShortcutConflicts()).toEqual(["transform"]);
  });

  it("tells subscribers about every change until they unsubscribe", () => {
    const onChange = vi.fn();
    const unsubscribe = onShortcutConflictsChange(onChange);
    writeShortcutConflicts(["dictation", "transform"]);
    clearShortcutConflict("dictation");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(readShortcutConflicts()).toEqual(["transform"]);
    unsubscribe();
    clearShortcutConflict("transform");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("fails open when storage is blocked", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(readShortcutConflicts(broken)).toEqual([]);
    expect(() => writeShortcutConflicts(["dictation"], broken)).not.toThrow();
  });
});
