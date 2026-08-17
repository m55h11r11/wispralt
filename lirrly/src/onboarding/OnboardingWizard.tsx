import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hasTauriRuntime, loadSettings } from "../lib/store";
import { WaveMark } from "../settings/Logo";
import "./onboarding.css";

type Step = 0 | 1 | 2 | 3 | 4;
type PermStatus = "granted" | "denied" | "unknown";
type KeyStatus = "none" | "checking" | "valid" | "invalid" | "verify_error" | "save_error";

const STEPS = 5;

export default function OnboardingWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>(0);
  const next = () => setStep((s) => Math.min(STEPS - 1, s + 1) as Step);

  return (
    <div className="onboarding">
      <div className="ob-dots" aria-hidden="true">
        {Array.from({ length: STEPS }, (_, i) => (
          <span key={i} className={`ob-dot ${i === step ? "current" : i < step ? "done" : ""}`} />
        ))}
      </div>

      {step === 0 && <Welcome onNext={next} onSkip={onDone} />}
      {step === 1 && <Permissions onNext={next} />}
      {step === 2 && <EngineSetup onNext={next} />}
      {step === 3 && <FirstDictation onNext={next} />}
      {step === 4 && <Done onFinish={onDone} />}
    </div>
  );
}

/* ---------- Step 0 — Welcome ---------- */
function Welcome({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div className="ob-step ob-center">
      <div className="ob-mark">
        <WaveMark />
      </div>
      <h1 className="ob-title">Lirrly</h1>
      <p className="ob-lede">
        Speak. Your words, clean and pasted.
        <br />
        Free, open-source dictation for macOS — no account, no cloud storage.
      </p>
      <div className="ob-actions">
        <button className="btn primary" onClick={onNext}>
          Get started →
        </button>
        <button className="btn" onClick={onSkip}>
          Skip setup
        </button>
      </div>
    </div>
  );
}

/* ---------- Step 1 — Permissions ---------- */
function Permissions({ onNext }: { onNext: () => void }) {
  const [mic, setMic] = useState<PermStatus>("unknown");
  const [ax, setAx] = useState<PermStatus>("unknown");

  async function checkMic() {
    try {
      const res = await navigator.permissions.query({ name: "microphone" });
      setMic(res.state === "granted" ? "granted" : res.state === "denied" ? "denied" : "unknown");
    } catch {
      setMic("unknown"); // WebKit without the query API — first dictation will prompt
    }
  }
  async function checkAx() {
    if (!hasTauriRuntime()) return; // browser preview — stays "unknown"
    try {
      setAx((await invoke<boolean>("check_accessibility")) ? "granted" : "denied");
    } catch {
      setAx("unknown");
    }
  }
  useEffect(() => {
    // Deferred a tick: status arrives from the OS, never synchronously.
    const t = window.setTimeout(() => {
      void checkMic();
      void checkAx();
    }, 0);
    return () => window.clearTimeout(t);
     
  }, []);

  async function requestAx() {
    if (!hasTauriRuntime()) return;
    try {
      await invoke<boolean>("request_accessibility");
    } catch {
      /* the System Settings path below still works */
    }
    // The grant happens in System Settings — poll once shortly after.
    window.setTimeout(() => void checkAx(), 1500);
  }

  const badge = (status: PermStatus) =>
    status === "granted" ? (
      <span className="pillstat ok">Granted</span>
    ) : status === "denied" ? (
      <span className="pillstat warn">Not set</span>
    ) : (
      <span className="pillstat muted">Unknown</span>
    );

  return (
    <div className="ob-step">
      <h1 className="ob-heading">Two quick permissions</h1>
      <p className="ob-sub">
        Lirrly needs these to hear you and to paste the result. Nothing leaves this Mac except
        the audio sent for transcription.
      </p>
      <div className="card">
        <div className="row">
          <div className="meta">
            <label>Microphone</label>
            <p>Asked automatically on your first dictation if not yet granted.</p>
          </div>
          <div className="ob-perm-actions">
            {badge(mic)}
            <button className="btn" onClick={() => void checkMic()}>
              Re-check
            </button>
            <button
              className="btn"
              onClick={() => void invoke("open_privacy_pane", { pane: "microphone" }).catch(() => {})}
            >
              System Settings
            </button>
          </div>
        </div>
        <div className="row">
          <div className="meta">
            <label>Accessibility</label>
            <p>Lets Lirrly paste text at your cursor. Without it you'd paste manually with ⌘V.</p>
          </div>
          <div className="ob-perm-actions">
            {badge(ax)}
            {ax !== "granted" && (
              <button className="btn" onClick={() => void requestAx()}>
                Enable
              </button>
            )}
            <button className="btn" onClick={() => void checkAx()}>
              Re-check
            </button>
          </div>
        </div>
      </div>
      <div className="ob-actions">
        <button className="btn primary" onClick={onNext}>
          Continue →
        </button>
      </div>
    </div>
  );
}

/* ---------- Step 2 — Engine setup ---------- */
function EngineSetup({ onNext }: { onNext: () => void }) {
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<KeyStatus>("none");

  useEffect(() => {
    if (hasTauriRuntime()) {
      void invoke<boolean>("has_api_key").then((has) => has && setStatus("valid"));
    }
  }, []);

  async function validate() {
    const k = key.trim();
    if (!k) return;
    if (!hasTauriRuntime()) {
      setStatus("valid"); // browser design preview
      return;
    }
    setStatus("checking");
    try {
      await invoke("set_api_key", { key: k });
    } catch {
      setStatus("save_error");
      return;
    }
    try {
      // Cheapest real round-trip: a tiny cleanup call proves the key works.
      await invoke<string>("cleanup_text", {
        text: "ping",
        model: "llama-3.1-8b-instant",
        level: "none",
        language: null,
        context: "onboarding",
      });
      setStatus("valid");
      setKey("");
    } catch (e) {
      const msg = String(e);
      if (msg.includes("401") || msg.includes("invalid_api_key")) setStatus("invalid");
      else setStatus("verify_error");
    }
  }

  return (
    <div className="ob-step">
      <h1 className="ob-heading">Connect your engine</h1>
      <p className="ob-sub">
        Lirrly transcribes with Groq's Whisper API — fast, accurate, and free for personal use.
        Your key is stored in the macOS Keychain and never leaves this Mac.
      </p>
      <div className="card">
        <div className="row">
          <div className="meta">
            <label>Groq API key</label>
            <p>
              {status === "valid"
                ? "Key works — you're ready."
                : status === "invalid"
                  ? "Key not valid — check for typos."
                  : status === "save_error"
                    ? "Couldn't save to Keychain — try again or add it later."
                    : status === "verify_error"
                    ? "Couldn't verify — check your connection and try again."
                    : "Paste your key, then validate."}
            </p>
          </div>
          <div className="ob-perm-actions">
            <input
              type="password"
              placeholder={status === "valid" ? "saved — paste to replace" : "gsk_…"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void validate()}
            />
            <button className="btn primary" onClick={() => void validate()}>
              {status === "checking" ? "Checking…" : "Validate"}
            </button>
          </div>
        </div>
        <div className="row">
          <div className="meta">
            <label>No key yet?</label>
            <p>Free at console.groq.com — takes about a minute.</p>
          </div>
          <button className="btn" onClick={() => void openUrl("https://console.groq.com/keys")}>
            Get a free key →
          </button>
        </div>
      </div>
      <div className="ob-actions">
          <button
            className="btn primary"
          disabled={status === "checking" || status === "none" || status === "invalid" || status === "save_error"}
          onClick={onNext}
        >
          {status === "verify_error" ? "Continue anyway →" : "Continue →"}
        </button>
        <button className="btn" onClick={onNext}>
          I'll add it later
        </button>
      </div>
    </div>
  );
}

/* ---------- Step 3 — First dictation ---------- */
function FirstDictation({ onNext }: { onNext: () => void }) {
  const [celebrate, setCelebrate] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    taRef.current?.focus();
    if (!hasTauriRuntime()) return;
    const shouldRestoreFlowBar = loadSettings().showFlowBar;
    void invoke("hide_flowbar").catch(() => {});
    let unlisten: (() => void) | undefined;
    let alive = true;
    void listen("dictation-complete", () => setCelebrate(true))
      .then((f) => {
        if (alive) unlisten = f;
        else f();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
      if (shouldRestoreFlowBar) void invoke("show_flowbar").catch(() => {});
    };
  }, []);

  return (
    <div className="ob-step">
      <h1 className="ob-heading">Try it now</h1>
      <p className="ob-sub">
        Click into the box below, press{" "}
        <span className="kbd ob-kbd-inline">
          <span>⌘</span>
          <span>⇧</span>
          <span>D</span>
        </span>{" "}
        — say anything — press it again to stop.
      </p>
      <textarea
        ref={taRef}
        className={`ob-playground ${celebrate ? "celebrate" : ""}`}
        placeholder="Your dictation will appear here…"
      />
      {celebrate && <div className="ob-success">🎉 It worked — that's your first Lirrly dictation!</div>}
      <div className="ob-actions">
        <button className={`btn ${celebrate ? "primary" : ""}`} onClick={onNext}>
          {celebrate ? "Finish setup →" : "Skip for now →"}
        </button>
      </div>
    </div>
  );
}

/* ---------- Step 4 — Done ---------- */
function Done({ onFinish }: { onFinish: () => void }) {
  const raw = loadSettings().shortcuts.dictation;
  const keys = raw?.length ? raw : ["⌘", "⇧", "D"];
  return (
    <div className="ob-step ob-center">
      <h1 className="ob-heading">You're set up.</h1>
      <div className="card ob-recap">
        <div className="row">
          <div className="meta">
            <label>Start / stop dictation anywhere</label>
          </div>
          <div className="kbd">
            {keys.map((k) => (
              <span key={k}>{k}</span>
            ))}
          </div>
        </div>
        <div className="row">
          <div className="meta">
            <label>The Lirrly bar</label>
            <p>Sits at the bottom of your screen — hover it for controls.</p>
          </div>
        </div>
        <div className="row">
          <div className="meta">
            <label>Private by design</label>
            <p>History stays on this Mac. Key lives in the Keychain. No account.</p>
          </div>
        </div>
      </div>
      <div className="ob-actions">
        <button className="btn primary" onClick={onFinish}>
          Open Lirrly →
        </button>
      </div>
    </div>
  );
}
