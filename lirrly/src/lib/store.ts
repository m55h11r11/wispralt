import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";

export type CleanupLevel = "none" | "light" | "medium" | "high";
export type CtxKey = "personal" | "work" | "email" | "other";

export const hasTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface Snippet {
  trigger: string;
  expansion: string;
}

export interface DictionaryWord {
  word: string;
  starred: boolean;
  autoLearned: boolean;
  addedAt: number;
}

export interface Transform {
  id: string;
  name: string;
  prompt: string;
  builtIn: boolean;
}

export interface AppSettings {
  provider: string;
  /** Legacy only — the key now lives in the macOS Keychain (Rust `set_api_key`).
   *  Kept so existing localStorage values can be migrated, then blanked. */
  groqApiKey: string;
  model: string;
  cleanupAiEnabled: boolean;
  cleanupModel: string;
  language: string;
  cleanupByCtx: Record<CtxKey, CleanupLevel>;
  /** Style dictations use (audit A19: these settings must actually apply).
   *  Email apps switch to the "email" style automatically — see resolveCtx. */
  activeCtx: CtxKey;
  dictionary: DictionaryWord[];
  snippets: Snippet[];
  transforms: Transform[];
  /** Transform the ⌥T shortcut runs; falls back to the first built-in when stale. */
  activeTransformId: string;
  showFlowBar: boolean;
  launchAtLogin: boolean;
  flowBarOpacity: number;
  selectedMicId: string;
  displayName: string;
  storeHistory: boolean;
  shareAnalytics: boolean;
  notifications: { errors: boolean; milestones: boolean; updates: boolean };
  shortcuts: Record<string, string[]>;
}

const SKEY = "lirrly.settings";
const HKEY = "lirrly.history";
const LEGACY_SKEY = "murmur.settings";
const LEGACY_HKEY = "murmur.history";

function getStoredValue(key: string, legacyKey: string): string | null {
  const current = localStorage.getItem(key);
  if (current !== null) return current;

  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) localStorage.setItem(key, legacy);
  return legacy;
}

/** Transcription languages offered across Settings, FlowBar, and the tray. */
export const LANGS: [string, string][] = [
  ["auto", "Auto-detect"],
  ["en", "English"],
  ["ar", "Arabic (العربية)"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["hi", "Hindi"],
];

const BUILTIN_TRANSFORMS: Transform[] = [
  { id: "rewrite", name: "Rewrite", prompt: "Clean up and clarify the selected text", builtIn: true },
  { id: "summarize", name: "Summarize", prompt: "Condense to the key points", builtIn: true },
  { id: "formal", name: "Make formal", prompt: "Shift tone to professional", builtIn: true },
  { id: "grammar", name: "Fix grammar", prompt: "Correct grammar and spelling only", builtIn: true },
  { id: "translate", name: "Translate", prompt: "Translate to another language", builtIn: true },
];

/** Chat models Groq has retired — settings pointing at one are migrated on load. */
export const RETIRED_CHAT_MODELS = [
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
  "gemma2-9b-it",
];

/** Speech models Groq has withdrawn. A stored setting pointing at one of these
 *  fails every dictation with no way for the user to know why, and until
 *  2026-09-25 only *chat* models were migrated — so the speech setting had no
 *  recovery path at all. `distil-whisper-large-v3-en` was offered in the model
 *  picker and disappeared from `GET /v1/models` between 2026-09-17 and -09-25. */
export const RETIRED_SPEECH_MODELS = ["distil-whisper-large-v3-en"];

export const DEFAULTS: AppSettings = {
  provider: "groq",
  groqApiKey: "",
  model: "whisper-large-v3-turbo",
  cleanupAiEnabled: true,
  cleanupModel: "qwen/qwen3.8-27b",
  language: "auto",
  cleanupByCtx: { personal: "light", work: "medium", email: "medium", other: "light" },
  activeCtx: "personal",
  dictionary: [],
  snippets: [],
  transforms: BUILTIN_TRANSFORMS,
  activeTransformId: "rewrite",
  showFlowBar: true,
  launchAtLogin: false,
  flowBarOpacity: 92,
  selectedMicId: "",
  displayName: "",
  storeHistory: true,
  shareAnalytics: false,
  notifications: { errors: true, milestones: true, updates: true },
  shortcuts: {
    dictation: ["⌘", "⇧", "D"],
    transform: ["⌥", "T"],
    commandMode: [],
    scratchpad: ["⌥", "S"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCleanupLevel(value: unknown): value is CleanupLevel {
  return value === "none" || value === "light" || value === "medium" || value === "high";
}

function isSnippet(value: unknown): value is Snippet {
  return isRecord(value) && typeof value.trigger === "string" && typeof value.expansion === "string";
}

function isDictionaryWord(value: unknown): value is DictionaryWord {
  return (
    isRecord(value) &&
    typeof value.word === "string" &&
    typeof value.starred === "boolean" &&
    typeof value.autoLearned === "boolean" &&
    typeof value.addedAt === "number"
  );
}

function isTransform(value: unknown): value is Transform {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.prompt === "string" &&
    typeof value.builtIn === "boolean"
  );
}

function sanitizeCleanupByCtx(value: unknown): Partial<Record<CtxKey, CleanupLevel>> | undefined {
  if (!isRecord(value)) return undefined;
  const next: Partial<Record<CtxKey, CleanupLevel>> = {};
  for (const key of Object.keys(DEFAULTS.cleanupByCtx) as CtxKey[]) {
    const level = value[key];
    if (isCleanupLevel(level)) next[key] = level;
  }
  return Object.keys(next).length ? next : undefined;
}

function sanitizeNotifications(value: unknown): Partial<AppSettings["notifications"]> | undefined {
  if (!isRecord(value)) return undefined;
  const next: Partial<AppSettings["notifications"]> = {};
  if (typeof value.errors === "boolean") next.errors = value.errors;
  if (typeof value.milestones === "boolean") next.milestones = value.milestones;
  if (typeof value.updates === "boolean") next.updates = value.updates;
  return Object.keys(next).length ? next : undefined;
}

function sanitizeShortcuts(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const next: Record<string, string[]> = {};
  for (const [action, keys] of Object.entries(value)) {
    if (isStringArray(keys)) next[action] = keys;
  }
  return Object.keys(next).length ? next : undefined;
}

function sanitizeSettings(stored: Record<string, unknown>): Partial<AppSettings> {
  const next: Partial<AppSettings> = {};
  if (typeof stored.provider === "string") next.provider = stored.provider;
  if (typeof stored.groqApiKey === "string") next.groqApiKey = stored.groqApiKey;
  if (typeof stored.model === "string") {
    // Same reasoning as cleanupModel below: a retired speech model must not
    // survive an upgrade, or dictation fails for reasons the user cannot see.
    next.model = RETIRED_SPEECH_MODELS.includes(stored.model) ? DEFAULTS.model : stored.model;
  }
  if (typeof stored.cleanupAiEnabled === "boolean") next.cleanupAiEnabled = stored.cleanupAiEnabled;
  if (typeof stored.cleanupModel === "string") {
    // Groq retires models; a setting pointing at a dead one would break cleanup
    // and transforms for existing users, so migrate it to the current default.
    next.cleanupModel = RETIRED_CHAT_MODELS.includes(stored.cleanupModel)
      ? DEFAULTS.cleanupModel
      : stored.cleanupModel;
  }
  if (typeof stored.language === "string") next.language = stored.language;
  if (Array.isArray(stored.dictionary)) next.dictionary = stored.dictionary.filter(isDictionaryWord);
  if (Array.isArray(stored.snippets)) next.snippets = stored.snippets.filter(isSnippet);
  if (typeof stored.activeTransformId === "string") next.activeTransformId = stored.activeTransformId;
  if (typeof stored.showFlowBar === "boolean") next.showFlowBar = stored.showFlowBar;
  if (typeof stored.launchAtLogin === "boolean") next.launchAtLogin = stored.launchAtLogin;
  if (typeof stored.flowBarOpacity === "number") next.flowBarOpacity = stored.flowBarOpacity;
  if (typeof stored.selectedMicId === "string") next.selectedMicId = stored.selectedMicId;
  if (typeof stored.displayName === "string") next.displayName = stored.displayName;
  if (typeof stored.storeHistory === "boolean") next.storeHistory = stored.storeHistory;
  if (typeof stored.shareAnalytics === "boolean") next.shareAnalytics = stored.shareAnalytics;

  const cleanupByCtx = sanitizeCleanupByCtx(stored.cleanupByCtx);
  if (cleanupByCtx) next.cleanupByCtx = { ...DEFAULTS.cleanupByCtx, ...cleanupByCtx };
  if (typeof stored.activeCtx === "string" && stored.activeCtx in DEFAULTS.cleanupByCtx) {
    next.activeCtx = stored.activeCtx as CtxKey;
  }
  const notifications = sanitizeNotifications(stored.notifications);
  if (notifications) next.notifications = { ...DEFAULTS.notifications, ...notifications };
  const shortcuts = sanitizeShortcuts(stored.shortcuts);
  if (shortcuts) next.shortcuts = { ...DEFAULTS.shortcuts, ...shortcuts };

  return next;
}

export function loadSettings(): AppSettings {
  try {
    const stored = parseJsonRecord(getStoredValue(SKEY, LEGACY_SKEY));
    const sanitized = sanitizeSettings(stored);
    // Custom transforms survive; the built-in set always comes from the app so
    // new built-ins appear after updates.
    const storedCustom: Transform[] = Array.isArray(stored.transforms)
      ? stored.transforms.filter(isTransform).filter((t) => !t.builtIn)
      : [];
    // Deep-merge nested objects so a schema change can't corrupt existing config.
    return {
      ...DEFAULTS,
      ...sanitized,
      transforms: [...BUILTIN_TRANSFORMS, ...storedCustom],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(SKEY, JSON.stringify(s));
}

/** Remove the API key from every settings namespace this app has ever written.
 *  Blanking it in the current namespace alone left the pre-rebrand
 *  `murmur.settings` copy holding a readable credential forever, on exactly the
 *  machines that upgraded. Call only once the key is confirmed in the Keychain. */
export function purgeStoredApiKey(): void {
  for (const namespace of [SKEY, LEGACY_SKEY]) {
    const raw = localStorage.getItem(namespace);
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!("groqApiKey" in parsed)) continue;
      delete parsed.groqApiKey;
      localStorage.setItem(namespace, JSON.stringify(parsed));
    } catch {
      // Unparseable: `loadSettings` already discards this blob and falls back to
      // defaults, so it holds no live configuration — only, possibly, a key.
      // Dropping it removes the credential and changes nothing the user sees.
      localStorage.removeItem(namespace);
    }
  }
}

/** A random per-install id, generated once and kept in localStorage. It groups
 *  opt-in crash reports and travels with feedback, so it is *pseudonymous*: it
 *  links those to each other (and to an email typed into feedback), which is
 *  exactly what makes a deletion request satisfiable. Shown in Settings. */
export function getInstallId(): string {
  const KEY = "lirrly.install_id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

/** The transform the ⌥T shortcut runs. A deleted custom id falls back to the
 *  first built-in so the shortcut can never point at nothing. */
export function resolveActiveTransform(s: AppSettings): Transform {
  return (
    s.transforms.find((t) => t.id === s.activeTransformId) ?? s.transforms[0] ?? BUILTIN_TRANSFORMS[0]
  );
}

/** True when the first strongly-directional character is Arabic/Hebrew script —
 *  used to render history rows right-to-left. */
export function isRtlText(t: string): boolean {
  const m = t.match(/[A-Za-z֐-ࣿיִ-﷽ﹰ-ﻼ]/);
  return !!m && /[֐-ࣿיִ-﷽ﹰ-ﻼ]/.test(m[0]);
}

/** Local-timezone YYYY-MM-DD key (toISOString would bucket nights on the wrong day). */
export function localDateKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export interface HistoryItem {
  /** Stable identity, assigned when the entry is written. Entries from before
   *  0.4.3 receive one on their first read (`history_migrate`). */
  id: string;
  text: string;
  at: number;
  /** Recording length — present on items captured after v0.2 (used for real WPM). */
  durationMs?: number;
  app?: string;
  wpm?: number;
  style?: CleanupLevel;
}

/** An entry's shape apart from its id — what pre-0.4.3 installs stored. */
type StoredHistoryItem = Omit<HistoryItem, "id"> & { id?: unknown };

function isUnidentifiedHistoryItem(value: unknown): value is StoredHistoryItem {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.at === "number" &&
    (value.durationMs === undefined || typeof value.durationMs === "number") &&
    (value.app === undefined || typeof value.app === "string") &&
    (value.wpm === undefined || typeof value.wpm === "number") &&
    (value.style === undefined || isCleanupLevel(value.style))
  );
}

function isHistoryItem(value: unknown): value is HistoryItem {
  return isUnidentifiedHistoryItem(value) && typeof value.id === "string";
}

/** Same shape as the native `mint_history_id`: timestamp in hex plus a counter
 *  that skips any id already taken. */
function mintHistoryId(taken: ReadonlySet<string>, at: number): string {
  for (let n = 0; ; n++) {
    const id = `h${Math.max(0, Math.floor(at)).toString(16)}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/* History lives in a Tauri-managed file (appDataDir/history.json) rather than
   WebView localStorage — survives WebView storage resets and stays out of the
   page's reach. Plain-browser previews fall back to localStorage. */
const HISTORY_FILE = "history.json";
const HISTORY_KEY = "items";
const LIFETIME_KEY = "lifetime_count";
const LIFETIME_LOCAL_KEY = "lirrly.lifetime_count";
const HISTORY_MAX = 200;

let historyStore: Promise<Store> | null = null;
function getHistoryStore(): Promise<Store> {
  if (!historyStore) historyStore = load(HISTORY_FILE);
  return historyStore;
}

/** The pre-store localStorage list exactly as saved, minus malformed entries. */
function loadUnidentifiedHistoryLocal(): StoredHistoryItem[] {
  try {
    return parseJsonArray(getStoredValue(HKEY, LEGACY_HKEY)).filter(isUnidentifiedHistoryItem);
  } catch {
    return [];
  }
}

/** Browser-preview history (no Tauri). Missing ids are assigned in list order,
 *  so repeated reads agree until the next local write persists them. */
function loadHistoryLocal(): HistoryItem[] {
  const items = loadUnidentifiedHistoryLocal();
  const taken = new Set(items.flatMap((it) => (typeof it.id === "string" ? [it.id] : [])));
  return items.map((it) => {
    if (typeof it.id === "string") return it as HistoryItem;
    const id = mintHistoryId(taken, it.at);
    taken.add(id);
    return { ...it, id };
  });
}

function writeHistoryLocal(items: HistoryItem[]): void {
  localStorage.setItem(HKEY, JSON.stringify(items));
}

function normalizeCount(value: unknown, fallback: number): number {
  const count = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : fallback;
}

function getLifetimeCountLocal(fallback: number): number {
  return normalizeCount(localStorage.getItem(LIFETIME_LOCAL_KEY), fallback);
}

function setLifetimeCountLocal(count: number): void {
  localStorage.setItem(LIFETIME_LOCAL_KEY, String(count));
}

async function readLifetimeCount(fallback: number): Promise<number> {
  const localCount = getLifetimeCountLocal(fallback);
  if (!hasTauriRuntime()) return Math.max(localCount, fallback);
  try {
    const store = await getHistoryStore();
    const existing = await store.get<number>(LIFETIME_KEY);
    const storeCount = normalizeCount(existing, fallback);
    const count = Math.max(storeCount, localCount, fallback);
    if (count !== localCount) setLifetimeCountLocal(count);
    if (count !== storeCount) {
      await store.set(LIFETIME_KEY, count);
      await store.save();
    }
    return count;
  } catch {
    return Math.max(localCount, fallback);
  }
}

async function writeLifetimeCount(count: number): Promise<void> {
  setLifetimeCountLocal(count);
  if (!hasTauriRuntime()) {
    return;
  }
  try {
    const store = await getHistoryStore();
    await store.set(LIFETIME_KEY, count);
    await store.save();
  } catch {
    // Local fallback was already written above.
  }
}

/* Reading happens here; every change goes through a native `history_*` command
   that holds one lock across read, modify and save. The Hub and the FlowBar are
   separate webviews, so no lock on this side could keep a delete computed from
   an old copy from overwriting a dictation the other window just added (A04). */
export async function loadHistory(): Promise<HistoryItem[]> {
  if (!hasTauriRuntime()) return loadHistoryLocal();
  try {
    const store = await getHistoryStore();
    const existing = await store.get<unknown>(HISTORY_KEY);
    const needsIds = (list: unknown[]) =>
      list.some((it) => isUnidentifiedHistoryItem(it) && typeof it.id !== "string");
    if (Array.isArray(existing) && !needsIds(existing)) {
      // Malformed entries are skipped, not "repaired" by a write on every read.
      return existing.filter(isHistoryItem);
    }
    // First read after upgrading: adopt the old localStorage list if the file
    // has none, and give entries without an id one. Idempotent natively.
    const migrated = await invoke<unknown[]>("history_migrate", {
      legacy: existing == null ? loadUnidentifiedHistoryLocal() : [],
    });
    if (existing == null) {
      localStorage.removeItem(HKEY);
      localStorage.removeItem(LEGACY_HKEY);
    }
    return migrated.filter(isHistoryItem);
  } catch {
    return loadHistoryLocal();
  }
}

/** Delete one entry by id. Throws when the change could not be saved, so the
 *  UI can say so instead of showing a deletion that did not happen. */
export async function deleteHistoryItem(id: string): Promise<void> {
  if (!hasTauriRuntime()) {
    writeHistoryLocal(loadHistoryLocal().filter((it) => it.id !== id));
    return;
  }
  await invoke<boolean>("history_delete", { id });
}

export async function getLifetimeCount(): Promise<number> {
  const fallback = (await loadHistory()).length;
  return readLifetimeCount(fallback);
}

/** Returns the new dictation count so callers can celebrate milestones.
 *  `app` is the bundle id the dictation was meant for, when known.
 *  Throws when the entry could not be saved. */
export async function pushHistory(text: string, durationMs?: number, app?: string | null): Promise<number> {
  const items = await loadHistory();
  const lifetimeCount = (await readLifetimeCount(items.length)) + 1;
  if (hasTauriRuntime()) {
    await invoke("history_push", {
      text,
      durationMs: durationMs ?? null,
      targetApp: app ?? null,
      limit: HISTORY_MAX,
    });
  } else {
    const current = loadHistoryLocal();
    const at = Date.now();
    const id = mintHistoryId(new Set(current.map((it) => it.id)), at);
    const entry: HistoryItem = { id, text, at, ...(durationMs ? { durationMs } : {}), ...(app ? { app } : {}) };
    writeHistoryLocal([entry, ...current].slice(0, HISTORY_MAX));
  }
  await writeLifetimeCount(lifetimeCount);
  return lifetimeCount;
}

export async function clearHistory(): Promise<void> {
  if (!hasTauriRuntime()) {
    writeHistoryLocal([]);
    return;
  }
  await invoke("history_clear");
}
