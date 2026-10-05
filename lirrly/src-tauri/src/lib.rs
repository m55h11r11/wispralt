// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 mshrmnsr

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex as TokioMutex;

const KEYCHAIN_SERVICE: &str = "com.mshrmnsr.lirrly";
const DEFAULT_DICTATION_ACCELERATOR: &str = "CommandOrControl+Shift+D";
const DEFAULT_TRANSFORM_ACCELERATOR: &str = "Alt+T";
const REPO_URL: &str = "https://github.com/m55h11r11/wispralt";

/// Currently-registered global shortcuts, action → accelerator.
struct ShortcutRegistry(Mutex<HashMap<String, String>>);
/// Most recent final transcript, kept for the tray's "Paste last transcript".
struct LastTranscript(Mutex<String>);
/// Serializes clipboard writes + synthetic paste so concurrent requests never race.
struct PasteLock(TokioMutex<()>);
/// Tray paste item handle so it can be enabled after the first dictation.
struct PasteMenuItemHandle(MenuItem<tauri::Wry>);
/// Serializes every history mutation. See `with_history`.
struct HistoryLock(Mutex<()>);

fn keychain() -> lirrly_core::Keychain {
    lirrly_core::Keychain::new(KEYCHAIN_SERVICE)
}

/// Load the Groq key from the macOS Keychain. The key never reaches the webview.
fn load_api_key() -> Result<String, String> {
    keychain().load()
}

/// Whether a key is saved — the webview only ever learns yes/no, never the key.
#[tauri::command]
fn has_api_key() -> bool {
    keychain().has()
}

/// Save (or clear, when empty) the Groq key in the macOS Keychain.
#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    keychain().set(&key)
}

/// True when the app is trusted for Accessibility (required to synthesize ⌘V).
#[tauri::command]
fn check_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    return macos_accessibility_client::accessibility::application_is_trusted();
    #[cfg(not(target_os = "macos"))]
    true
}

/// Same check, but asks macOS to show its grant prompt when not yet trusted.
#[tauri::command]
fn request_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    return macos_accessibility_client::accessibility::application_is_trusted_with_prompt();
    #[cfg(not(target_os = "macos"))]
    true
}

/// Open a specific macOS privacy pane. Narrow on purpose: the flowbar window
/// holds no general `opener` permission, so it can only reach these two panes.
fn privacy_pane_url(pane: &str) -> Result<&'static str, String> {
    match pane {
        "microphone" => {
            Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        }
        "accessibility" => {
            Ok("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        }
        _ => Err("unknown_pane".into()),
    }
}

#[tauri::command]
fn open_privacy_pane(app: AppHandle, pane: String) -> Result<(), String> {
    let url = privacy_pane_url(&pane)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Transcribe an audio clip via the Groq Whisper API.
/// Done in Rust (not the webview) to keep the API key off the page and dodge CORS.
#[tauri::command]
async fn transcribe(
    audio_b64: String,
    mime: String,
    model: String,
    language: Option<String>,
    prompt: Option<String>,
) -> Result<String, String> {
    let api_key = load_api_key()?;
    lirrly_core::transcribe(api_key, audio_b64, mime, model, language, prompt).await
}

/// LLM cleanup layer: turns a raw transcript into readable prose while keeping meaning intact.
#[tauri::command]
async fn cleanup_text(
    text: String,
    model: String,
    level: String,
    language: Option<String>,
    context: Option<String>,
) -> Result<String, String> {
    let api_key = load_api_key()?;
    lirrly_core::cleanup_text(api_key, text, model, level, language, context).await
}

/// Apply a user-defined transform instruction to arbitrary text (⌥T on a
/// selection, or the ✨ action in History).
#[tauri::command]
async fn transform_text(
    text: String,
    prompt: String,
    model: String,
    language: Option<String>,
) -> Result<String, String> {
    let api_key = load_api_key()?;
    lirrly_core::transform_text(api_key, text, prompt, model, language).await
}

/// The transform shortcut fires on key-down, so the user is usually still
/// holding ⌥ when the synthetic ⌘C goes out. Held modifiers can turn it into a
/// different command in the target app (⌥⌘C is "Copy Style" in many editors),
/// which leaves the selection uncopied — the intermittent ⌥T failure seen on
/// 0.4.2. Capture waits for them to lift, but only this long: someone may keep
/// a key down on purpose, and then the copy goes ahead as before.
const MODIFIER_RELEASE_WAIT: Duration = Duration::from_millis(700);
/// How long the frontmost app gets to put the selection on the pasteboard.
/// Slower (Electron/web) apps can take several hundred milliseconds.
const SELECTION_COPY_WAIT: Duration = Duration::from_millis(1000);

/// Only ⇧⌃⌥⌘ form shortcuts. Caps Lock is a toggle that can stay on for hours,
/// and the Fn/keypad/help flags never change what ⌘C means.
#[cfg(target_os = "macos")]
fn holds_shortcut_modifier(flags: objc2_app_kit::NSEventModifierFlags) -> bool {
    use objc2_app_kit::NSEventModifierFlags as Flags;
    flags.intersects(Flags::Shift | Flags::Control | Flags::Option | Flags::Command)
}

#[cfg(target_os = "macos")]
async fn wait_for_modifier_release() {
    // The class method reads the live keyboard state, not the event stream,
    // so it is current from any thread.
    let held = || holds_shortcut_modifier(objc2_app_kit::NSEvent::modifierFlags_class());
    let deadline = std::time::Instant::now() + MODIFIER_RELEASE_WAIT;
    while held() && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
}

/// Copy the current selection in the frontmost app (synthetic ⌘C) and return
/// it, restoring the user's clipboard afterwards. A sentinel marks "nothing
/// copied yet" so an empty selection is detected instead of returning stale
/// clipboard content. The prior pasteboard is snapshotted with every type it
/// declares (images, files, rich text) and put back whole — audit A18.
#[tauri::command]
async fn capture_selection(app: AppHandle) -> Result<String, String> {
    let state = app.state::<PasteLock>();
    let _guard = state.0.try_lock().map_err(|_| "paste_busy".to_string())?;
    if !check_accessibility() {
        return Err("accessibility_not_granted".into());
    }
    #[cfg(target_os = "macos")]
    wait_for_modifier_release().await;

    use tauri_plugin_clipboard_manager::ClipboardExt;
    // Zero-width-wrapped so it can never equal text the user copied. It is
    // visible text if it stays on the pasteboard, so every exit below either
    // puts the user's pasteboard back or clears it (audit A40).
    const SENTINEL: &str = "\u{200B}lirrly-selection-sentinel\u{200B}";
    // Full-fidelity snapshot: images/files/rich text survive the round-trip (A18).
    let previous = pasteboard::snapshot();
    app.clipboard()
        .write_text(SENTINEL.to_string())
        .map_err(|e| e.to_string())?;
    let ours = pasteboard::change_count();
    // Restore the user's pasteboard. A snapshot too large to keep cannot be
    // restored; then at least what this flow put there — the sentinel, or the
    // copied selection, last written at change count `mine` — must not be
    // left behind for the user to paste.
    let put_back = |previous: &pasteboard::Saved, mine: isize| {
        if !pasteboard::restore(previous) && pasteboard::change_count() == mine {
            pasteboard::clear();
        }
    };
    tokio::time::sleep(Duration::from_millis(60)).await;

    let mut clicked = false;
    let copy_error = send_copy_keystroke(&mut clicked).err();
    if let Some(e) = &copy_error {
        if !clicked {
            // The keystroke never happened, so nothing replaced the sentinel.
            if pasteboard::change_count() == ours {
                put_back(&previous, ours);
            }
            return Err(e.clone());
        }
        // ⌘C went out but releasing ⌘ failed: the copy can still land, so it
        // is read and cleaned up like any other.
    }

    // Apps write the pasteboard asynchronously — poll until the sentinel is
    // replaced. Any text counts here, a blank selection's too: it came from
    // our ⌘C, so the user's pasteboard must still go back over it.
    // The change count is sampled before each read, so it can only be older
    // than the text read: a write landing in between makes the clear below
    // skip (leaving content) rather than wipe something that isn't ours.
    let mut copied: Option<String> = None;
    let mut seen = ours;
    const POLL: Duration = Duration::from_millis(40);
    for _ in 0..(SELECTION_COPY_WAIT.as_millis() / POLL.as_millis()) {
        tokio::time::sleep(POLL).await;
        seen = pasteboard::change_count();
        if let Ok(now) = app.clipboard().read_text() {
            if now != SENTINEL {
                copied = Some(now);
                break;
            }
        }
    }

    // The copied text has been read out, so the ⌘C result is consumed — put
    // the user's original pasteboard back, whatever its types were. On a
    // timeout with no new write, restoring also clears the sentinel. Only when
    // something non-text appeared (count moved but no text) does the
    // pasteboard keep that newer content.
    if copied.is_some() {
        put_back(&previous, seen);
    } else if pasteboard::change_count() == ours {
        put_back(&previous, ours);
    }
    match copied.filter(|text| !text.trim().is_empty()) {
        Some(text) => Ok(text),
        None => Err(copy_error.unwrap_or_else(|| "no_selection".to_string())),
    }
}

/// Sends ⌘C to the frontmost app. `clicked` turns true once the C itself went
/// out, after which the copy may land even if releasing ⌘ then fails.
fn send_copy_keystroke(clicked: &mut bool) -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    enigo
        .key(Key::Meta, Direction::Press)
        .map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('c'), Direction::Click)
        .map_err(|e| e.to_string())?;
    *clicked = true;
    enigo
        .key(Key::Meta, Direction::Release)
        .map_err(|e| e.to_string())
}

/// Opt-in insights endpoint (self-hosted). The client only ever posts here when
/// the user has turned on "share analytics" — see `shareAnalytics` in the app.
const INSIGHTS_URL: &str = "https://insights.lirrly.com";

/// Coarse macOS product version (e.g. "14.5") for grouping reports. Best-effort.
fn os_version() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Send an opt-in, anonymized crash/error report. No-op unless `enabled`.
/// Fire-and-forget: failures are swallowed so telemetry can never disrupt the app.
#[tauri::command]
async fn report_event(
    enabled: bool,
    install_id: String,
    kind: String,
    signature: Option<String>,
    message: Option<String>,
    context: Option<String>,
) -> Result<(), String> {
    if !enabled {
        return Ok(());
    }
    let payload = json!({
        "install_id": install_id,
        "app_version": env!("CARGO_PKG_VERSION"),
        "os_version": os_version(),
        "kind": kind,
        "signature": signature,
        "message": message,
        "context": context,
    });
    if let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        let _ = client
            .post(format!("{INSIGHTS_URL}/v1/report"))
            .json(&payload)
            .send()
            .await;
    }
    Ok(())
}

/// Send user-initiated feedback. Unlike reports this surfaces success/failure so
/// the UI can confirm. Carries only what the user typed (+ optional email/rating).
#[tauri::command]
async fn send_feedback(
    install_id: String,
    message: String,
    email: Option<String>,
    rating: Option<u8>,
) -> Result<(), String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("empty_feedback".into());
    }
    let payload = json!({
        "install_id": install_id,
        "app_version": env!("CARGO_PKG_VERSION"),
        "os_version": os_version(),
        "message": message,
        "email": email,
        "rating": rating,
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{INSIGHTS_URL}/v1/feedback"))
        .json(&payload)
        .send()
        .await
        .map_err(|_| "network".to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("server_{}", resp.status().as_u16()))
    }
}

/// Webview event fired by each shortcut action; `None` marks unknown actions.
fn shortcut_event_for_action(action: &str) -> Option<&'static str> {
    match action {
        "dictation" => Some("toggle-dictation"),
        "transform" => Some("run-transform"),
        _ => None,
    }
}

fn default_accelerator_for(action: &str) -> &'static str {
    match action {
        "transform" => DEFAULT_TRANSFORM_ACCELERATOR,
        _ => DEFAULT_DICTATION_ACCELERATOR,
    }
}

fn register_action_shortcut(
    app: &AppHandle,
    action: &str,
    accelerator: &str,
) -> Result<(), String> {
    let event =
        shortcut_event_for_action(action).ok_or_else(|| "unsupported_action".to_string())?;
    app.global_shortcut()
        .on_shortcut(accelerator, move |app, _shortcut, e| {
            if e.state() == ShortcutState::Pressed {
                let _ = app.emit(event, ());
            }
        })
        .map_err(|e| e.to_string())
}

/// Rebind a global shortcut at runtime (dictation toggle or transform).
/// On a failed registration (e.g. conflict) the previous binding is restored,
/// so the hotkey can never end up dead.
#[tauri::command]
fn update_shortcut(app: AppHandle, action: String, accelerator: String) -> Result<(), String> {
    if shortcut_event_for_action(&action).is_none() {
        return Err("unsupported_action".into());
    }
    let accelerator = accelerator.trim().to_string();
    if accelerator.is_empty() {
        return Err("empty_accelerator".into());
    }

    let registry = app.state::<ShortcutRegistry>();
    let mut map = registry
        .0
        .lock()
        .map_err(|_| "state_poisoned".to_string())?;
    // SAFETY: critical section held across unregister+register; concurrent JS calls queue here.
    if let Some(old) = map.get(&action) {
        if *old == accelerator {
            return Ok(());
        }
        // If the old binding cannot be removed it is still live; registering
        // the new one too would leave two hotkeys firing and a registry that
        // knows only one of them. Keep the old binding instead.
        app.global_shortcut()
            .unregister(old.as_str())
            .map_err(|e| e.to_string())?;
    }

    match register_action_shortcut(&app, &action, &accelerator) {
        Ok(()) => {
            map.insert(action, accelerator);
            Ok(())
        }
        Err(e) => {
            // Put back what was live before, or the default when nothing was.
            // The registry only ever records a binding that actually registered
            // (audit A38): a recorded-but-dead hotkey made re-saving the same
            // shortcut a silent no-op, so it could never be revived.
            let fallback = map
                .get(&action)
                .cloned()
                .unwrap_or_else(|| default_accelerator_for(&action).to_string());
            if register_action_shortcut(&app, &action, &fallback).is_ok() {
                map.insert(action, fallback);
            } else {
                map.remove(&action);
            }
            Err(e)
        }
    }
}

/// Full-fidelity pasteboard snapshot/restore (audit A18). The old restore kept
/// only nonempty plain text — an image, file or rich-text clipboard was simply
/// destroyed by a dictation — and it wrote the old text back even when the user
/// had copied something newer in the meantime. This preserves every item's raw
/// data per type, and `restore` is gated on `changeCount` so a newer copy wins.
#[cfg(target_os = "macos")]
mod pasteboard {
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem};
    use objc2_foundation::{NSArray, NSData, NSString};

    /// Above this, restoring is skipped rather than doubling a huge clipboard
    /// in memory; the user's copy is then lost, as before A18. 8 MB skipped
    /// the most common rich clipboard of all — a copied photo, whose TIFF data
    /// is often larger (audit A40). The copy is held for about a second.
    const MAX_SAVED_BYTES: usize = 64 * 1024 * 1024;

    pub struct Saved {
        items: Vec<Vec<(String, Vec<u8>)>>,
        pub restorable: bool,
    }

    pub fn change_count() -> isize {
        NSPasteboard::generalPasteboard().changeCount()
    }

    /// Capture every pasteboard item's data for every type it declares.
    pub fn snapshot() -> Saved {
        let mut items_out: Vec<Vec<(String, Vec<u8>)>> = Vec::new();
        let mut total = 0usize;
        let pb = NSPasteboard::generalPasteboard();
        if let Some(items) = pb.pasteboardItems() {
            for item in items.iter() {
                let mut entry: Vec<(String, Vec<u8>)> = Vec::new();
                for ty in item.types().iter() {
                    if let Some(data) = item.dataForType(&ty) {
                        let bytes = data.to_vec();
                        total += bytes.len();
                        if total > MAX_SAVED_BYTES {
                            return Saved {
                                items: Vec::new(),
                                restorable: false,
                            };
                        }
                        entry.push((ty.to_string(), bytes));
                    }
                }
                if !entry.is_empty() {
                    items_out.push(entry);
                }
            }
        }
        Saved {
            items: items_out,
            restorable: true,
        }
    }

    /// Empty the pasteboard (used when a snapshot was too large to restore).
    pub fn clear() {
        NSPasteboard::generalPasteboard().clearContents();
    }

    /// Write the snapshot back. Callers must have checked `changeCount` first;
    /// an empty snapshot restores an empty pasteboard.
    pub fn restore(saved: &Saved) -> bool {
        if !saved.restorable {
            return false;
        }
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        if saved.items.is_empty() {
            return true;
        }
        let objects: Vec<_> = saved
            .items
            .iter()
            .map(|entry| {
                let item = NSPasteboardItem::new();
                for (ty, bytes) in entry {
                    let data = NSData::with_bytes(bytes);
                    let ty = NSString::from_str(ty);
                    item.setData_forType(&data, &ty);
                }
                ProtocolObject::from_retained(item)
            })
            .collect();
        pb.writeObjects(&NSArray::from_retained_slice(&objects))
    }
}

/// Non-macOS shim so the crate still type-checks off-platform; the app ships
/// on macOS only.
#[cfg(not(target_os = "macos"))]
mod pasteboard {
    pub struct Saved {
        pub restorable: bool,
    }
    pub fn change_count() -> isize {
        0
    }
    pub fn snapshot() -> Saved {
        Saved { restorable: false }
    }
    pub fn restore(_saved: &Saved) -> bool {
        false
    }
    pub fn clear() {}
}

/// Bundle id of the app currently receiving key events, when macOS reports one.
/// Safe off the main thread; AppKit refreshes the value as the app's run loop spins.
fn frontmost_bundle_id() -> Option<String> {
    #[cfg(target_os = "macos")]
    return objc2_app_kit::NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .and_then(|running| running.bundleIdentifier())
        .map(|id| id.to_string());
    #[cfg(not(target_os = "macos"))]
    None
}

/// Where a result should land: the app in front when the user finished speaking
/// or asked for a transform. `None` when macOS reports nothing or reports Lirrly
/// itself (the bar was clicked) — there is then nothing meaningful to compare.
#[tauri::command]
fn paste_target(app: AppHandle) -> Option<String> {
    frontmost_bundle_id().filter(|id| *id != app.config().identifier)
}

/// Whether a result meant for `expected` may be pasted with `current` in front.
/// No expectation means no check (tray re-paste, or the target was unknown). An
/// unknown current app counts as a change: pasting blind is what this prevents.
fn paste_target_matches(expected: Option<&str>, current: Option<&str>) -> bool {
    match expected {
        None => true,
        Some(expected) => current == Some(expected),
    }
}

/// Put text on the clipboard, paste it into the frontmost app (Cmd+V), then
/// restore the previous clipboard so dictation doesn't clobber a user copy.
/// Async so the inter-keystroke waits never block the main thread.
///
/// Without Accessibility the synthetic ⌘V is impossible, but the transcript is
/// still written to the clipboard and deliberately *not* restored away, so the
/// user can paste it by hand — which is exactly what onboarding promises. That
/// case returns `accessibility_not_granted_copied`: the words are safe, only
/// the automatic insertion failed. Returning before writing the clipboard, as
/// this did until 0.4.2, silently destroyed the dictation instead.
///
/// Transcription and transforms take seconds, and people switch apps while they
/// wait. When `target` is given and a different app is now in front, the text is
/// left on the clipboard the same way and `target_changed_copied` is returned —
/// typing a transcript into the wrong window is the one outcome a user cannot
/// easily notice or undo.
async fn perform_paste(
    app: &AppHandle,
    text: String,
    target: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    // Full-fidelity snapshot: an image/file/rich-text clipboard used to be
    // destroyed by a dictation because only plain text was saved (audit A18).
    let previous = pasteboard::snapshot();
    app.clipboard()
        .write_text(text)
        .map_err(|e| e.to_string())?;
    let ours = pasteboard::change_count();

    if !check_accessibility() {
        return Err("accessibility_not_granted_copied".into());
    }

    tokio::time::sleep(Duration::from_millis(120)).await;

    // Permission can be revoked mid-flight. The transcript is already on the
    // clipboard; keep it there rather than restoring the old contents over it.
    if !check_accessibility() {
        return Err("accessibility_not_granted_copied".into());
    }
    // Checked as late as possible, immediately before the keystroke.
    if !paste_target_matches(target.as_deref(), frontmost_bundle_id().as_deref()) {
        return Err("target_changed_copied".into());
    }

    {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        enigo
            .key(Key::Meta, Direction::Press)
            .map_err(|e| e.to_string())?;
        enigo
            .key(Key::Unicode('v'), Direction::Click)
            .map_err(|e| e.to_string())?;
        enigo
            .key(Key::Meta, Direction::Release)
            .map_err(|e| e.to_string())?;
    }

    // Give slow Electron targets time to consume the paste before restoring.
    tokio::time::sleep(Duration::from_millis(650)).await;
    // Restore only while the transcript is still the latest write: if the user
    // copied something newer during the wait, their copy wins (audit A18).
    if pasteboard::change_count() == ours {
        let _ = pasteboard::restore(&previous);
    }
    Ok(())
}

/// Tray "Paste last transcript": an explicit request to paste into whatever is
/// in front right now, so there is no earlier target to hold it to.
async fn perform_paste_locked(app: &AppHandle, text: String) -> Result<(), String> {
    let state = app.state::<PasteLock>();
    let _guard = state.0.try_lock().map_err(|_| "paste_busy".to_string())?;
    perform_paste(app, text, None).await
}

#[tauri::command]
async fn paste_text(app: AppHandle, text: String, target: Option<String>) -> Result<(), String> {
    let state = app.state::<PasteLock>();
    let _guard = state.0.try_lock().map_err(|_| "paste_busy".to_string())?;
    // Remember the transcript for the tray and unlock "Paste last transcript".
    if let Ok(mut last) = app.state::<LastTranscript>().0.lock() {
        *last = text.clone();
    }
    if let Some(item) = app.try_state::<PasteMenuItemHandle>() {
        let _ = item.0.set_enabled(true);
    }
    perform_paste(&app, text, target).await
}

/* History lives in history.json via tauri-plugin-store. The Hub and the FlowBar
are separate webviews, and both used to read the list, change it, and write
the whole array back — so a delete computed from a copy loaded minutes
earlier silently erased any dictation that had landed since (A04). A lock in
either webview cannot order the two, so every mutation happens here instead.
Reads stay in the webviews: the plugin hands JS and Rust the same in-memory
store for a path, so a write here is visible to the next JS read at once. */
const HISTORY_FILE: &str = "history.json";
const HISTORY_KEY: &str = "items";
/// Upper bound on the retention limit a webview may ask for.
const HISTORY_LIMIT_MAX: usize = 10_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn history_id(item: &Value) -> Option<&str> {
    item.get("id").and_then(Value::as_str)
}

/// An id no current entry holds: the timestamp in hex plus a counter.
/// `store.ts` mints browser-preview ids in the same shape.
fn mint_history_id(items: &[Value], at: u64) -> String {
    (0u32..)
        .map(|n| format!("h{at:x}-{n}"))
        .find(|id| !items.iter().any(|it| history_id(it) == Some(id.as_str())))
        .unwrap_or_default()
}

/// Give entries written before ids existed one. Returns whether any changed.
fn backfill_history_ids(items: &mut [Value]) -> bool {
    let mut changed = false;
    for i in 0..items.len() {
        if !items[i].is_object() || history_id(&items[i]).is_some() {
            continue;
        }
        let at = items[i]
            .get("at")
            .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
            .unwrap_or(0);
        let id = mint_history_id(items, at);
        items[i]["id"] = Value::String(id);
        changed = true;
    }
    changed
}

fn push_history_item(items: &mut Vec<Value>, item: Value, limit: usize) {
    items.insert(0, item);
    items.truncate(limit.clamp(1, HISTORY_LIMIT_MAX));
}

/// Remove exactly the entry with this id. Returns whether one was removed.
fn delete_history_item(items: &mut Vec<Value>, id: &str) -> bool {
    let before = items.len();
    items.retain(|it| history_id(it) != Some(id));
    items.len() != before
}

/// Run one read-modify-write of the history list under `HistoryLock`. The
/// closure gets the current list (empty when the file has none yet) and
/// whether the file had one at all, and returns whether it changed the list.
/// Only a changed list is written and saved.
fn with_history<T>(
    app: &AppHandle,
    f: impl FnOnce(&mut Vec<Value>, bool) -> (bool, T),
) -> Result<T, String> {
    let lock = app.state::<HistoryLock>();
    let _guard = lock.0.lock().map_err(|_| "state_poisoned".to_string())?;
    let store = app.store(HISTORY_FILE).map_err(|e| e.to_string())?;
    let existing = store.get(HISTORY_KEY);
    let present = existing.is_some();
    let mut items = match existing {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    };
    let (changed, out) = f(&mut items, present);
    if changed {
        store.set(HISTORY_KEY, Value::Array(items));
        store.save().map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Record a finished dictation at the top of history and return the stored entry.
#[tauri::command]
fn history_push(
    app: AppHandle,
    text: String,
    duration_ms: Option<f64>,
    target_app: Option<String>,
    limit: usize,
) -> Result<Value, String> {
    let at = now_ms();
    with_history(&app, |items, _| {
        backfill_history_ids(items);
        let mut item = json!({ "id": mint_history_id(items, at), "text": text, "at": at });
        if let Some(ms) = duration_ms.filter(|ms| ms.is_finite() && *ms > 0.0) {
            item["durationMs"] = json!(ms.round() as u64);
        }
        if let Some(bundle) = target_app.filter(|b| !b.is_empty()) {
            item["app"] = json!(bundle);
        }
        push_history_item(items, item.clone(), limit);
        (true, item)
    })
}

/// Delete one entry by id — never by position or by a list the webview holds.
#[tauri::command]
fn history_delete(app: AppHandle, id: String) -> Result<bool, String> {
    with_history(&app, |items, _| {
        let removed = delete_history_item(items, &id);
        (removed, removed)
    })
}

#[tauri::command]
fn history_clear(app: AppHandle) -> Result<(), String> {
    with_history(&app, |items, _| {
        let changed = !items.is_empty();
        items.clear();
        (changed, ())
    })
}

/// First read after an upgrade: adopt the pre-store localStorage list when the
/// file has none yet, and give every entry a stable id. Idempotent, so both
/// webviews may race here and the second call changes nothing.
#[tauri::command]
fn history_migrate(app: AppHandle, legacy: Vec<Value>) -> Result<Vec<Value>, String> {
    with_history(&app, |items, present| {
        let adopted = !present;
        if adopted {
            // Same ceiling as every other write (A48); legacy lists were capped
            // at 200, so this only guards a hand-edited one.
            *items = legacy
                .into_iter()
                .filter(Value::is_object)
                .take(HISTORY_LIMIT_MAX)
                .collect();
        }
        let backfilled = backfill_history_ids(items);
        (adopted || backfilled, items.clone())
    })
}

fn position_flowbar(win: &WebviewWindow) {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten());
    if let (Some(monitor), Ok(size)) = (monitor, win.outer_size()) {
        let m = monitor.size();
        let pos = monitor.position();
        let scale = monitor.scale_factor();
        let bottom_margin = 34.0;
        let x = pos.x + (m.width as i32 - size.width as i32) / 2;
        let y = pos.y + m.height as i32 - size.height as i32 - (bottom_margin * scale) as i32;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

/// Menu-bar recording dot (audit A21): with the bar allowed to hide, the tray
/// is the one place that can always say a microphone is open.
#[tauri::command]
fn set_tray_recording(app: AppHandle, recording: bool) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let title = if recording { Some("●") } else { None };
        tray.set_title(title).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_flowbar(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("flowbar") {
        position_flowbar(&win);
        win.show().map_err(|e| e.to_string())?;
        let _ = win.set_always_on_top(true);
    }
    Ok(())
}

#[tauri::command]
fn hide_flowbar(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("flowbar") {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn resize_flowbar(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("flowbar") {
        win.set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        position_flowbar(&win);
    }
    Ok(())
}

#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

fn show_main_section(app: &AppHandle, section: Option<&str>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
    if let Some(section) = section {
        let _ = app.emit("navigate-settings", section.to_string());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // Filled in `setup` with the bindings that actually registered.
        .manage(ShortcutRegistry(Mutex::new(HashMap::new())))
        .manage(LastTranscript(Mutex::new(String::new())))
        .manage(PasteLock(TokioMutex::new(())))
        .manage(HistoryLock(Mutex::new(())))
        .invoke_handler(tauri::generate_handler![
            transcribe,
            cleanup_text,
            transform_text,
            capture_selection,
            paste_target,
            report_event,
            send_feedback,
            paste_text,
            set_tray_recording,
            show_flowbar,
            hide_flowbar,
            resize_flowbar,
            open_settings,
            has_api_key,
            set_api_key,
            check_accessibility,
            request_accessibility,
            open_privacy_pane,
            update_shortcut,
            history_push,
            history_delete,
            history_clear,
            history_migrate
        ])
        .on_window_event(|window, event| {
            // Closing the Hub should hide it, not quit — Lirrly lives in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // Menu-bar-only app: no Dock icon, doesn't steal focus.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Global hotkeys (dictation toggle + transform). The frontend
            // re-applies the user's saved bindings at startup via `update_shortcut`.
            //
            // A conflict is never fatal. Propagating the error out of `setup`
            // aborts the whole launch, so an unrelated app holding ⌘⇧D used to
            // mean Lirrly simply would not open — with no way to reach Settings
            // and rebind it. Degrade instead: the FlowBar's record button and
            // the tray still work, and the saved bindings are applied moments
            // later anyway. Only a binding that registered is recorded (A38),
            // so the frontend's re-apply retries one that did not, and can
            // tell the user which shortcut another app is holding.
            let registry = app.state::<ShortcutRegistry>();
            for (action, accelerator) in [
                ("dictation", DEFAULT_DICTATION_ACCELERATOR),
                ("transform", DEFAULT_TRANSFORM_ACCELERATOR),
            ] {
                match register_action_shortcut(app.handle(), action, accelerator) {
                    Ok(()) => {
                        if let Ok(mut map) = registry.0.lock() {
                            map.insert(action.to_string(), accelerator.to_string());
                        }
                    }
                    Err(err) => eprintln!("{action} shortcut unavailable ({accelerator}): {err}"),
                }
            }

            // Menu-bar tray, ordered for the compact Lirrly workflow.
            let home_i = MenuItem::with_id(app, "home", "Home", true, None::<&str>)?;
            let updates_i = MenuItem::with_id(
                app,
                "check_updates",
                "Check for updates...",
                true,
                None::<&str>,
            )?;
            // Disabled until the first dictation of this session lands.
            let paste_i = MenuItem::with_id(
                app,
                "paste_last",
                "Paste last transcript",
                false,
                None::<&str>,
            )?;
            let shortcuts_i = MenuItem::with_id(app, "shortcuts", "Shortcuts", true, None::<&str>)?;

            // Language entries open Settings — the saved setting is the single
            // source of truth; the tray never pretends to hold its own state.
            let lang_auto = MenuItem::with_id(app, "lang_auto", "Auto-detect", true, None::<&str>)?;
            let lang_en = MenuItem::with_id(app, "lang_en", "English", true, None::<&str>)?;
            let lang_ar = MenuItem::with_id(app, "lang_ar", "Arabic", true, None::<&str>)?;
            let lang_es = MenuItem::with_id(app, "lang_es", "Spanish", true, None::<&str>)?;
            let lang_fr = MenuItem::with_id(app, "lang_fr", "French", true, None::<&str>)?;
            let languages_menu = Submenu::with_items(
                app,
                "Languages",
                true,
                &[&lang_auto, &lang_en, &lang_ar, &lang_es, &lang_fr],
            )?;

            let help_i = MenuItem::with_id(app, "help", "Help Center", true, None::<&str>)?;
            let support_i =
                MenuItem::with_id(app, "support", "Talk to support", true, None::<&str>)?;
            let feedback_i =
                MenuItem::with_id(app, "feedback", "General feedback", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Lirrly", true, None::<&str>)?;

            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let sep3 = PredefinedMenuItem::separator(app)?;
            let sep4 = PredefinedMenuItem::separator(app)?;
            let sep5 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[
                    &home_i,
                    &sep1,
                    &updates_i,
                    &sep2,
                    &paste_i,
                    &sep3,
                    &shortcuts_i,
                    &languages_menu,
                    &sep4,
                    &help_i,
                    &support_i,
                    &feedback_i,
                    &sep5,
                    &quit_i,
                ],
            )?;
            app.manage(PasteMenuItemHandle(paste_i.clone()));
            let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon-32.png"))?;
            let _tray = TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                // Dedicated black alpha-mask glyph for macOS template tinting.
                .icon_as_template(true)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "home" => show_main_section(app, Some("home")),
                    "shortcuts" => show_main_section(app, Some("shortcuts")),
                    // The in-app updater, not the releases page (audit A36): a
                    // DMG installed by hand skips the signature-checked path.
                    "check_updates" => {
                        show_main_section(app, Some("account"));
                        let _ = app.emit("check-for-updates", ());
                    }
                    "help" | "support" | "feedback" => {
                        let _ = app
                            .opener()
                            .open_url(format!("{REPO_URL}/issues"), None::<&str>);
                    }
                    "paste_last" => {
                        let text = app
                            .state::<LastTranscript>()
                            .0
                            .lock()
                            .map(|t| t.clone())
                            .unwrap_or_default();
                        if !text.is_empty() {
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = perform_paste_locked(&app, text).await;
                            });
                        }
                    }
                    id if id.starts_with("lang_") => show_main_section(app, Some("settings")),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // The floating bar is always on screen — pin it bottom-center.
            if let Some(fb) = app.get_webview_window("flowbar") {
                position_flowbar(&fb);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        backfill_history_ids, delete_history_item, history_id, mint_history_id,
        paste_target_matches, privacy_pane_url, push_history_item, shortcut_event_for_action,
    };
    use lirrly_core::groq::{
        normalize_audio_mime, transform_system_prompt, upload_extension_for_mime,
    };
    use serde_json::{json, Value};

    #[test]
    fn strips_codec_params_from_audio_mime() {
        assert_eq!(normalize_audio_mime("audio/webm;codecs=opus"), "audio/webm");
    }

    #[test]
    fn falls_back_to_webm_for_blank_mime() {
        assert_eq!(normalize_audio_mime("   "), "audio/webm");
    }

    #[test]
    fn chooses_upload_extension_from_audio_mime() {
        assert_eq!(upload_extension_for_mime("audio/ogg"), "ogg");
        assert_eq!(upload_extension_for_mime("audio/wav"), "wav");
        assert_eq!(upload_extension_for_mime("audio/mp4"), "m4a");
        assert_eq!(
            upload_extension_for_mime("application/octet-stream"),
            "webm"
        );
    }

    #[test]
    fn limits_privacy_pane_urls_to_known_panes() {
        assert!(privacy_pane_url("microphone").is_ok());
        assert!(privacy_pane_url("accessibility").is_ok());
        assert_eq!(privacy_pane_url("camera"), Err("unknown_pane".to_string()));
    }

    #[test]
    fn maps_shortcut_actions_to_webview_events() {
        assert_eq!(
            shortcut_event_for_action("dictation"),
            Some("toggle-dictation")
        );
        assert_eq!(
            shortcut_event_for_action("transform"),
            Some("run-transform")
        );
        assert_eq!(shortcut_event_for_action("scratchpad"), None);
    }

    #[test]
    fn transform_prompt_keeps_dialect_rule_arabic_only() {
        assert!(transform_system_prompt(Some("ar")).contains("Modern Standard Arabic"));
        assert!(!transform_system_prompt(Some("en")).contains("Modern Standard Arabic"));
        assert!(!transform_system_prompt(None).contains("Modern Standard Arabic"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn only_shortcut_modifiers_hold_up_the_selection_copy() {
        use objc2_app_kit::NSEventModifierFlags as Flags;
        let held = super::holds_shortcut_modifier;
        // ⌥ still down from ⌥T is the case this exists for.
        assert!(held(Flags::Option));
        assert!(held(Flags::Command | Flags::Shift));
        assert!(held(Flags::Control | Flags::CapsLock));
        // Caps Lock can be on indefinitely; waiting on it would stall every ⌥T.
        assert!(!held(Flags::CapsLock));
        assert!(!held(Flags::Function | Flags::NumericPad | Flags::Help));
        assert!(!held(Flags::empty()));
    }

    #[test]
    fn pastes_only_into_the_app_the_result_was_meant_for() {
        let slack = Some("com.tinyspeck.slackmacgap");
        let chrome = Some("com.google.Chrome");
        assert!(paste_target_matches(slack, slack));
        assert!(
            !paste_target_matches(slack, chrome),
            "switched apps while waiting"
        );
        assert!(
            !paste_target_matches(slack, None),
            "unknown front app is not a match"
        );
        assert!(
            paste_target_matches(None, chrome),
            "no recorded target, no check"
        );
    }

    fn ids(items: &[Value]) -> Vec<&str> {
        items.iter().filter_map(history_id).collect()
    }

    #[test]
    fn minted_ids_never_collide_within_the_same_millisecond() {
        let mut items = Vec::new();
        for text in ["one", "two", "three"] {
            let id = mint_history_id(&items, 1_700_000_000_000);
            push_history_item(&mut items, json!({ "id": id, "text": text }), 200);
        }
        let mut seen = ids(&items);
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), 3);
    }

    #[test]
    fn backfill_gives_legacy_entries_distinct_ids_and_keeps_existing_ones() {
        let mut items = vec![
            json!({ "text": "same moment", "at": 5 }),
            json!({ "text": "same moment", "at": 5 }),
            json!({ "id": "kept", "text": "already had one", "at": 4 }),
        ];
        assert!(backfill_history_ids(&mut items));
        assert_eq!(ids(&items).len(), 3);
        assert_ne!(history_id(&items[0]), history_id(&items[1]));
        assert_eq!(history_id(&items[2]), Some("kept"));
        assert!(!backfill_history_ids(&mut items), "second pass is a no-op");
    }

    #[test]
    fn delete_removes_only_the_named_entry_even_with_identical_text_and_time() {
        // The old webview delete matched on `at` + `text`, so twins died together.
        let mut items = vec![
            json!({ "id": "a", "text": "twin", "at": 1 }),
            json!({ "id": "b", "text": "twin", "at": 1 }),
        ];
        assert!(delete_history_item(&mut items, "a"));
        assert_eq!(ids(&items), vec!["b"]);
        assert!(
            !delete_history_item(&mut items, "a"),
            "deleting twice is harmless"
        );
    }

    #[test]
    fn a_dictation_pushed_after_a_view_loaded_survives_a_delete_from_that_view() {
        // A04 as it happened: History loaded [old1, old2], a dictation landed,
        // then the user deleted old1. Deleting by id against the current list
        // must keep the new entry.
        let mut items = vec![
            json!({ "id": "old1", "text": "first", "at": 1 }),
            json!({ "id": "old2", "text": "second", "at": 2 }),
        ];
        push_history_item(
            &mut items,
            json!({ "id": "new", "text": "just now", "at": 3 }),
            200,
        );
        delete_history_item(&mut items, "old1");
        assert_eq!(ids(&items), vec!["new", "old2"]);
    }

    #[test]
    fn push_keeps_newest_first_and_honours_the_limit() {
        let mut items = Vec::new();
        for n in 0..5 {
            push_history_item(&mut items, json!({ "id": n.to_string() }), 3);
        }
        assert_eq!(ids(&items), vec!["4", "3", "2"]);
        push_history_item(&mut items, json!({ "id": "x" }), 0);
        assert_eq!(
            items.len(),
            1,
            "a zero limit still keeps the entry just written"
        );
    }
}
