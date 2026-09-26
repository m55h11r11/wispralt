// Opt-in, anonymized telemetry. Gated entirely on `shareAnalytics`.
// Never sends transcripts, audio, API keys, or clipboard text — only an
// anonymous install id, app/OS version, and a short error signature/message.
//
// That promise used to be an assumption: provider failures surface as the raw
// HTTP response body (`Groq API 400 …: {json}`), and a provider can echo parts
// of a request back in it. `sanitizeReport` makes the promise an invariant by
// reducing a provider body to its machine-readable error code and redacting
// credential- and email-shaped text from everything else.
import { invoke } from "@tauri-apps/api/core";
import { getInstallId, hasTauriRuntime, loadSettings, type AppSettings } from "./store";

/** Reports describe a failure; they are not a place for prose. */
const MAX_REPORT_CHARS = 300;

const REDACTIONS: [RegExp, string][] = [
  // Groq (`gsk_`) and OpenAI-style (`sk_`) credentials, wherever they appear.
  [/\b(?:gsk|sk)_[A-Za-z0-9_-]{8,}/g, "[key]"],
  [/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [key]"],
  [/[^\s@]{1,64}@[^\s@]{1,255}\.[A-Za-z]{2,}/g, "[email]"],
];

function redact(text: string): string {
  return REDACTIONS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

/** Pull the provider's own error code out of a JSON error body. */
function providerErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } };
    const code = parsed.error?.code ?? parsed.error?.type;
    return typeof code === "string" ? code.slice(0, 80) : null;
  } catch {
    // Not JSON — an HTML error page or a proxy notice. There is no structured
    // code worth keeping, and its free text is exactly what must not be sent.
    return null;
  }
}

/** Reduce an error message to something safe to transmit. Exported for tests:
 *  this is the boundary the privacy policy depends on. */
export function sanitizeReport(message: string): string {
  const raw = (message ?? "").trim();
  // `Groq API 400 Bad Request: {"error":{"code":"model_decommissioned"}}`
  const provider = /^(.*?)\s(\d{3})\b[^:]*:\s*([\s\S]*)$/.exec(raw);
  if (provider) {
    const [, label, status, body] = provider;
    const code = providerErrorCode(body);
    return redact(`${label} ${status}${code ? ` (${code})` : ""}`).slice(0, MAX_REPORT_CHARS);
  }
  return redact(raw).slice(0, MAX_REPORT_CHARS);
}

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
      message: sanitizeReport(message),
      context: context ? redact(context).slice(0, 400) : null,
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
      // Feedback is deliberate prose and is left intact — except for anything
      // key-shaped, which nobody ever means to send.
      message: redact(message).slice(0, 4000),
      email: email && email.trim() ? email.trim().slice(0, 200) : null,
      rating: rating ?? null,
    });
    return true;
  } catch {
    return false;
  }
}
