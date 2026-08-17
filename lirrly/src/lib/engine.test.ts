import { describe, expect, it } from "vitest";
import { applyCleanup, applySnippets } from "./engine";
import type { Snippet } from "./store";

describe("applyCleanup", () => {
  it("returns trimmed text unchanged at level none", () => {
    expect(applyCleanup("  um hello there  ", "none")).toBe("um hello there");
  });

  it("strips filler words and tidies spacing", () => {
    expect(applyCleanup("um hello uh there, erm friend", "light")).toBe(
      "Hello there, friend"
    );
  });

  it("capitalizes the first letter after cleanup", () => {
    expect(applyCleanup("uh, ok then", "light")).toBe("Ok then");
  });

  it("collapses doubled spaces and space-before-punctuation", () => {
    expect(applyCleanup("hello  world , again", "light")).toBe("Hello world, again");
  });

  it("keeps Arabic text intact while stripping latin fillers", () => {
    expect(applyCleanup("um مرحبا بالعالم", "light")).toBe("مرحبا بالعالم");
  });

  it("returns empty string for filler-only input", () => {
    expect(applyCleanup("um uh hmm", "light")).toBe("");
  });
});

describe("applySnippets", () => {
  const snippets: Snippet[] = [
    { trigger: "my email", expansion: "me@example.com" },
    { trigger: "sig", expansion: "Best,\nM" },
  ];

  it("expands a whole-word trigger case-insensitively", () => {
    expect(applySnippets("Send it to My Email please", snippets)).toBe(
      "Send it to me@example.com please"
    );
  });

  it("does not expand partial-word matches", () => {
    expect(applySnippets("signature stays", snippets)).toBe("signature stays");
  });

  it("is single-pass: an expansion can never re-trigger another snippet", () => {
    const chaining: Snippet[] = [
      { trigger: "alpha", expansion: "beta" },
      { trigger: "beta", expansion: "gamma" },
    ];
    expect(applySnippets("alpha and beta", chaining)).toBe("beta and gamma");
  });

  it("escapes regex metacharacters in triggers", () => {
    const tricky: Snippet[] = [{ trigger: "c++", expansion: "cpp" }];
    // \b after + doesn't match a word boundary the usual way; the call must not throw.
    expect(() => applySnippets("i write c++ daily", tricky)).not.toThrow();
  });

  it("returns input unchanged with no snippets", () => {
    expect(applySnippets("hello", [])).toBe("hello");
  });

  it("ignores snippets with empty triggers", () => {
    expect(applySnippets("hello", [{ trigger: "", expansion: "x" }])).toBe("hello");
  });
});
