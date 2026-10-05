// Global shortcuts another app is holding (audit A38). At launch the Hub
// re-applies both saved bindings; any that fail to register are recorded here
// so the Shortcuts panel can say which one is not working, instead of the
// hotkey silently doing nothing all session. localStorage is shared by the
// app's windows and survives the Hub being closed and reopened.

export const SHORTCUT_CONFLICTS_KEY = "lirrly:shortcut-conflicts";
/** Fired on this window whenever the record changes (other windows get `storage`). */
const CHANGED_EVENT = "lirrly:shortcut-conflicts-changed";

export type ShortcutAction = "dictation" | "transform";

const ACTIONS: readonly ShortcutAction[] = ["dictation", "transform"];

/** The actions whose shortcut failed to register, in a stable order. */
export function readShortcutConflicts(storage: Storage = localStorage): ShortcutAction[] {
  let raw: string | null;
  try {
    raw = storage.getItem(SHORTCUT_CONFLICTS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return ACTIONS.filter((a) => parsed.includes(a));
}

/** Replaces the recorded set; an empty set removes the key. */
export function writeShortcutConflicts(
  actions: readonly ShortcutAction[],
  storage: Storage = localStorage
): void {
  const clean = ACTIONS.filter((a) => actions.includes(a));
  try {
    if (clean.length) storage.setItem(SHORTCUT_CONFLICTS_KEY, JSON.stringify(clean));
    else storage.removeItem(SHORTCUT_CONFLICTS_KEY);
  } catch {
    /* storage unavailable: the panel just won't show the warning */
    return;
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/**
 * Calls `onChange` whenever the record changes — the launch re-registration
 * can finish after the Shortcuts panel opened. Returns the unsubscribe.
 */
export function onShortcutConflictsChange(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === SHORTCUT_CONFLICTS_KEY || e.key === null) onChange();
  };
  window.addEventListener(CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** A binding for `action` registered after all: forget its conflict. */
export function clearShortcutConflict(action: ShortcutAction, storage: Storage = localStorage): void {
  writeShortcutConflicts(
    readShortcutConflicts(storage).filter((a) => a !== action),
    storage
  );
}
