import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { getVersion } from "@tauri-apps/api/app";
import {
  DEFAULTS,
  hasTauriRuntime,
  loadSettings,
  resolveActiveTransform,
  saveSettings,
  loadHistory,
  clearHistory,
  writeHistory,
  localDateKey,
  isRtlText,
  LANGS,
  type AppSettings,
  type HistoryItem,
  type CleanupLevel,
  type CtxKey,
  type Transform,
} from "../lib/store";
import { listMicrophones } from "../lib/audio";
import { transformText } from "../lib/engine";
import {
  symbolsToAccelerator,
  DEFAULT_DICTATION_ACCELERATOR,
  DEFAULT_TRANSFORM_ACCELERATOR,
} from "../lib/shortcuts";
import OnboardingWizard from "../onboarding/OnboardingWizard";
import { Icon, type IconName } from "./Icon";
import { WaveMark } from "./Logo";
import "./Settings.css";

const ONBOARDED_KEY = "lirrly.onboarded";

function initialOnboarded(): boolean {
  if (localStorage.getItem(ONBOARDED_KEY) === "1") return true;
  // Existing installs are already set up — don't re-onboard them.
  if (localStorage.getItem("lirrly.settings") !== null) {
    localStorage.setItem(ONBOARDED_KEY, "1");
    return true;
  }
  return false;
}

type Section =
  | "home"
  | "history"
  | "dictionary"
  | "snippets"
  | "transforms"
  | "styles"
  | "scratchpad"
  | "insights"
  | "shortcuts"
  | "settings"
  | "account";

type Update = (p: Partial<AppSettings>) => void;
const SECTIONS: Section[] = [
  "home",
  "history",
  "dictionary",
  "snippets",
  "transforms",
  "styles",
  "scratchpad",
  "insights",
  "shortcuts",
  "settings",
  "account",
];

// Lirrly keeps Insights near the top; History lives on Home (not a nav item).
const TOP_NAV: { id: Section; label: string; icon: IconName }[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "history", label: "History", icon: "history" },
  { id: "insights", label: "Insights", icon: "chart" },
  { id: "dictionary", label: "Dictionary", icon: "book" },
  { id: "snippets", label: "Snippets", icon: "zap" },
  { id: "transforms", label: "Transforms", icon: "sparkles" },
  { id: "styles", label: "Styles", icon: "sliders" },
  { id: "scratchpad", label: "Scratchpad", icon: "note" },
];
const BOTTOM_NAV: { id: Section; label: string; icon: IconName }[] = [
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard" },
  { id: "settings", label: "Settings", icon: "gear" },
  { id: "account", label: "Account", icon: "user" },
];

export default function Settings() {
  const [section, setSection] = useState<Section>("home");
  const [s, setS] = useState<AppSettings>(loadSettings());
  const [onboarded, setOnboarded] = useState(initialOnboarded);
  const settingsEmitTimer = useRef<number | null>(null);
  const onboardingDoneRef = useRef(false);

  function scheduleSettingsChanged(): void {
    if (!hasTauriRuntime()) return;
    if (settingsEmitTimer.current !== null) window.clearTimeout(settingsEmitTimer.current);
    settingsEmitTimer.current = window.setTimeout(() => {
      settingsEmitTimer.current = null;
      void emit("settings-changed", null);
    }, 150);
  }

  const update: Update = (patch) => {
    // Functional updater so event-handler closures always merge into latest state
    // (fixes the stale-closure class of bugs, e.g. shortcut rebinding).
    setS((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      // Other windows (the FlowBar) re-read localStorage when pinged.
      scheduleSettingsChanged();
      return next;
    });
  };

  useEffect(
    () => () => {
      if (settingsEmitTimer.current !== null) {
        window.clearTimeout(settingsEmitTimer.current);
        settingsEmitTimer.current = null;
        if (hasTauriRuntime()) void emit("settings-changed", null);
      }
    },
    []
  );

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    void invoke<boolean>("has_api_key")
      .then((has) => {
        if (has && !onboarded && !onboardingDoneRef.current) {
          localStorage.setItem(ONBOARDED_KEY, "1");
          setOnboarded(true);
        }
      })
      .catch(() => {});
  }, [onboarded]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    void listen<string>("navigate-settings", (event) => {
      const next = event.payload as Section;
      if (SECTIONS.includes(next)) setSection(next);
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

  // One-time migration: a key stored by older builds in localStorage moves to
  // the macOS Keychain, then is blanked here. On failure it simply retries on
  // the next launch (the localStorage copy is only removed after success).
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    const legacy = s.groqApiKey?.trim();
    if (!legacy) return;
    void (async () => {
      try {
        const exists = await invoke<boolean>("has_api_key");
        if (!exists) await invoke("set_api_key", { key: legacy });
        update({ groqApiKey: "" });
      } catch {
        /* keychain unavailable — keep localStorage copy and retry next launch */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The FlowBar can also change settings (language, polish level) — stay in sync.
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    void listen("settings-changed", () => setS(loadSettings()))
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

  // Re-apply the user's saved shortcuts to the Rust global registry.
  // A failure here is non-fatal: the default registrations stay active.
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    const acc = symbolsToAccelerator(s.shortcuts.dictation);
    if (acc && acc !== DEFAULT_DICTATION_ACCELERATOR) {
      void invoke("update_shortcut", { action: "dictation", accelerator: acc }).catch(() => {});
    }
    const accT = symbolsToAccelerator(s.shortcuts.transform);
    if (accT && accT !== DEFAULT_TRANSFORM_ACCELERATOR) {
      void invoke("update_shortcut", { action: "transform", accelerator: accT }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!onboarded) {
    return (
      <OnboardingWizard
        onDone={() => {
          onboardingDoneRef.current = true;
          localStorage.setItem(ONBOARDED_KEY, "1");
          // Persist current defaults so the existing-install guard holds next launch.
          saveSettings(s);
          setOnboarded(true);
        }}
      />
    );
  }

  const navBtn = (n: { id: Section; label: string; icon: IconName }) => (
    <button
      key={n.id}
      className={`nav-item ${section === n.id ? "active" : ""}`}
      onClick={() => setSection(n.id)}
    >
      <Icon name={n.icon} />
      {n.label}
      {n.id === "scratchpad" && (
        <span className="pillstat muted" style={{ marginLeft: "auto", fontSize: 11, padding: "2px 7px" }}>
          Soon
        </span>
      )}
    </button>
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <WaveMark />
          <span className="name">Lirrly</span>
          <span className="plan-pill">Free · local</span>
        </div>
        {TOP_NAV.map(navBtn)}
        <div className="nav-spacer" />
        <div className="nav-sep" />
        {BOTTOM_NAV.map(navBtn)}
      </aside>

      <main className="content">
        <div className="top-actions">
          <button className="top-icon" title="Notifications" aria-label="Notifications">
            <Icon name="bell" />
          </button>
          <button className="top-icon" title="Account" aria-label="Account" onClick={() => setSection("account")}>
            <Icon name="user" />
          </button>
        </div>
        {section === "home" && <Home s={s} onJump={setSection} />}
        {section === "history" && <HistoryView s={s} />}
        {section === "dictionary" && <Dictionary s={s} update={update} />}
        {section === "snippets" && <Snippets s={s} update={update} />}
        {section === "transforms" && <Transforms s={s} update={update} />}
        {section === "styles" && <Styles s={s} update={update} />}
        {section === "scratchpad" && <Scratchpad />}
        {section === "insights" && <Insights />}
        {section === "shortcuts" && <ShortcutsPanel s={s} update={update} />}
        {section === "settings" && <General s={s} update={update} onJump={setSection} />}
        {section === "account" && <Account s={s} update={update} />}
      </main>
    </div>
  );
}

/* ---------- shared ---------- */
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return <button className={`toggle ${on ? "on" : ""}`} onClick={onClick} aria-pressed={on} />;
}
function wordCount(t: string): number {
  const x = t.trim();
  return x ? x.split(/\s+/).length : 0;
}

/* ---------- Home ---------- */
function Home({ s, onJump }: { s: AppSettings; onJump: (s: Section) => void }) {
  const [hist, setHist] = useState<HistoryItem[]>([]);
  const [mountedAt] = useState(() => Date.now());
  const [heroDismissed, setHeroDismissed] = useState(
    () => localStorage.getItem("lirrly.heroDismissed") === "1"
  );
  useEffect(() => {
    void loadHistory().then(setHist);
    if (!hasTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    // Live-refresh the feed when a dictation lands while Home is open.
    void listen("dictation-complete", () => void loadHistory().then(setHist))
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
  const sessions = hist.length;
  const totalWords = hist.reduce((a, h) => a + wordCount(h.text), 0);
  const daySet = new Set(hist.map((h) => new Date(h.at).toDateString()));
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    if (daySet.has(d.toDateString())) streak++;
    else break;
  }
  // Real WPM from measured recording time; items predating duration capture
  // are excluded rather than guessed at.
  const timed = hist.filter((h) => h.durationMs && h.durationMs > 1500);
  const avgWpm = timed.length
    ? Math.round(
        timed.reduce((a, h) => a + wordCount(h.text) / ((h.durationMs as number) / 60000), 0) /
          timed.length
      )
    : 0;
  const name = s.displayName.trim() || "there";
  const weekWords = hist
    .filter((h) => h.at >= mountedAt - 7 * 86400000)
    .reduce((a, h) => a + wordCount(h.text), 0);
  const recent = hist.slice(0, 6);
  const grouped = recent.reduce<{ label: string; items: HistoryItem[] }[]>((acc, item) => {
    const label = dayBucket(item.at);
    const bucket = acc.find((x) => x.label === label);
    if (bucket) bucket.items.push(item);
    else acc.push({ label, items: [item] });
    return acc;
  }, []);

  return (
    <div className="home-shell">
      <section className="home-main">
        <h1 className="home-heading">Welcome back, {name}</h1>

        {!heroDismissed && (
          <div className="home-hero">
            <div className="hero-copy">
              {totalWords > 0 ? (
                <>
                  <h2>You've dictated {totalWords.toLocaleString()} words</h2>
                  <p>
                    That's roughly {Math.max(1, Math.round(totalWords / 40))} minutes of typing,
                    done by talking.
                  </p>
                  <button className="hero-btn" onClick={() => onJump("history")}>
                    View your history
                  </button>
                </>
              ) : (
                <>
                  <h2>Your first dictation is one shortcut away</h2>
                  <p>Press ⌘⇧D anywhere, say something, press it again — your words appear where your cursor is.</p>
                  <button className="hero-btn" onClick={() => onJump("settings")}>
                    Set up in Settings
                  </button>
                </>
              )}
            </div>
            <button
              className="hero-close"
              aria-label="Dismiss"
              onClick={() => {
                localStorage.setItem("lirrly.heroDismissed", "1");
                setHeroDismissed(true);
              }}
            >
              ×
            </button>
            <div className="hero-person" aria-hidden="true" />
          </div>
        )}

        <div className="home-feed">
          {sessions === 0 ? (
            <>
              <div className="daygroup">Today</div>
              <div className="history-card">
                <div className="empty home-empty">
                  No dictations yet — press{" "}
                  <span className="kbd" style={{ display: "inline-flex", verticalAlign: "middle" }}>
                    <span>⌘</span>
                    <span>⇧</span>
                    <span>D</span>
                  </span>{" "}
                  and start talking.
                </div>
              </div>
            </>
          ) : (
            grouped.map((g) => (
              <div key={g.label}>
                <div className="daygroup">{g.label}</div>
                <div className="history-card">
                  {g.items.map((it, i) => (
                    <div className="home-history-row" key={`${it.at}-${i}`}>
                      <time>
                        {new Date(it.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      </time>
                      <p dir={isRtlText(it.text) ? "rtl" : undefined}>{it.text}</p>
                      <div className="row-actions">
                        <button
                          title="Copy"
                          onClick={() => {
                            void navigator.clipboard?.writeText(it.text).catch(() => {});
                          }}
                        >
                          ⧉
                        </button>
                        <button title="Flag">⚐</button>
                        <button title="More">⋮</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <aside className="home-rail">
        <div className="rail-card rail-stats">
          <div>
            <strong>{totalWords.toLocaleString()}</strong>
            <span>total words</span>
          </div>
          <div>
            <strong>{avgWpm || "—"}</strong>
            <span>wpm</span>
          </div>
          <div>
            <strong>{streak}</strong>
            <span>day streak</span>
          </div>
        </div>
        <div className="rail-card voice-card">
          <div>
            <h3>This week</h3>
            <p>{weekWords.toLocaleString()} words dictated</p>
          </div>
          <div className="profile-illo" aria-hidden="true">
            <span />
          </div>
        </div>
        {sessions > 0 && (
          <button className="btn rail-btn" onClick={() => onJump("history")}>
            View all history
          </button>
        )}
      </aside>
    </div>
  );
}

/* ---------- History ---------- */
function dayBucket(ts: number): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400000;
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - day) return "Yesterday";
  if (ts >= startOfToday - 7 * day) return "This Week";
  if (ts >= startOfToday - 14 * day) return "Last Week";
  return "Older";
}
function HistoryView({ s }: { s: AppSettings }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest" | "longest">("newest");
  const [transformingAt, setTransformingAt] = useState<number | null>(null);
  const [transformedAt, setTransformedAt] = useState<number | null>(null);
  const [transformError, setTransformError] = useState("");
  useEffect(() => {
    void loadHistory().then(setItems);
  }, []);

  function del(target: HistoryItem) {
    const next = items.filter((x) => !(x.at === target.at && x.text === target.text));
    void writeHistory(next);
    setItems(next);
  }

  /** History ✨: run the active transform and put the result on the clipboard. */
  async function transformToClipboard(it: HistoryItem) {
    if (transformingAt !== null) return;
    setTransformingAt(it.at);
    setTransformError("");
    try {
      const out = await transformText(it.text, resolveActiveTransform(s), s);
      if (!out) throw new Error("empty_transform");
      await navigator.clipboard?.writeText(out);
      setTransformedAt(it.at);
      window.setTimeout(() => setTransformedAt((v) => (v === it.at ? null : v)), 1600);
    } catch (e) {
      // Surfaceable: key/network problems belong to the user, not the console.
      setTransformError(
        String(e).includes("missing_api_key")
          ? "Transform needs a Groq key — add one in Settings."
          : "Transform failed — check your connection and Groq key."
      );
    } finally {
      setTransformingAt(null);
    }
  }

  const filtered = items
    .filter((it) => it.text.toLowerCase().includes(q.toLowerCase()))
    .slice()
    .sort((a, b) =>
      sort === "oldest" ? a.at - b.at : sort === "longest" ? wordCount(b.text) - wordCount(a.text) : b.at - a.at
    );

  const groups: { label: string; items: HistoryItem[] }[] = [];
  for (const it of filtered) {
    const b = dayBucket(it.at);
    let g = groups.find((x) => x.label === b);
    if (!g) {
      g = { label: b, items: [] };
      groups.push(g);
    }
    g.items.push(it);
  }

  return (
    <>
      <h1>History</h1>
      <p className="sub">Every dictation, stored locally on this Mac.</p>
      {items.length > 0 && (
        <div className="toolbar">
          <input
            type="search"
            placeholder="Search history (⌘F)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1 }}
          />
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} style={{ minWidth: 150 }}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="longest">Longest</option>
          </select>
        </div>
      )}
      {transformError && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <div className="row">
            <div className="meta">
              <label style={{ color: "var(--danger)" }}>{transformError}</label>
            </div>
          </div>
        </div>
      )}
      {items.length === 0 ? (
        <div className="card">
          <div className="empty">
            No dictations yet — press{" "}
            <span className="kbd" style={{ display: "inline-flex", verticalAlign: "middle" }}>
              <span>⌘</span>
              <span>⇧</span>
              <span>D</span>
            </span>{" "}
            and start talking.
          </div>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.label}>
            <div className="daygroup">{g.label}</div>
            <div className="card">
              <ul className="hist">
                {g.items.map((it, i) => (
                  <li key={`${it.at}-${i}`} style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="t" dir={isRtlText(it.text) ? "rtl" : undefined}>
                        {it.text}
                      </div>
                      <span className="when">
                        {new Date(it.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ·{" "}
                        {wordCount(it.text)} words
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button
                        className="iconbtn"
                        title={`Transform with “${resolveActiveTransform(s).name}” and copy`}
                        onClick={() => void transformToClipboard(it)}
                      >
                        {transformingAt === it.at ? "…" : transformedAt === it.at ? "✓" : "✨"}
                      </button>
                      <button
                        className="iconbtn"
                        title="Copy"
                        onClick={() => {
                          void navigator.clipboard?.writeText(it.text).catch(() => {});
                        }}
                      >
                        ⧉
                      </button>
                      <button className="iconbtn" title="Delete" onClick={() => del(it)}>
                        🗑
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))
      )}
      {items.length > 0 && (
        <button
          className="btn"
          onClick={() => {
            void clearHistory();
            setItems([]);
          }}
        >
          Clear history
        </button>
      )}
    </>
  );
}

/* ---------- Dictionary ---------- */
function Dictionary({ s, update }: { s: AppSettings; update: Update }) {
  const [word, setWord] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest" | "starred" | "az">("newest");
  const [q, setQ] = useState("");
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editVal, setEditVal] = useState("");
  const committedRef = useRef(false);

  function add() {
    const w = word.trim();
    if (w && !s.dictionary.some((d) => d.word === w))
      update({
        dictionary: [...s.dictionary, { word: w, starred: false, autoLearned: false, addedAt: Date.now() }],
      });
    setWord("");
  }
  function patch(i: number, p: Partial<AppSettings["dictionary"][number]>) {
    const d = [...s.dictionary];
    d[i] = { ...d[i], ...p };
    update({ dictionary: d });
  }
  function remove(i: number) {
    update({ dictionary: s.dictionary.filter((_, j) => j !== i) });
  }

  const sorted = s.dictionary
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.word.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => {
      if (sort === "starred") return Number(b.d.starred) - Number(a.d.starred);
      if (sort === "oldest") return a.d.addedAt - b.d.addedAt;
      if (sort === "az") return a.d.word.localeCompare(b.d.word);
      return b.d.addedAt - a.d.addedAt;
    });

  return (
    <>
      <h1>Dictionary</h1>
      <p className="sub">Teach Lirrly your words — names, jargon, and brand terms it should always get right.</p>
      <div className="card">
          <div className="row">
            <div className="meta">
              <label>Add a word</label>
              <p>Terms sent to the model as a recognition hint.</p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={word}
                placeholder="e.g. Mshrmnsr"
                onChange={(e) => setWord(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
              />
              <button className="btn primary" onClick={add}>
                Add
              </button>
            </div>
          </div>
          {s.dictionary.length > 0 ? (
            <>
              <div className="toolbar" style={{ paddingTop: 14 }}>
                <input
                  type="search"
                  placeholder="Search words (⌘F)"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  style={{ flex: 1 }}
                />
                <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} style={{ minWidth: 150 }}>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="starred">Starred first</option>
                  <option value="az">Alphabetical</option>
                </select>
              </div>
              <ul className="list">
                {sorted.map(({ d, i }) => (
                  <li key={d.word}>
                    <button
                      className={`iconbtn ${d.starred ? "starred" : ""}`}
                      onClick={() => patch(i, { starred: !d.starred })}
                      title="Star"
                    >
                      {d.starred ? "★" : "☆"}
                    </button>
                    {editIdx === i ? (
                      <input
                        type="text"
                        autoFocus
                        value={editVal}
                        onChange={(e) => setEditVal(e.target.value)}
                        onBlur={() => {
                          if (committedRef.current) {
                            committedRef.current = false;
                            setEditIdx(null);
                            return;
                          }
                          if (editVal.trim()) patch(i, { word: editVal.trim() });
                          setEditIdx(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            committedRef.current = true;
                            if (editVal.trim()) patch(i, { word: editVal.trim() });
                            setEditIdx(null);
                          }
                        }}
                        style={{ flex: 1 }}
                      />
                    ) : (
                      <span style={{ flex: 1 }}>
                        {d.word}
                        {d.autoLearned && (
                          <span className="sparkle" title="Auto-learned">
                            {" "}
                            ✨
                          </span>
                        )}
                      </span>
                    )}
                    <button
                      className="iconbtn"
                      title="Edit"
                      onClick={() => {
                        setEditIdx(i);
                        setEditVal(d.word);
                      }}
                    >
                      ✎
                    </button>
                    <button className="iconbtn" onClick={() => remove(i)} title="Delete">
                      🗑
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="empty">
              No words yet. Add names, jargon, and brand terms — they're sent to Whisper as
              recognition hints.
            </div>
          )}
        </div>
    </>
  );
}

/* ---------- Snippets ---------- */
function Snippets({ s, update }: { s: AppSettings; update: Update }) {
  const [trigger, setTrigger] = useState("");
  const [expansion, setExpansion] = useState("");
  const [editIdx, setEditIdx] = useState<number | null>(null);
  function add() {
    const t = trigger.trim();
    const e = expansion.trim();
    if (t && e) {
      // One expansion per trigger — duplicates would fire unpredictably.
      const duplicate = s.snippets.some(
        (sn, i) => sn.trigger.toLowerCase() === t.toLowerCase() && i !== editIdx
      );
      if (duplicate) return;
      if (editIdx !== null) {
        const next = [...s.snippets];
        next[editIdx] = { trigger: t, expansion: e };
        update({ snippets: next });
      } else {
        update({ snippets: [...s.snippets, { trigger: t, expansion: e }] });
      }
    }
    setTrigger("");
    setExpansion("");
    setEditIdx(null);
  }
  function edit(i: number) {
    const sn = s.snippets[i];
    setTrigger(sn.trigger);
    setExpansion(sn.expansion);
    setEditIdx(i);
  }
  function remove(i: number) {
    update({ snippets: s.snippets.filter((_, j) => j !== i) });
  }
  return (
    <>
      <h1>Snippets</h1>
      <p className="sub">Say a short trigger and Lirrly expands it into longer text.</p>
      <div className="card">
          <div className="row">
            <div className="meta">
              <label>Add snippet</label>
              <p>Trigger phrase → expansion. ⌘↵ to save.</p>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={trigger}
                placeholder="Trigger phrase"
                onChange={(e) => setTrigger(e.target.value)}
                style={{ minWidth: 130 }}
              />
              <input
                type="text"
                value={expansion}
                placeholder="Expansion text"
                onChange={(e) => setExpansion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add();
                }}
                style={{ minWidth: 160 }}
              />
              <button className="btn primary" onClick={add}>
                Add
              </button>
            </div>
          </div>
          {s.snippets.length > 0 ? (
            <ul className="list">
              {s.snippets.map((sn, i) => (
                <li key={`${sn.trigger}-${i}`}>
                  <span className="mono">{sn.trigger}</span>
                  <span className="arrow">→</span>
                  <span style={{ flex: 1, color: "var(--ink-70)" }}>{sn.expansion}</span>
                  <button className="iconbtn" onClick={() => edit(i)} title="Edit">
                    ✎
                  </button>
                  <button className="iconbtn" onClick={() => remove(i)} title="Delete">
                    🗑
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty">
              No snippets yet. Say a trigger and it expands — e.g. "my email" → you@example.com.
            </div>
          )}
        </div>
    </>
  );
}

/* ---------- Transforms ---------- */
function Transforms({ s, update }: { s: AppSettings; update: Update }) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const active = resolveActiveTransform(s);
  const shortcutKeys = s.shortcuts.transform?.length ? s.shortcuts.transform : ["⌥", "T"];

  function save() {
    const n = name.trim();
    const p = prompt.trim();
    if (!n || !p) return;
    if (editId !== null) {
      update({
        transforms: s.transforms.map((t) => (t.id === editId ? { ...t, name: n, prompt: p } : t)),
      });
    } else {
      update({
        transforms: [
          ...s.transforms,
          { id: `custom-${Date.now()}`, name: n, prompt: p, builtIn: false },
        ],
      });
    }
    setName("");
    setPrompt("");
    setEditId(null);
  }
  function edit(t: Transform) {
    setEditId(t.id);
    setName(t.name);
    setPrompt(t.prompt);
  }
  function remove(id: string) {
    if (editId === id) {
      setEditId(null);
      setName("");
      setPrompt("");
    }
    update({
      transforms: s.transforms.filter((t) => t.id !== id),
      // A deleted active transform falls back to the default built-in.
      ...(s.activeTransformId === id ? { activeTransformId: DEFAULTS.activeTransformId } : {}),
    });
  }

  return (
    <>
      <h1>Transforms</h1>
      <p className="sub">
        Select text in any app, press{" "}
        <span className="kbd" style={{ display: "inline-flex", verticalAlign: "middle" }}>
          {shortcutKeys.map((k) => (
            <span key={k}>{k}</span>
          ))}
        </span>{" "}
        and the active transform rewrites it in place. Dictation stays untouched — transforms run
        only when you ask. History rows have a ✨ action too.
      </p>
      <div className="card">
        <div className="row">
          <div className="meta">
            <label>{editId !== null ? "Edit transform" : "Add transform"}</label>
            <p>Name → instruction the AI applies. ⌘↵ to save.</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={name}
              placeholder="Name"
              onChange={(e) => setName(e.target.value)}
              style={{ minWidth: 110 }}
            />
            <input
              type="text"
              value={prompt}
              placeholder='Instruction, e.g. "Translate to English"'
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
              }}
              style={{ minWidth: 180 }}
            />
            <button className="btn primary" onClick={save}>
              {editId !== null ? "Save" : "Add"}
            </button>
          </div>
        </div>
        {s.transforms.map((t) => (
          <div className="row" key={t.id}>
            <div className="meta">
              <label>
                {t.name} {t.builtIn && <span className="pillstat muted">Built-in</span>}
              </label>
              <p>{t.prompt}</p>
            </div>
            {active.id === t.id ? (
              <span className="pillstat ok">Active</span>
            ) : (
              <button className="btn" onClick={() => update({ activeTransformId: t.id })}>
                Use
              </button>
            )}
            {!t.builtIn && (
              <button className="iconbtn" title="Edit" onClick={() => edit(t)}>
                ✎
              </button>
            )}
            {!t.builtIn && (
              <button className="iconbtn" onClick={() => remove(t.id)} title="Delete">
                🗑
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------- Styles ---------- */
const STYLE_LEVELS: { id: CleanupLevel; name: string; desc: string }[] = [
  { id: "none", name: "None", desc: "Raw transcript, exactly as heard." },
  { id: "light", name: "Light", desc: "Remove filler words (um, uh) and tidy spacing." },
  { id: "medium", name: "Medium", desc: "Fillers, punctuation, and obvious self-corrections." },
  { id: "high", name: "High", desc: "Full rewrite for clarity (keeps your voice)." },
];
const CHAT_MODELS = [
  { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant" },
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile" },
  { id: "gemma2-9b-it", label: "Gemma 2 9B" },
];
function Styles({ s, update }: { s: AppSettings; update: Update }) {
  const [ctx, setCtx] = useState<CtxKey>("personal");
  const level = s.cleanupByCtx[ctx];
  const setLevel = (l: CleanupLevel) => update({ cleanupByCtx: { ...s.cleanupByCtx, [ctx]: l } });
  return (
    <>
      <h1>Styles</h1>
      <p className="sub">How much Lirrly polishes your words — set independently per context.</p>
      <div className="tabs">
        {(["personal", "work", "email", "other"] as const).map((t) => (
          <button key={t} className={`tab ${ctx === t ? "active" : ""}`} onClick={() => setCtx(t)}>
            {t === "personal" ? "Personal Messages" : t === "work" ? "Work Messages" : t === "email" ? "Email" : "Other"}
          </button>
        ))}
      </div>
      <div className="cardgrid">
        {STYLE_LEVELS.map((lvl) => (
          <button
            key={lvl.id}
            className={`choice ${level === lvl.id ? "active" : ""}`}
            onClick={() => setLevel(lvl.id)}
          >
            <b>{lvl.name}</b>
            <p>{lvl.desc}</p>
          </button>
        ))}
      </div>
      <div className="card">
        <div className="row">
          <div className="meta">
            <label>AI cleanup layer</label>
            <p>Uses the same Groq key to polish medium and high cleanup after transcription.</p>
          </div>
          <Toggle on={s.cleanupAiEnabled} onClick={() => update({ cleanupAiEnabled: !s.cleanupAiEnabled })} />
        </div>
        <div className="row">
          <div className="meta">
            <label>Cleanup model</label>
            <p>Fast model first; larger model if you want heavier rewrites.</p>
          </div>
          <select value={s.cleanupModel} onChange={(e) => update({ cleanupModel: e.target.value })}>
            {CHAT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <div className="meta">
            <label>Fallback</label>
            <p>If AI cleanup fails, Lirrly still uses local deterministic cleanup and pastes your text.</p>
          </div>
          <span className="pillstat ok">Safe</span>
        </div>
      </div>
    </>
  );
}

/* ---------- Scratchpad ---------- */
function Scratchpad() {
  return (
    <>
      <h1>
        Scratchpad <span className="pillstat muted">In development</span>
      </h1>
      <p className="sub">A quick place to capture thoughts while you dictate.</p>
      <div className="card">
        <div className="row">
          <div className="meta">
            <label>Open shortcut</label>
            <p>Open the scratchpad from anywhere.</p>
          </div>
          <div className="kbd">
            <span>⌥</span>
            <span>S</span>
          </div>
        </div>
        <div className="row">
          <div className="meta">
            <label>Multiple tabs</label>
            <p>Keep several notes open at once.</p>
          </div>
          <span className="pillstat muted">Coming soon</span>
        </div>
        <div className="row">
          <div className="meta">
            <label>Version history</label>
            <p>Restore any past version of a note.</p>
          </div>
          <span className="pillstat muted">Coming soon</span>
        </div>
        <div className="row">
          <div className="meta">
            <label>Image support</label>
            <p>Paste or drag images into notes.</p>
          </div>
          <span className="pillstat muted">Coming soon</span>
        </div>
      </div>
    </>
  );
}

/* ---------- Insights ---------- */
function Insights() {
  const [tab, setTab] = useState("usage");
  const [hist, setHist] = useState<HistoryItem[]>([]);
  useEffect(() => {
    void loadHistory().then(setHist);
  }, []);
  const words = hist.reduce((a, h) => a + wordCount(h.text), 0);
  const byDay: Record<string, number> = {};
  for (const h of hist) {
    // Local-timezone day keys — UTC keys put evening dictations on the wrong day.
    const key = localDateKey(h.at);
    byDay[key] = (byDay[key] || 0) + 1;
  }
  const maxDay = Math.max(1, ...Object.values(byDay));
  const cells = Array.from({ length: 84 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (83 - i));
    const key = localDateKey(d.getTime());
    return { key, count: byDay[key] || 0 };
  });
  const hourCounts = Array.from<number>({ length: 24 }).fill(0);
  hist.forEach((h) => hourCounts[new Date(h.at).getHours()]++);
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));
  const peakFmt = new Date(0, 0, 0, peakHour).toLocaleTimeString([], { hour: "numeric" });
  const milestones = [1000, 10000, 100000];
  const nextMs = milestones.find((m) => words < m) ?? 100000;

  return (
    <>
      <h1>Insights</h1>
      <p className="sub">Your dictation, by the numbers.</p>
      <div className="tabs">
        {[
          ["usage", "Your Usage"],
          ["voice", "Your Voice"],
        ].map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {hist.length === 0 && (
        <div className="card">
          <div className="empty">Nothing to show yet — dictate a few times and your stats appear here.</div>
        </div>
      )}
      {tab === "usage" && (
        <>
          <div className="stats">
            <div className="stat">
              <div className="n">{words.toLocaleString()}</div>
              <div className="k">Words all-time</div>
            </div>
            <div className="stat">
              <div className="n">{hist.length}</div>
              <div className="k">Total dictations</div>
            </div>
            <div className="stat">
              <div className="n">{Math.round((words / 40) * 60) || 0}</div>
              <div className="k">~Seconds of typing saved</div>
            </div>
          </div>
          <div className="card" style={{ padding: "20px 22px" }}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>Last 12 weeks</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(12, 1fr)",
                gridTemplateRows: "repeat(7, 1fr)",
                gridAutoFlow: "column",
                gap: 4,
              }}
            >
              {cells.map((c) => (
                <div
                  key={c.key}
                  title={`${c.key}: ${c.count} dictations`}
                  style={{
                    aspectRatio: "1",
                    borderRadius: 3,
                    background: "var(--teal)",
                    opacity: c.count ? 0.18 + 0.82 * (c.count / maxDay) : 0.07,
                  }}
                />
              ))}
            </div>
          </div>
        </>
      )}
      {tab === "voice" && (
        <div className="card">
          <div className="row">
            <div className="meta">
              <label>Words toward next milestone</label>
              <p>
                {words.toLocaleString()} / {nextMs.toLocaleString()}
              </p>
            </div>
            <div style={{ width: 160, height: 6, background: "var(--sand)", borderRadius: 3 }}>
              <div
                style={{
                  width: `${Math.min(100, (words / nextMs) * 100)}%`,
                  height: "100%",
                  background: "var(--teal)",
                  borderRadius: 3,
                }}
              />
            </div>
          </div>
          <div className="row">
            <div className="meta">
              <label>Peak dictation time</label>
              <p>When you dictate most.</p>
            </div>
            <span style={{ color: "var(--ink)", fontWeight: 600 }}>{hist.length ? peakFmt : "—"}</span>
          </div>
          <div className="row">
            <div className="meta">
              <label>Persona &amp; share card</label>
              <p>Unlocks at 1,000 words.</p>
            </div>
            <span className="pillstat muted">Coming soon</span>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------- Shortcuts (click-to-record) ---------- */
const SHORTCUT_ACTIONS: { key: string; label: string; implemented: boolean }[] = [
  { key: "dictation", label: "Dictation", implemented: true },
  { key: "transform", label: "Transform selection", implemented: true },
  { key: "commandMode", label: "Command mode", implemented: false },
  { key: "scratchpad", label: "Scratchpad", implemented: false },
];
// Single source of truth — the store's defaults drive Reset too.
const DEFAULT_SHORTCUTS = DEFAULTS.shortcuts;

function ShortcutsPanel({ s, update }: { s: AppSettings; update: Update }) {
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState("");
  const sRef = useRef(s);
  useEffect(() => {
    sRef.current = s;
  }, [s]);

  async function applyCombo(action: string, combo: string[]) {
    setError("");
    const accelerator = symbolsToAccelerator(combo);
    if (!accelerator) {
      setError("Add a regular key, not just modifiers.");
      return;
    }
    if (hasTauriRuntime() && (action === "dictation" || action === "transform")) {
      try {
        await invoke("update_shortcut", { action, accelerator });
      } catch {
        // Registration failed (likely a system conflict) — old binding stays live.
        setError("That combination isn't available — kept the previous shortcut.");
        return;
      }
    }
    update({ shortcuts: { ...sRef.current.shortcuts, [action]: combo } });
  }

  useEffect(() => {
    if (!recording) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      if (["Meta", "Shift", "Alt", "Control"].includes(e.key)) return;
      const combo = [
        ...(e.metaKey ? ["⌘"] : []),
        ...(e.shiftKey ? ["⇧"] : []),
        ...(e.altKey ? ["⌥"] : []),
        ...(e.ctrlKey ? ["⌃"] : []),
        e.key.length === 1 ? e.key.toUpperCase() : e.key,
      ];
      void applyCombo(recording, combo);
      setRecording(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  return (
    <>
      <h1>Shortcuts</h1>
      <p className="sub">Click a shortcut, then press the keys you want.</p>
      {error && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <div className="row">
            <div className="meta">
              <label style={{ color: "var(--danger)" }}>{error}</label>
            </div>
          </div>
        </div>
      )}
      <div className="card">
        {SHORTCUT_ACTIONS.map((a) => {
          const keys = s.shortcuts[a.key] ?? [];
          return (
            <div className="row" key={a.key}>
              <div className="meta">
                <label>
                  {a.label}{" "}
                  {!a.implemented && <span className="pillstat muted">Coming soon</span>}
                </label>
              </div>
              <button
                className="kbd"
                style={{
                  border: "none",
                  background: "none",
                  cursor: a.implemented ? "pointer" : "default",
                  opacity: a.implemented ? 1 : 0.5,
                }}
                disabled={!a.implemented}
                onClick={() => a.implemented && setRecording(a.key)}
              >
                {recording === a.key ? (
                  <span style={{ color: "var(--teal)", fontWeight: 600, fontSize: 13 }}>Press keys…</span>
                ) : keys.length ? (
                  keys.map((k) => <span key={k}>{k}</span>)
                ) : (
                  <span style={{ color: "var(--ink-35)", fontSize: 13 }}>Click to add</span>
                )}
              </button>
            </div>
          );
        })}
        <div className="row">
          <button
            className="btn"
            onClick={() => {
              void applyCombo("dictation", DEFAULT_SHORTCUTS.dictation);
              void applyCombo("transform", DEFAULT_SHORTCUTS.transform);
              update({ shortcuts: { ...DEFAULT_SHORTCUTS } });
            }}
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </>
  );
}

/* ---------- Settings (General + Engine) ---------- */
const MODELS = [
  { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo" },
  { id: "whisper-large-v3", label: "Whisper Large v3" },
  { id: "distil-whisper-large-v3-en", label: "Distil Whisper v3 (English)" },
];
function General({ s, update, onJump }: { s: AppSettings; update: Update; onJump: (x: Section) => void }) {
  const [key, setKey] = useState("");
  // Browser previews read the legacy field; the real app asks the Keychain.
  const [hasKey, setHasKey] = useState(
    () => !hasTauriRuntime() && s.groqApiKey.trim().length > 0
  );
  const [keyError, setKeyError] = useState("");
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([]);
  const notif = s.notifications;

  useEffect(() => {
    if (hasTauriRuntime()) void invoke<boolean>("has_api_key").then(setHasKey);
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) =>
        setMics(
          devices
            .filter((device) => device.kind === "audioinput" && device.label)
            .map((device) => ({ deviceId: device.deviceId, label: device.label }))
        )
      )
      .catch(() => {});
    // The OS owns launch-at-login state — reflect it rather than trusting ours.
    if (hasTauriRuntime()) {
      void autostartEnabled()
        .then((en) => {
          if (en !== s.launchAtLogin) update({ launchAtLogin: en });
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggleAutostart() {
    const next = !s.launchAtLogin;
    if (hasTauriRuntime()) {
      try {
        if (next) await enableAutostart();
        else await disableAutostart();
      } catch {
        return; // the OS refused — keep the toggle truthful
      }
    }
    update({ launchAtLogin: next });
  }

  async function saveKey() {
    const k = key.trim();
    setKeyError("");
    if (!hasTauriRuntime()) {
      // Browser design-preview only — the real app stores in the Keychain.
      update({ groqApiKey: k });
      setHasKey(k.length > 0);
      return;
    }
    try {
      await invoke("set_api_key", { key: k });
      setHasKey(k.length > 0);
      setKey("");
    } catch {
      setKeyError("Couldn't save to the Keychain — try again.");
    }
  }
  function loadMicsOnFocus(): void {
    if (!mics.length) void listMicrophones().then(setMics).catch(() => {});
  }
  return (
    <>
      <h1>Settings</h1>
      <p className="sub">Activation, microphone, and how Lirrly runs.</p>

      <div className="card">
        <div className="row">
          <div className="meta">
            <label>Dictation shortcut</label>
            <p>Toggle dictation from anywhere.</p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div className="kbd">
              {(s.shortcuts.dictation ?? ["⌘", "⇧", "D"]).map((k) => (
                <span key={k}>{k}</span>
              ))}
            </div>
            <button className="btn" onClick={() => onJump("shortcuts")}>
              Change
            </button>
          </div>
        </div>
        <div className="row">
          <div className="meta">
            <label>Microphone</label>
            <p>
              {mics.length
                ? "Input device used for dictation."
                : "Devices appear after the first microphone grant."}
            </p>
          </div>
          <select
            value={s.selectedMicId}
            onFocus={loadMicsOnFocus}
            onChange={(e) => update({ selectedMicId: e.target.value })}
          >
            <option value="">System Default</option>
            {mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <div className="meta">
            <label>Show Lirrly bar at all times</label>
            <p>Keep the pill visible, or only while dictating.</p>
          </div>
          <Toggle
            on={s.showFlowBar}
            onClick={() => {
              const next = !s.showFlowBar;
              update({ showFlowBar: next });
              void invoke(next ? "show_flowbar" : "hide_flowbar");
            }}
          />
        </div>
        <div className="row">
          <div className="meta">
            <label>Lirrly bar opacity</label>
            <p>How visible the pill is when idle.</p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="range"
              min={20}
              max={100}
              step={5}
              value={s.flowBarOpacity}
              onChange={(e) => update({ flowBarOpacity: Number(e.target.value) })}
            />
            <span style={{ fontSize: 13, color: "var(--ink-55)", minWidth: 36 }}>{s.flowBarOpacity}%</span>
          </div>
        </div>
        <div className="row">
          <div className="meta">
            <label>Launch at login</label>
            <p>Start Lirrly automatically.</p>
          </div>
          <Toggle on={s.launchAtLogin} onClick={() => void toggleAutostart()} />
        </div>
        <div className="row">
          <div className="meta">
            <label>Language</label>
            <p>Force a language or let Lirrly detect it.</p>
          </div>
          <select value={s.language} onChange={(e) => update({ language: e.target.value })}>
            {LANGS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Engine — Lirrly keeps the AI provider swappable */}
      <div className="card">
        <div className="row">
          <div className="meta">
            <label>Engine</label>
            <p>Transcription provider. Cloud now; local AI swappable later.</p>
          </div>
          <select value={s.provider} onChange={(e) => update({ provider: e.target.value })}>
            <option value="groq">Groq · cloud</option>
            <option value="local" disabled>
              Local (coming soon)
            </option>
          </select>
        </div>
        <div className="row">
          <div className="meta">
            <label>Groq API key</label>
            <p>{keyError || "Stored in the macOS Keychain. Free at console.groq.com."}</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="password"
              placeholder={hasKey ? "saved — paste to replace" : "gsk_…"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveKey()}
            />
            <button className="btn primary" onClick={() => void saveKey()}>
              Save
            </button>
          </div>
        </div>
        <div className="row">
          <div className="meta">
            <label>Model</label>
            <p>
              {s.language === "ar" && s.model === "whisper-large-v3-turbo"
                ? "Tip: Large v3 is noticeably stronger for Arabic dialects."
                : "Turbo is the best speed/quality balance."}
            </p>
          </div>
          <select value={s.model} onChange={(e) => update({ model: e.target.value })}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <div className="meta">
            <label>Key status</label>
            <p>Required before transcription works.</p>
          </div>
          <span className={`pillstat ${hasKey ? "ok" : "warn"}`}>{hasKey ? "Saved" : "Not set"}</span>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div className="meta">
            <label>Errors &amp; failures</label>
            <p>Alert when a dictation fails and the Lirrly bar is hidden.</p>
          </div>
          <Toggle on={notif.errors} onClick={() => update({ notifications: { ...notif, errors: !notif.errors } })} />
        </div>
        <div className="row">
          <div className="meta">
            <label>Milestones</label>
            <p>Celebrate dictation-count milestones in the Lirrly bar.</p>
          </div>
          <Toggle
            on={notif.milestones}
            onClick={() => update({ notifications: { ...notif, milestones: !notif.milestones } })}
          />
        </div>
        <div className="row">
          <div className="meta">
            <label>
              App updates <span className="pillstat muted">Coming soon</span>
            </label>
            <p>Be notified when a new version is available.</p>
          </div>
          <span style={{ opacity: 0.45, pointerEvents: "none" }}>
            <Toggle on={notif.updates} onClick={() => {}} />
          </span>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <div className="meta">
            <label>Permissions</label>
            <p>Lirrly needs Microphone + Accessibility (to paste).</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn"
              onClick={() => {
                void openUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
              }}
            >
              Microphone
            </button>
            <button
              className="btn"
              onClick={() => {
                void openUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
              }}
            >
              Accessibility
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------- Account ---------- */
function Account({ s, update }: { s: AppSettings; update: Update }) {
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (hasTauriRuntime()) void getVersion().then(setVersion).catch(() => {});
  }, []);
  return (
    <>
      <h1>Account</h1>
      <p className="sub">Your profile and privacy.</p>
      <div className="card">
        <div className="row">
          <div className="meta">
            <label>Name</label>
            <p>Shown in the sidebar and insights.</p>
          </div>
          <input
            type="text"
            value={s.displayName}
            placeholder="Your name"
            onChange={(e) => update({ displayName: e.target.value })}
            style={{ minWidth: 200 }}
          />
        </div>
        <div className="row">
          <div className="meta">
            <label>Plan</label>
            <p>Local-first, open source. No subscription.</p>
          </div>
          <span className="pillstat ok">Free · local</span>
        </div>
      </div>
      <div className="card">
        <div className="row">
          <div className="meta">
            <label>Store history locally</label>
            <p>Transcriptions are kept on this Mac only.</p>
          </div>
          <Toggle on={s.storeHistory} onClick={() => update({ storeHistory: !s.storeHistory })} />
        </div>
        <div className="row">
          <div className="meta">
            <label>Share anonymous usage data</label>
            <p>Nothing is collected yet — this saves your preference for when analytics exist.</p>
          </div>
          <Toggle on={s.shareAnalytics} onClick={() => update({ shareAnalytics: !s.shareAnalytics })} />
        </div>
      </div>
      <div className="card">
        <div className="row">
          <div className="meta">
            <label>Version</label>
            <p>Lirrly {version || "—"} · early build</p>
          </div>
        </div>
      </div>
    </>
  );
}
