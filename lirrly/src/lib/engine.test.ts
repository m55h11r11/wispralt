import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snippet } from "./store";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { applyCleanup, applySnippets, transcribe } from "./engine";
import { DEFAULTS } from "./store";

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

  it("escapes regex metacharacters in triggers and still expands them", () => {
    const tricky: Snippet[] = [{ trigger: "c++", expansion: "cpp" }];
    expect(applySnippets("i write c++ daily", tricky)).toBe("i write cpp daily");
  });

  // A17: `\b` is ASCII-only, so an Arabic trigger could never match — the
  // required word boundary simply does not exist between two Arabic letters.
  it("expands an Arabic trigger", () => {
    const arabic: Snippet[] = [{ trigger: "ايميلي", expansion: "me@example.com" }];
    expect(applySnippets("ابعت على ايميلي بسرعة", arabic)).toBe(
      "ابعت على me@example.com بسرعة"
    );
  });

  it("still refuses to expand an Arabic trigger inside a longer word", () => {
    const arabic: Snippet[] = [{ trigger: "ايميل", expansion: "X" }];
    expect(applySnippets("ايميلي", arabic)).toBe("ايميلي");
  });

  it("expands a trigger at the very start and end of the text", () => {
    const s2: Snippet[] = [{ trigger: "sig", expansion: "Best, M" }];
    expect(applySnippets("sig", s2)).toBe("Best, M");
    expect(applySnippets("ends with sig", s2)).toBe("ends with Best, M");
  });

  it("returns input unchanged with no snippets", () => {
    expect(applySnippets("hello", [])).toBe("hello");
  });

  it("ignores snippets with empty triggers", () => {
    expect(applySnippets("hello", [{ trigger: "", expansion: "x" }])).toBe("hello");
  });
});

// A05: the old leading-character strip kept only ASCII, Latin-1 and Arabic,
// deleting everything else — including Hindi, which the app offers in Settings.
describe("applyCleanup does not destroy content", () => {
  it("keeps Devanagari, an offered transcription language", () => {
    expect(applyCleanup("नमस्ते दुनिया", "light")).toBe("नमस्ते दुनिया");
  });

  it("keeps Han script", () => {
    expect(applyCleanup("你好世界", "light")).toBe("你好世界");
  });

  it("preserves a leading minus sign instead of inverting the number", () => {
    expect(applyCleanup("-5 degrees", "light")).toBe("-5 degrees");
  });

  it("preserves a leading emoji", () => {
    expect(applyCleanup("🙂 hello", "light")).toBe("🙂 hello");
  });

  it("still drops separators the filler pass stranded at the front", () => {
    expect(applyCleanup("um, hello", "light")).toBe("Hello");
  });

  it("leaves German 'um' alone when the language is German", () => {
    expect(applyCleanup("um 5 Uhr treffen", "light", "de")).toBe("Um 5 Uhr treffen");
  });

  it("still strips fillers for English and for auto-detect", () => {
    expect(applyCleanup("um hello", "light", "en")).toBe("Hello");
    expect(applyCleanup("um hello", "light", null)).toBe("Hello");
  });
});

// A01: helper-level tests cannot see the IPC serialization boundary, which is
// where full-app dictation was actually broken. This asserts the wire keys.
describe("transcribe IPC contract", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("hello world");
  });

  const blob = {
    type: "audio/webm",
    arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
  } as unknown as Blob;

  it("sends the audio under the key the Rust command actually reads", async () => {
    await transcribe(blob, DEFAULTS);
    const [command, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("transcribe");
    // `#[tauri::command]` defaults to rename_all = "camelCase", so Rust's
    // `audio_b64` parameter is read from the payload key `audioB64`. Tauri
    // matches keys exactly — snake_case fails with "missing required key".
    expect(args).toHaveProperty("audioB64");
    expect(args).not.toHaveProperty("audio_b64");
    expect(typeof args.audioB64).toBe("string");
  });

  it("sends every argument the Rust signature requires", async () => {
    await transcribe(blob, DEFAULTS);
    const [, args] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(args).sort()).toEqual(
      ["audioB64", "language", "mime", "model", "prompt"].sort()
    );
  });
});
