/** Maps the recorder's display symbols to Tauri global-shortcut accelerators. */
const MODIFIER_MAP: Record<string, string> = {
  "⌘": "CommandOrControl",
  "⇧": "Shift",
  "⌥": "Alt",
  "⌃": "Control",
};

/** Friendly aliases for KeyboardEvent.key names the accelerator parser expects. */
const KEY_ALIAS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  " ": "Space",
  Escape: "Escape",
  Enter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
};

export const DEFAULT_DICTATION_ACCELERATOR = "CommandOrControl+Shift+D";
export const DEFAULT_TRANSFORM_ACCELERATOR = "Alt+T";

/** `["⌘","⇧","D"]` → `"CommandOrControl+Shift+D"`; null when no main key. */
export function symbolsToAccelerator(keys: string[] | undefined): string | null {
  if (!keys?.length) return null;
  const modifiers: string[] = [];
  let mainKey = "";
  for (const k of keys) {
    const mod = MODIFIER_MAP[k];
    if (mod) modifiers.push(mod);
    else mainKey = KEY_ALIAS[k] ?? (k.length === 1 ? k.toUpperCase() : k);
  }
  if (!mainKey) return null;
  return [...modifiers, mainKey].join("+");
}
