import { useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { startRecording, type Recorder } from "../lib/audio";
import { transcribe, transformText } from "../lib/engine";
import {
  hasTauriRuntime,
  loadSettings,
  resolveActiveTransform,
  saveSettings,
  pushHistory,
  LANGS,
  type CleanupLevel,
} from "../lib/store";
import "./FlowBar.css";

type State = "idle" | "listening" | "processing" | "done" | "error";
type MenuKey = "language" | "polish" | "scratchpad" | null;
type DockAction = "language" | "dictate" | "polish" | "scratchpad";

const RECORDING_BARS = [
  { x: 15, y: 10, width: 2, height: 7 },
  { x: 19, y: 8, width: 2, height: 10 },
  { x: 22, y: 7, width: 2, height: 12 },
  { x: 26, y: 8, width: 2, height: 10 },
  { x: 30, y: 8, width: 2, height: 10 },
  { x: 34, y: 9, width: 2, height: 9 },
  { x: 38, y: 9, width: 2, height: 9 },
  { x: 42, y: 8, width: 1, height: 10 },
  { x: 45, y: 9, width: 2, height: 8 },
  { x: 49, y: 10, width: 2, height: 6 },
];
const WINDOW_SIZES: Record<"collapsed" | "idle" | "menu" | "listening" | "message", { width: number; height: number }> = {
  collapsed: { width: 96, height: 54 },
  idle: { width: 252, height: 118 },
  menu: { width: 348, height: 244 },
  listening: { width: 110, height: 48 },
  message: { width: 348, height: 132 },
};

// Compact subset for the quick sheet — the full list lives in Settings.
const SHEET_LANGS = LANGS.filter(([id]) => ["auto", "en", "ar"].includes(id));

const POLISH_LEVELS: { id: CleanupLevel; label: string }[] = [
  { id: "none", label: "None — raw transcript" },
  { id: "light", label: "Light — drop fillers" },
  { id: "medium", label: "Medium — punctuate & tidy" },
  { id: "high", label: "High — full polish" },
];

const PREVIEW_STATES: State[] = ["listening", "processing", "done", "error"];
const DOCK_HIDE_MS = 170;
// Auto-stop guard: Groq rejects clips over 25 MB and ramblers forget to stop.
const MAX_RECORDING_MS = 5 * 60 * 1000;
const noopDockHover = (_action: DockAction | null) => {};

function isDockAction(value: string | null): value is DockAction {
  return value === "language" || value === "dictate" || value === "polish" || value === "scratchpad";
}

function getDevPreviewState(): State | null {
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(location.search).get("state");
  return PREVIEW_STATES.includes(value as State) ? (value as State) : null;
}

function getDevPreviewHover(): DockAction | null {
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(location.search).get("hover");
  return isDockAction(value) ? value : null;
}

type ToastAction = { label: string; run: () => void };

function initialPreviewMessage(): string {
  switch (getDevPreviewState()) {
    case "listening":
    case "processing":
      return "Using Built-in mic (recommended)";
    case "done":
      return "Done";
    case "error":
      return "Transcription failed";
    default:
      return "";
  }
}

function initialPreviewMenu(): MenuKey {
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(location.search).get("menu");
  return value === "language" || value === "polish" || value === "scratchpad" ? value : null;
}

export default function FlowBar() {
  const [state, setState] = useState<State>(() => getDevPreviewState() ?? "idle");
  const [message, setMessage] = useState(initialPreviewMessage);
  const [toastAction, setToastAction] = useState<ToastAction | null>(null);
  const [activeMenu, setActiveMenu] = useState<MenuKey>(initialPreviewMenu);
  const [hoveredAction, setHoveredAction] = useState<DockAction | null>(getDevPreviewHover);
  const [dockOpen, setDockOpen] = useState(
    () =>
      import.meta.env.DEV &&
      (new URLSearchParams(location.search).get("open") === "1" || getDevPreviewHover() !== null)
  );
  const [dockClosing, setDockClosing] = useState(false);
  const [opacity, setOpacity] = useState(() => loadSettings().flowBarOpacity);
  const [language, setLanguage] = useState(() => loadSettings().language);
  const [polishLevel, setPolishLevel] = useState<CleanupLevel>(
    () => loadSettings().cleanupByCtx.personal
  );
  const stateRef = useRef<State>("idle");
  const recRef = useRef<Recorder | null>(null);
  const rafRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const recordingCapRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const opIdRef = useRef(0);
  const listenStartRef = useRef(0);
  const barsRef = useRef<(HTMLDivElement | null)[]>([]);
  const previewHoverLock = useMemo(() => getDevPreviewHover() !== null, []);

  const viewMode = useMemo(() => {
    if (state === "listening") return "listening";
    if (state === "processing" || state === "done" || state === "error") return "message";
    if (activeMenu) return "menu";
    if (!dockOpen && !dockClosing) return "collapsed";
    return "idle";
  }, [activeMenu, dockClosing, dockOpen, state]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const size = WINDOW_SIZES[viewMode];
    if (!hasTauriRuntime()) return;
    void invoke("resize_flowbar", size).catch(() => {});
  }, [viewMode]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    void listen("toggle-dictation", () => {
      void onToggle();
    })
      .then((f) => {
        if (alive) unlisten = f;
        else f();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
      stopMeter();
      clearResetTimer();
      clearCollapseTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    void listen("run-transform", () => {
      void runTransformOnSelection();
    })
      .then((f) => {
        if (alive) unlisten = f;
        else f();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Settings live in localStorage (shared across windows); the Settings window
  // pings this event after each save so the bar picks changes up immediately.
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    void listen("settings-changed", () => {
      const s = loadSettings();
      setOpacity(s.flowBarOpacity);
      setLanguage(s.language);
      setPolishLevel(s.cleanupByCtx.personal);
    })
      .then((f) => {
        if (alive) unlisten = f;
        else f();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Dev-preview states are seeded via the useState initializers above; the
  // only effectful piece is painting the static waveform into the DOM.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (getDevPreviewState() === "listening") {
      const t = window.setTimeout(() => paintStaticBars(), 80);
      return () => window.clearTimeout(t);
    }
     
  }, []);

  async function onToggle() {
    const currentState = stateRef.current;
    if (currentState === "listening") await stopAndTranscribe();
    else if (currentState !== "processing") await startListening();
  }

  async function startListening() {
    if (busyRef.current || stateRef.current === "listening") return;
    clearResetTimer();
    clearCollapseTimer();
    opIdRef.current += 1;
    setActiveMenu(null);
    setHoveredAction(null);
    setDockClosing(false);
    setDockOpen(true);
    setMessage("Using Built-in mic (recommended)");
    // Even with the bar configured hidden, recording must always be visible.
    if (hasTauriRuntime()) void invoke("show_flowbar").catch(() => {});
    try {
      recRef.current = await startRecording(loadSettings().selectedMicId || undefined);
      listenStartRef.current = Date.now();
      setState("listening");
      startMeter();
      clearRecordingCap();
      recordingCapRef.current = window.setTimeout(() => {
        if (stateRef.current === "listening") void stopAndTranscribe();
      }, MAX_RECORDING_MS);
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        fail("Microphone access denied", {
          label: "Fix in System Settings",
          run: () => void invoke("open_privacy_pane", { pane: "microphone" }).catch(() => {}),
        });
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        fail("Microphone not found");
      } else {
        fail("Microphone unavailable");
      }
    }
  }

  async function stopAndTranscribe() {
    if (busyRef.current || stateRef.current !== "listening") return;
    busyRef.current = true;
    const opId = opIdRef.current;
    const durationMs = listenStartRef.current ? Date.now() - listenStartRef.current : undefined;
    clearRecordingCap();
    stopMeter();
    setState("processing");
    setMessage("Polishing...");
    try {
      const rec = recRef.current;
      if (!rec) return resetIfCurrent(opId);
      const blob = await rec.stop();
      recRef.current = null;

      // The API key lives in the Keychain — a missing key surfaces as a Rust error.
      const settings = loadSettings();
      const text = await transcribe(blob, settings);
      if (!text) {
        fail("Nothing heard — try again");
        return;
      }
      let count = 0;
      if (settings.storeHistory) count = await pushHistory(text, durationMs);
      await invoke("paste_text", { text });
      if (hasTauriRuntime()) void emit("dictation-complete", null);
      // Dictation-count milestones create frequent, visible progress wins; word
      // totals remain in Insights, but celebrations use the lifetime session count.
      const milestone =
        settings.notifications.milestones && [10, 50, 100, 500, 1000].includes(count);
      setState("done");
      setMessage(milestone ? `🎉 ${count} dictations!` : "Done");
      scheduleReset(milestone ? 1700 : 900, opId);
    } catch (e) {
      if (String(e).includes("paste_busy")) {
        setState("done");
        setMessage("Paste already in progress");
        scheduleReset(900, opId);
        return;
      }
      failFromError(e);
    } finally {
      busyRef.current = false;
    }
  }

  /** ⌥T flow: grab the selection in the frontmost app, run the active
   *  transform, and paste the result over the still-active selection. */
  async function runTransformOnSelection() {
    if (busyRef.current || stateRef.current !== "idle") return;
    busyRef.current = true;
    clearResetTimer();
    clearCollapseTimer();
    opIdRef.current += 1;
    const opId = opIdRef.current;
    setActiveMenu(null);
    setHoveredAction(null);
    setDockClosing(false);
    setDockOpen(true);
    const settings = loadSettings();
    const transform = resolveActiveTransform(settings);
    setState("processing");
    setMessage(`${transform.name}…`);
    // Even with the bar configured hidden, a running transform must be visible.
    if (hasTauriRuntime()) void invoke("show_flowbar").catch(() => {});
    try {
      const selection = await invoke<string>("capture_selection");
      const out = await transformText(selection, transform, settings);
      if (!out) {
        fail("Transform came back empty — try again");
        return;
      }
      await invoke("paste_text", { text: out });
      setState("done");
      setMessage(`${transform.name} ✓`);
      scheduleReset(900, opId);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("no_selection")) {
        fail("Select text first, then press the shortcut");
      } else if (msg.includes("empty_transform")) {
        fail("Transform came back empty — try again");
      } else if (msg.includes("paste_busy")) {
        setState("done");
        setMessage("Another paste is in progress");
        scheduleReset(900, opId);
      } else {
        failFromError(e, "Transform failed");
      }
    } finally {
      busyRef.current = false;
    }
  }

  /** Map raw engine/Rust errors to actionable, human toasts. */
  function failFromError(e: unknown, fallbackMsg = "Transcription failed") {
    const msg = String(e);
    const openSettings: ToastAction = {
      label: "Open Settings",
      run: () => openSettingsSection("settings"),
    };
    if (msg.includes("missing_api_key")) {
      fail("No API key — add one in Settings", openSettings);
    } else if (msg.includes("401") || msg.includes("invalid_api_key")) {
      fail("API key invalid — check it in Settings", openSettings);
    } else if (msg.includes("429")) {
      fail("Groq rate limit — wait a moment");
    } else if (msg.includes("recording_too_large")) {
      fail("Recording too long — try shorter takes");
    } else if (msg.includes("accessibility_not_granted")) {
      fail("Accessibility needed to paste", {
        label: "Fix in System Settings",
        run: () => void invoke("open_privacy_pane", { pane: "accessibility" }).catch(() => {}),
      });
    } else if (/timed? ?out|connection|network|error sending request|dns/i.test(msg)) {
      fail("Can't reach Groq — check your connection");
    } else {
      fail(fallbackMsg);
    }
  }

  function toggleMenu(menu: Exclude<MenuKey, null>) {
    if (stateRef.current !== "idle") return;
    clearCollapseTimer();
    setDockClosing(false);
    setDockOpen(true);
    setActiveMenu((current) => (current === menu ? null : menu));
  }

  function selectLanguage(id: string) {
    const s = loadSettings();
    saveSettings({ ...s, language: id });
    setLanguage(id);
    if (hasTauriRuntime()) void emit("settings-changed", null);
    setActiveMenu(null);
  }

  function selectPolishLevel(level: CleanupLevel) {
    const s = loadSettings();
    saveSettings({ ...s, cleanupByCtx: { ...s.cleanupByCtx, personal: level } });
    setPolishLevel(level);
    if (hasTauriRuntime()) void emit("settings-changed", null);
    setActiveMenu(null);
  }

  function openSettingsSection(section: string) {
    setActiveMenu(null);
    if (!hasTauriRuntime()) return;
    void invoke("open_settings").catch(() => {});
    void emit("navigate-settings", section);
  }

  /** Errors are toasted in the bar; when the bar is configured hidden, the
   *  toggle-gated system notification is the only feedback channel. */
  function notifyError(msg: string) {
    if (!hasTauriRuntime()) return;
    const settings = loadSettings();
    if (!settings.notifications.errors || settings.showFlowBar) return;
    void (async () => {
      try {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted) sendNotification({ title: "Lirrly", body: msg });
      } catch {
        /* notification stack unavailable — the in-bar toast already showed */
      }
    })();
  }

  function startMeter() {
    const rec = recRef.current;
    if (!rec) return;
    stopMeter();
    const analyser = rec.analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const step = Math.floor(data.length / RECORDING_BARS.length) || 1;
      for (let i = 0; i < RECORDING_BARS.length; i++) {
        const v = data[i * step] / 255;
        const el = barsRef.current[i];
        const height = Math.round(4 + Math.max(0.08, v) * 8);
        if (el) {
          el.style.height = `${height}px`;
          el.style.top = `${Math.round(13 - height / 2)}px`;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  function stopMeter() {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }

  function fail(msg: string, action?: ToastAction) {
    const opId = opIdRef.current;
    stopMeter();
    clearRecordingCap();
    setActiveMenu(null);
    setHoveredAction(null);
    setDockOpen(true);
    setState("error");
    setMessage(msg);
    setToastAction(action ?? null);
    notifyError(msg);
    // Errors with a fix button linger longer so it can actually be clicked.
    scheduleReset(action ? 4000 : 2200, opId);
  }

  function reset() {
    const previewState = getDevPreviewState();
    if (previewState) {
      setState(previewState);
      setActiveMenu(null);
      setHoveredAction(null);
      setDockClosing(false);
      setDockOpen(true);
      busyRef.current = false;
      return;
    }
    clearResetTimer();
    clearRecordingCap();
    setState("idle");
    setMessage("");
    setToastAction(null);
    setActiveMenu(null);
    setHoveredAction(null);
    setDockClosing(false);
    setDockOpen(false);
    busyRef.current = false;
    // A bar configured hidden was shown for the recording — tuck it away again.
    if (hasTauriRuntime() && !loadSettings().showFlowBar) {
      void invoke("hide_flowbar").catch(() => {});
    }
  }

  function resetIfCurrent(opId: number) {
    if (opId === opIdRef.current) reset();
  }

  function scheduleReset(delay: number, opId: number) {
    clearResetTimer();
    resetTimerRef.current = window.setTimeout(() => resetIfCurrent(opId), delay);
  }

  function clearResetTimer() {
    if (resetTimerRef.current != null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }

  function clearCollapseTimer() {
    if (collapseTimerRef.current != null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }

  function clearRecordingCap() {
    if (recordingCapRef.current != null) {
      window.clearTimeout(recordingCapRef.current);
      recordingCapRef.current = null;
    }
  }

  function openDock() {
    clearCollapseTimer();
    if (stateRef.current === "idle") {
      setDockClosing(false);
      setDockOpen(true);
    }
  }

  function queueCollapse() {
    if (getDevPreviewState()) return;
    if (activeMenu || stateRef.current !== "idle") return;
    clearCollapseTimer();
    collapseTimerRef.current = window.setTimeout(() => {
      setHoveredAction(null);
      setDockClosing(true);
      collapseTimerRef.current = window.setTimeout(() => {
        setDockOpen(false);
        setDockClosing(false);
        collapseTimerRef.current = null;
      }, DOCK_HIDE_MS);
    }, 520);
  }

  function paintStaticBars() {
    barsRef.current.forEach((el, i) => {
      const bar = RECORDING_BARS[i % RECORDING_BARS.length];
      if (el) {
        el.style.height = `${bar.height}px`;
        el.style.top = `${bar.y}px`;
      }
    });
  }

  return (
    <div
      className={`flowbar state-${state} menu-${activeMenu ?? "none"} ${dockOpen || activeMenu || state !== "idle" ? "is-open" : "is-collapsed"}`}
      style={{ opacity: state === "idle" && !activeMenu ? opacity / 100 : undefined }}
      onMouseEnter={openDock}
      onMouseLeave={queueCollapse}
      onFocus={openDock}
    >
      {state === "idle" && activeMenu && (
        <OptionsSheet
          menu={activeMenu}
          language={language}
          polishLevel={polishLevel}
          onSelectLanguage={selectLanguage}
          onSelectPolishLevel={selectPolishLevel}
          onOpenSettingsSection={openSettingsSection}
        />
      )}
      {state === "idle" && <Tooltip action={hoveredAction} activeMenu={activeMenu} />}

      {(state === "processing" || state === "done" || state === "error") && (
        <div className="status-toast message-toast" role="status">
          {state === "processing" && <span className="tiny-spinner" />}
          {message || labelFor(state)}
          {state === "error" && toastAction && (
            <button className="toast-action" onClick={toastAction.run}>
              {toastAction.label}
            </button>
          )}
        </div>
      )}

      {state === "idle" && !dockOpen && !dockClosing && !activeMenu ? (
        <button className="flow-handle" aria-label="Open Lirrly controls" onClick={openDock} />
      ) : state === "listening" ? (
        <ListeningDock onStop={() => void stopAndTranscribe()} barsRef={barsRef} />
      ) : (
        <IdleDock
          activeMenu={activeMenu}
          closing={dockClosing}
          hoveredAction={hoveredAction}
          onHover={previewHoverLock ? noopDockHover : setHoveredAction}
          onLanguage={() => toggleMenu("language")}
          onDictate={() => void startListening()}
          onPolish={() => toggleMenu("polish")}
          onScratchpad={() => toggleMenu("scratchpad")}
          onCloseMenu={() => {
            setActiveMenu(null);
            setHoveredAction(null);
          }}
        />
      )}
    </div>
  );
}

function IdleDock({
  activeMenu,
  closing,
  hoveredAction,
  onHover,
  onLanguage,
  onDictate,
  onPolish,
  onScratchpad,
  onCloseMenu,
}: {
  activeMenu: MenuKey;
  closing: boolean;
  hoveredAction: DockAction | null;
  onHover: (action: DockAction | null) => void;
  onLanguage: () => void;
  onDictate: () => void;
  onPolish: () => void;
  onScratchpad: () => void;
  onCloseMenu: () => void;
}) {
  return (
    <div className={`dock-wrap ${closing ? "closing" : ""}`}>
      <div className="dock" role="toolbar" aria-label="Lirrly controls">
        {activeMenu === "language" ? (
          <div className="dock-menu-group" data-menu-group="language">
            <button className="dock-inline-chevron" aria-label="Close menu" onClick={onCloseMenu}>
              <ChevronUpIcon />
            </button>
            <DockButton
              action="language"
              active
              hovered={hoveredAction === "language"}
              onHover={onHover}
              onClick={onLanguage}
            >
              <GlobeIcon />
            </DockButton>
          </div>
        ) : (
          <DockButton
            action="language"
            active={false}
            hovered={hoveredAction === "language"}
            onHover={onHover}
            onClick={onLanguage}
          >
            <GlobeIcon />
          </DockButton>
        )}
        <DockButton action="dictate" hovered={hoveredAction === "dictate"} onHover={onHover} onClick={onDictate}>
          <MicIcon />
        </DockButton>
        {activeMenu === "polish" ? (
          <div className="dock-menu-group" data-menu-group="polish">
            <DockButton
              action="polish"
              active
              hovered={hoveredAction === "polish"}
              onHover={onHover}
              onClick={onPolish}
            >
              <WandIcon />
            </DockButton>
            <button className="dock-inline-chevron" aria-label="Close menu" onClick={onCloseMenu}>
              <ChevronUpIcon />
            </button>
          </div>
        ) : (
          <DockButton
            action="polish"
            active={false}
            hovered={hoveredAction === "polish"}
            onHover={onHover}
            onClick={onPolish}
          >
            <WandIcon />
          </DockButton>
        )}
        {activeMenu === "scratchpad" ? (
          <div className="dock-menu-group" data-menu-group="scratchpad">
            <DockButton
              action="scratchpad"
              active
              hovered={hoveredAction === "scratchpad"}
              onHover={onHover}
              onClick={onScratchpad}
            >
              <ScratchpadIcon />
            </DockButton>
            <button className="dock-inline-chevron" aria-label="Close menu" onClick={onCloseMenu}>
              <ChevronUpIcon />
            </button>
          </div>
        ) : (
          <DockButton
            action="scratchpad"
            active={false}
            hovered={hoveredAction === "scratchpad"}
            onHover={onHover}
            onClick={onScratchpad}
          >
            <ScratchpadIcon />
          </DockButton>
        )}
      </div>
    </div>
  );
}

function DockButton({
  action,
  active = false,
  hovered,
  onHover,
  onClick,
  children,
}: {
  action: DockAction;
  active?: boolean;
  hovered: boolean;
  onHover: (action: DockAction | null) => void;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`dock-btn ${active ? "active" : ""} ${hovered ? "hovered" : ""}`}
      data-action={action}
      aria-label={labelForAction(action)}
      onClick={onClick}
      onMouseEnter={() => onHover(action)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(action)}
      onBlur={() => onHover(null)}
    >
      {children}
    </button>
  );
}

function ListeningDock({ onStop, barsRef }: { onStop: () => void; barsRef: MutableRefObject<(HTMLDivElement | null)[]> }) {
  return (
    <button className="recording-dock" onClick={onStop} aria-label="Stop recording">
      <div className="recording-bars" aria-hidden="true">
        {RECORDING_BARS.map((bar, i) => (
          <div
            className="recording-bar"
            key={i}
            style={{
              left: `${bar.x}px`,
              top: `${bar.y}px`,
              width: `${bar.width}px`,
              height: `${bar.height}px`,
            }}
            ref={(el) => {
              barsRef.current[i] = el;
            }}
          />
        ))}
      </div>
    </button>
  );
}

function OptionsSheet({
  menu,
  language,
  polishLevel,
  onSelectLanguage,
  onSelectPolishLevel,
  onOpenSettingsSection,
}: {
  menu: Exclude<MenuKey, null>;
  language: string;
  polishLevel: CleanupLevel;
  onSelectLanguage: (id: string) => void;
  onSelectPolishLevel: (level: CleanupLevel) => void;
  onOpenSettingsSection: (section: string) => void;
}) {
  if (menu === "language") {
    return (
      <div className="options-sheet language-sheet" role="menu" aria-label="Language">
        {SHEET_LANGS.map(([id, label]) => (
          <button
            className={`sheet-row ${language === id ? "active" : ""}`}
            key={id}
            onClick={() => onSelectLanguage(id)}
          >
            <span className="row-handle" />
            <span>{label}</span>
            {language === id && <CheckIcon />}
          </button>
        ))}
        <button className="sheet-row" onClick={() => onOpenSettingsSection("settings")}>
          <span className="row-handle">+</span>
          <span>More languages…</span>
        </button>
      </div>
    );
  }

  if (menu === "scratchpad") {
    return (
      <div className="options-sheet scratch-sheet" role="menu" aria-label="Scratchpad">
        <button className="sheet-row" disabled style={{ opacity: 0.55, cursor: "default" }}>
          Scratchpad — coming soon
        </button>
      </div>
    );
  }

  return (
    <div className="options-sheet polish-sheet" role="menu" aria-label="Polish">
      {POLISH_LEVELS.map((option) => (
        <button
          className={`sheet-row ${polishLevel === option.id ? "active" : ""}`}
          key={option.id}
          onClick={() => onSelectPolishLevel(option.id)}
        >
          <span className="row-handle" />
          <span>{option.label}</span>
          {polishLevel === option.id && <CheckIcon />}
        </button>
      ))}
      <button className="sheet-row" onClick={() => onOpenSettingsSection("transforms")}>
        <GearIcon />
        <span>Configure transforms</span>
      </button>
    </div>
  );
}

function Tooltip({ action, activeMenu }: { action: DockAction | null; activeMenu: MenuKey }) {
  if (!action || activeMenu) return null;
  return <div className={`dock-tooltip tooltip-${action}`}>{labelForAction(action)}</div>;
}

function labelForAction(action: DockAction): string {
  switch (action) {
    case "language":
      return "Change language";
    case "dictate":
      return "Dictate";
    case "polish":
      return "Polish ⌥ Opt 1";
    case "scratchpad":
      return "Scratchpad";
  }
}

function labelFor(s: State): string {
  switch (s) {
    case "processing":
      return "Polishing...";
    case "done":
      return "Done";
    case "error":
      return "Error";
    default:
      return "";
  }
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.8 12h16.4M12 3.5c2.2 2.4 3.4 5.2 3.4 8.5S14.2 18.1 12 20.5M12 3.5C9.8 5.9 8.6 8.7 8.6 12s1.2 6.1 3.4 8.5" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3.5" width="6" height="10.5" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3" />
    </svg>
  );
}

function WandIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 19 19 5" />
      <path d="m14 4 1 3 3 1-3 1-1 3-1-3-3-1 3-1zM6 5l.5 1.5L8 7l-1.5.5L6 9l-.5-1.5L4 7l1.5-.5zM18 15l.5 1.5L20 17l-1.5.5L18 19l-.5-1.5L16 17l1.5-.5z" />
    </svg>
  );
}

function ScratchpadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 5.5A2.5 2.5 0 0 1 8.5 3h7A2.5 2.5 0 0 1 18 5.5v10A2.5 2.5 0 0 1 15.5 18H10l-4 3v-3.5" />
      <path d="M9 8h6M9 12h4" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 14 5-5 5 5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12.5 4.3 4.3L19 7" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.6 12h2.2M17.2 12h2.2M6.8 6.8l1.6 1.6M15.6 15.6l1.6 1.6M17.2 6.8l-1.6 1.6M8.4 15.6l-1.6 1.6" />
    </svg>
  );
}
