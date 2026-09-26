import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, CleanupLevel, CtxKey, Snippet, Transform } from "./store";

/**
 * Transcribe an audio clip. Routes to Groq Whisper via the Rust backend, biases
 * recognition with the personal dictionary, cleans the text, then expands snippets.
 * Engine-agnostic on purpose — a local engine can slot in behind this later.
 * `ctx` selects the per-context style; frontmost-app detection can feed it later.
 */
export async function transcribe(blob: Blob, s: AppSettings, ctx: CtxKey = "personal"): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const audioB64 = base64FromBytes(bytes);
  // Personal-dictionary terms become a recognition hint (Whisper `prompt`).
  const hint = s.dictionary?.length
    ? s.dictionary.map((d) => d.word).slice(0, 60).join(", ")
    : null;
  const raw = await invoke<string>("transcribe", {
    // `audioB64`, not `audio_b64`: `#[tauri::command]` defaults to
    // rename_all = "camelCase", so Rust's `audio_b64` parameter is read from
    // this exact key. A mismatch fails the whole call with
    // "missing required key audioB64" before the Keychain is ever touched.
    audioB64,
    mime: blob.type || "audio/webm",
    model: s.model,
    language: s.language === "auto" ? null : s.language,
    prompt: hint,
  });
  const level = s.cleanupByCtx?.[ctx] ?? "light";
  const cleaned = await polishTranscript(raw, level, s, ctx);
  return applySnippets(cleaned, s.snippets);
}

async function polishTranscript(
  raw: string,
  level: CleanupLevel,
  s: AppSettings,
  ctx: CtxKey
): Promise<string> {
  const deterministic = applyCleanup(raw, level, s.language === "auto" ? null : s.language);
  if (level === "none" || level === "light" || !s.cleanupAiEnabled) {
    return deterministic;
  }

  // The key lives in the Keychain (Rust side); a missing key just falls back.
  try {
    const ai = await invoke<string>("cleanup_text", {
      text: deterministic,
      model: s.cleanupModel || "qwen/qwen3.8-27b",
      level,
      language: s.language === "auto" ? null : s.language,
      context: ctx,
    });
    return ai.trim() || deterministic;
  } catch {
    return deterministic;
  }
}

/**
 * Run a transform instruction over text (⌥T on a selection, History ✨).
 * Same Groq chat layer as cleanup, but the instruction comes from the user's
 * transform library. Errors propagate — callers map them to actionable toasts.
 */
export async function transformText(text: string, transform: Transform, s: AppSettings): Promise<string> {
  const out = await invoke<string>("transform_text", {
    text,
    prompt: transform.prompt,
    model: s.cleanupModel || "qwen/qwen3.8-27b",
    language: s.language === "auto" ? null : s.language,
  });
  return out.trim();
}

/** Stray separators the filler pass can strand at the front of a sentence.
 *  Deliberately NOT a "everything that isn't a letter" class: a leading minus
 *  sign, quote, bracket, currency symbol or emoji is content, not noise. */
const LEADING_SEPARATORS = /^[\s,.;:!?…،؛۔]+/u;

/** Fillers are English tokens. `um` is also an ordinary German word, `hmm`
 *  appears in several languages — so only strip them when the transcript is
 *  English or the language is unknown (auto-detect). */
const ENGLISH_FILLERS = /\b(um+|uh+|erm+|uhm+|hmm+)\b[,.]?/gi;

/**
 * Lightweight, deterministic cleanup — placeholder for the eventual local-LLM
 * layer. Only strips unambiguous fillers so it can't corrupt meaning.
 * `lang` is the configured transcription language, or null for auto-detect.
 */
export function applyCleanup(text: string, level: CleanupLevel, lang: string | null = null): string {
  let t = text.trim();
  if (level === "none") return t;
  if (lang === null || lang.startsWith("en")) t = t.replace(ENGLISH_FILLERS, "");
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
  t = t.replace(LEADING_SEPARATORS, "").trim();
  // Only a lowercase letter can be capitalized. Guarding on it keeps
  // caseless scripts and leading symbols byte-identical.
  if (/^\p{Ll}/u.test(t)) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

/** Expand snippet triggers (whole-word, case-insensitive) into their text.
 *  Single pass over the input, so one expansion can never re-trigger another.
 *
 *  Boundaries are Unicode-aware rather than `\b`, which is ASCII-only: with
 *  `\b` an Arabic trigger could never match (Arabic letters are not ASCII word
 *  characters, so the required boundary never existed) and neither could a
 *  trigger ending in punctuation such as `C++`. The preceding character is
 *  captured and re-emitted instead of using lookbehind, which the WebKit on
 *  macOS 12 — our stated minimum — does not support. */
export function applySnippets(text: string, snippets: Snippet[]): string {
  const active = (snippets ?? []).filter((sn) => sn.trigger);
  if (!active.length) return text;
  const alternation = active.map((sn) => escapeRegex(sn.trigger)).join("|");
  const combined = new RegExp(
    `(^|[^\\p{L}\\p{N}_])(${alternation})(?![\\p{L}\\p{N}_])`,
    "giu"
  );
  return text.replace(combined, (_match, before: string, trigger: string) => {
    const sn = active.find((x) => x.trigger.toLowerCase() === trigger.toLowerCase());
    return before + (sn?.expansion ?? trigger);
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
