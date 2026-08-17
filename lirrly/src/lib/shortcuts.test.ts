import { describe, expect, it } from "vitest";
import { DEFAULT_DICTATION_ACCELERATOR, symbolsToAccelerator } from "./shortcuts";

describe("symbolsToAccelerator", () => {
  it("maps the default dictation combo", () => {
    expect(symbolsToAccelerator(["⌘", "⇧", "D"])).toBe(DEFAULT_DICTATION_ACCELERATOR);
  });

  it("maps every modifier symbol", () => {
    expect(symbolsToAccelerator(["⌘", "⇧", "⌥", "⌃", "K"])).toBe(
      "CommandOrControl+Shift+Alt+Control+K"
    );
  });

  it("uppercases single-character keys", () => {
    expect(symbolsToAccelerator(["⌘", "d"])).toBe("CommandOrControl+D");
  });

  it("aliases arrow keys to accelerator names", () => {
    expect(symbolsToAccelerator(["⌥", "ArrowUp"])).toBe("Alt+Up");
  });

  it("passes through navigation aliases explicitly", () => {
    expect(symbolsToAccelerator(["⌘", "PageUp"])).toBe("CommandOrControl+PageUp");
    expect(symbolsToAccelerator(["⌘", "Home"])).toBe("CommandOrControl+Home");
  });

  it("aliases space to accelerator name", () => {
    expect(symbolsToAccelerator(["⌘", " "])).toBe("CommandOrControl+Space");
  });

  it("passes through function keys", () => {
    expect(symbolsToAccelerator(["F6"])).toBe("F6");
  });

  it("returns null without a main key", () => {
    expect(symbolsToAccelerator(["⌘", "⇧"])).toBeNull();
  });

  it("returns null for empty or missing input", () => {
    expect(symbolsToAccelerator([])).toBeNull();
    expect(symbolsToAccelerator(undefined)).toBeNull();
  });
});
