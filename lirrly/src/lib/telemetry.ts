// Opt-in, anonymized telemetry. Gated entirely on `shareAnalytics`.
// Never sends transcripts, audio, API keys, or clipboard text — only an
// anonymous install id, app/OS version, and a short error signature/message.
import { invoke } from "@tauri-apps/api/core";
import { getInstallId, hasTauriRuntime, loadSettings, type AppSettings } from "./store";

/** Report a handled error/crash. Fire-and-forget; never throws, never blocks UX. */
export function reportError(
  signature: string,
  message: string,
  s?: AppSettings,
  context?: string
): void {
  try {
    const settings = s ?? loadSettings();
    if (!settings.shareAnalytics || !hasTauriRuntime()) return;
    void invoke("report_event", {
      enabled: true,
      installId: getInstallId(),
      kind: "error",
      signature: signature.slice(0, 200),
      message: (message || "").slice(0, 2000),
      context: context ? context.slice(0, 400) : null,
    }).catch(() => {});
  } catch {
    /* telemetry must never disrupt the app */
  }
}

/** User-initiated feedback. Returns true on success so the UI can confirm. */
export async function sendFeedback(
  message: string,
  email?: string,
  rating?: number
): Promise<boolean> {
  if (!hasTauriRuntime()) return false;
  try {
    await invoke("send_feedback", {
      installId: getInstallId(),
      message: message.slice(0, 4000),
      email: email && email.trim() ? email.trim().slice(0, 200) : null,
      rating: rating ?? null,
    });
    return true;
  } catch {
    return false;
  }
}
