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
  const audio_b64 = base64FromBytes(bytes);
  // Personal-dictionary terms become a recognition hint (Whisper `prompt`).
  const hint = s.dictionary?.length
    ? s.dictionary.map((d) => d.word).slice(0, 60).join(", ")
    : null;
  const raw = await invoke<string>("transcribe", {
    audio_b64,
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
  const deterministic = applyCleanup(raw, level);
  if (level === "none" || level === "light" || !s.cleanupAiEnabled) {
    return deterministic;
  }

  // The key lives in the Keychain (Rust side); a missing key just falls back.
  try {
    const ai = await invoke<string>("cleanup_text", {
      text: deterministic,
      model: s.cleanupModel || "llama-3.1-8b-instant",
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
    model: s.cleanupModel || "llama-3.1-8b-instant",
    language: s.language === "auto" ? null : s.language,
  });
  return out.trim();
}

/**
 * Lightweight, deterministic cleanup — placeholder for the eventual local-LLM
 * layer. Only strips unambiguous fillers so it can't corrupt meaning.
 */
export function applyCleanup(text: string, level: CleanupLevel): string {
  let t = text.trim();
  if (level === "none") return t;
  t = t.replace(/\b(um+|uh+|erm+|uhm+|hmm+)\b[,.]?/gi, "");
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
  // Strip any leading punctuation left behind after filler removal.
  t = t.replace(/^[^\wÀ-ɏ؀-ۿ]+/, "").trim();
  if (t) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

/** Expand snippet triggers (whole-word, case-insensitive) into their text.
 *  Single pass over the input, so one expansion can never re-trigger another. */
export function applySnippets(text: string, snippets: Snippet[]): string {
  const active = (snippets ?? []).filter((sn) => sn.trigger);
  if (!active.length) return text;
  const combined = new RegExp(
    active.map((sn) => `\\b${escapeRegex(sn.trigger)}\\b`).join("|"),
    "gi"
  );
  return text.replace(combined, (match) => {
    const sn = active.find((x) => x.trigger.toLowerCase() === match.toLowerCase());
    return sn?.expansion ?? match;
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
