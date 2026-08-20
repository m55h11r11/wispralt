// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 mshrmnsr

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use serde_json::json;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex as TokioMutex;

const KEYCHAIN_SERVICE: &str = "com.mshrmnsr.lirrly";
const KEYCHAIN_USER: &str = "groq-api-key";
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

fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER).map_err(|e| e.to_string())
}

/// Load the Groq key from the macOS Keychain. The key never reaches the webview.
fn load_api_key() -> Result<String, String> {
    let entry = keychain_entry()?;
    match entry.get_password() {
        Ok(k) if !k.trim().is_empty() => Ok(k),
        Ok(_) | Err(keyring::Error::NoEntry) => Err("missing_api_key".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Whether a key is saved — the webview only ever learns yes/no, never the key.
#[tauri::command]
fn has_api_key() -> bool {
    load_api_key().is_ok()
}

/// Save (or clear, when empty) the Groq key in the macOS Keychain.
#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    let entry = keychain_entry()?;
    let key = key.trim();
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else {
        entry.set_password(key).map_err(|e| e.to_string())
    }
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

fn normalize_audio_mime(mime: &str) -> String {
    let normalized = mime
        .split(';')
        .next()
        .unwrap_or("audio/webm")
        .trim()
        .to_string();
    if normalized.is_empty() {
        "audio/webm".to_string()
    } else {
        normalized
    }
}

fn upload_extension_for_mime(mime: &str) -> &'static str {
    if mime.contains("webm") {
        "webm"
    } else if mime.contains("ogg") {
        "ogg"
    } else if mime.contains("wav") {
        "wav"
    } else if mime.contains("mp4") || mime.contains("m4a") || mime.contains("aac") {
        "m4a"
    } else {
        "webm"
    }
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
    let bytes = general_purpose::STANDARD
        .decode(audio_b64.as_bytes())
        .map_err(|e| e.to_string())?;

    // Groq's transcription endpoint rejects files over 25 MB.
    const GROQ_MAX_BYTES: usize = 25 * 1024 * 1024;
    if bytes.len() > GROQ_MAX_BYTES {
        return Err("recording_too_large".into());
    }

    // Strip codec params ("audio/webm;codecs=opus") — Groq rejects them in Content-Type.
    let mime = normalize_audio_mime(&mime);
    let ext = upload_extension_for_mime(&mime);

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("audio.{ext}"))
        .mime_str(&mime)
        .map_err(|e| e.to_string())?;

    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model)
        .text("response_format", "json")
        .text("temperature", "0");

    if let Some(lang) = language {
        if !lang.is_empty() && lang != "auto" {
            form = form.text("language", lang);
        }
    }

    // Personal-dictionary terms biased into recognition (Whisper accepts ~224 tokens).
    if let Some(p) = prompt {
        let p = p.trim().to_string();
        if !p.is_empty() {
            form = form.text("prompt", p);
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Groq API {status}: {body}"));
    }

    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(v.get("text")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
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
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(String::new());
    }
    let api_key = load_api_key()?;

    let level_instruction = match level.as_str() {
        "medium" => {
            "Lightly edit: remove filler, repeated starts, obvious recognition slips, and add punctuation. Keep the speaker's phrasing."
        }
        "high" => {
            "Polish strongly: turn rambling speech into clear prose, preserve intent and details, and keep the user's natural voice."
        }
        _ => "Only tidy punctuation and spacing.",
    };
    let language_hint = language
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| "auto-detect".to_string());
    // Dialect-preserving Arabic handling — Lirrly's edge over MSA-normalizing tools.
    let arabic_hint = if language_hint == "ar" {
        " The input is Arabic: preserve the speaker's dialect — do not normalize to Modern Standard Arabic unless the input already is MSA. Keep colloquial expressions intact and fix only clear recognition errors."
    } else {
        ""
    };
    let context_hint = context
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| "personal".to_string());
    let cleanup_model = if model.trim().is_empty() {
        "llama-3.1-8b-instant"
    } else {
        model.trim()
    };

    let system = format!(
        "You are Lirrly's transcript cleanup layer. Return only the final edited text. Do not explain. Do not add facts, names, dates, links, or contact details. Preserve the user's meaning, language, and intent.{arabic_hint}"
    );
    let user = format!(
        "Cleanup level: {level}\nContext: {context_hint}\nLanguage hint: {language_hint}\nInstruction: {level_instruction}\n\nRaw transcript:\n{text}"
    );
    let cleaned = groq_chat(
        api_key,
        cleanup_model,
        system,
        user,
        900,
        "Groq cleanup API",
    )
    .await?;

    if cleaned.is_empty() {
        Err("empty_cleanup".into())
    } else {
        Ok(cleaned)
    }
}

/// Shared Groq chat-completions call — the cleanup and transform layers differ
/// only in their prompts, so the HTTP/parsing path lives once.
async fn groq_chat(
    api_key: String,
    model: &str,
    system: String,
    user: String,
    max_tokens: u32,
    error_label: &str,
) -> Result<String, String> {
    let payload = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": 0.1,
        "max_tokens": max_tokens
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post("https://api.groq.com/openai/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{error_label} {status}: {body}"));
    }

    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(v.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .trim_matches('"')
        .trim()
        .to_string())
}

/// System prompt for the transform layer. Arabic keeps Lirrly's
/// dialect-preserving rule so transforms never MSA-normalize by accident.
fn transform_system_prompt(language: Option<&str>) -> String {
    let arabic_hint = if language == Some("ar") {
        " The text is Arabic: preserve the speaker's dialect — do not normalize to Modern Standard Arabic unless the instruction asks for it. Keep colloquial expressions intact."
    } else {
        ""
    };
    format!(
        "You are Lirrly's text transform layer. Apply the given transform instruction to the text. Return only the transformed text — no explanations, no preamble, no quotes. Do not add facts, names, dates, links, or contact details. Preserve the original language and dialect unless the instruction explicitly asks to change them.{arabic_hint}"
    )
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
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(String::new());
    }
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("empty_transform_prompt".into());
    }
    let api_key = load_api_key()?;
    let model = if model.trim().is_empty() {
        "llama-3.1-8b-instant"
    } else {
        model.trim()
    };

    let system = transform_system_prompt(language.as_deref());
    let user = format!("Transform instruction: {prompt}\n\nText:\n{text}");
    let out = groq_chat(api_key, model, system, user, 1200, "Groq transform API").await?;

    if out.is_empty() {
        Err("empty_transform".into())
    } else {
        Ok(out)
    }
}

/// Copy the current selection in the frontmost app (synthetic ⌘C) and return
/// it, restoring the user's clipboard afterwards. A sentinel marks "nothing
/// copied yet" so an empty selection is detected instead of returning stale
/// clipboard content. Non-text clipboards (images, files) can't be restored —
/// same known v1 limit as paste.
#[tauri::command]
async fn capture_selection(app: AppHandle) -> Result<String, String> {
    let state = app.state::<PasteLock>();
    let _guard = state.0.try_lock().map_err(|_| "paste_busy".to_string())?;
    if !check_accessibility() {
        return Err("accessibility_not_granted".into());
    }

    use tauri_plugin_clipboard_manager::ClipboardExt;
    // Zero-width-wrapped so it stays invisible if a worst-case abort leaves it behind.
    const SENTINEL: &str = "\u{200B}lirrly-selection-sentinel\u{200B}";
    let previous = app.clipboard().read_text().ok().filter(|t| !t.is_empty());
    app.clipboard()
        .write_text(SENTINEL.to_string())
        .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(60)).await;

    {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        enigo
            .key(Key::Meta, Direction::Press)
            .map_err(|e| e.to_string())?;
        enigo
            .key(Key::Unicode('c'), Direction::Click)
            .map_err(|e| e.to_string())?;
        enigo
            .key(Key::Meta, Direction::Release)
            .map_err(|e| e.to_string())?;
    }

    // Apps write the pasteboard asynchronously — poll until the sentinel is replaced.
    let mut captured: Option<String> = None;
    for _ in 0..15 {
        tokio::time::sleep(Duration::from_millis(40)).await;
        if let Ok(now) = app.clipboard().read_text() {
            if now != SENTINEL {
                if !now.trim().is_empty() {
                    captured = Some(now);
                }
                break;
            }
        }
    }

    if let Some(old) = previous {
        let _ = app.clipboard().write_text(old);
    } else if captured.is_none() {
        // Nothing to restore and nothing copied — don't leave the sentinel behind.
        let _ = app.clipboard().write_text(String::new());
    }
    captured.ok_or_else(|| "no_selection".to_string())
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
        let _ = app.global_shortcut().unregister(old.as_str());
    }

    match register_action_shortcut(&app, &action, &accelerator) {
        Ok(()) => {
            map.insert(action, accelerator);
            Ok(())
        }
        Err(e) => {
            let fallback = map
                .get(&action)
                .cloned()
                .unwrap_or_else(|| default_accelerator_for(&action).to_string());
            let _ = register_action_shortcut(&app, &action, &fallback);
            Err(e)
        }
    }
}

/// Put text on the clipboard, paste it into the frontmost app (Cmd+V), then
/// restore the previous clipboard so dictation doesn't clobber a user copy.
/// Async so the inter-keystroke waits never block the main thread.
async fn perform_paste(app: &AppHandle, text: String) -> Result<(), String> {
    if !check_accessibility() {
        return Err("accessibility_not_granted".into());
    }

    use tauri_plugin_clipboard_manager::ClipboardExt;
    // Non-text clipboard contents (images, files) can't be restored — known v1 limit.
    let previous = app.clipboard().read_text().ok().filter(|t| !t.is_empty());
    app.clipboard()
        .write_text(text)
        .map_err(|e| e.to_string())?;

    tokio::time::sleep(Duration::from_millis(120)).await;

    if !check_accessibility() {
        if let Some(old) = previous.as_ref() {
            let _ = app.clipboard().write_text(old.clone());
        }
        return Err("accessibility_not_granted".into());
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
    if let Some(old) = previous {
        let _ = app.clipboard().write_text(old);
    }
    Ok(())
}

async fn perform_paste_locked(app: &AppHandle, text: String) -> Result<(), String> {
    let state = app.state::<PasteLock>();
    let _guard = state.0.try_lock().map_err(|_| "paste_busy".to_string())?;
    perform_paste(app, text).await
}

#[tauri::command]
async fn paste_text(app: AppHandle, text: String) -> Result<(), String> {
    let state = app.state::<PasteLock>();
    let _guard = state.0.try_lock().map_err(|_| "paste_busy".to_string())?;
    // Remember the transcript for the tray and unlock "Paste last transcript".
    if let Ok(mut last) = app.state::<LastTranscript>().0.lock() {
        *last = text.clone();
    }
    if let Some(item) = app.try_state::<PasteMenuItemHandle>() {
        let _ = item.0.set_enabled(true);
    }
    perform_paste(&app, text).await
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(ShortcutRegistry(Mutex::new(HashMap::from([
            (
                "dictation".to_string(),
                DEFAULT_DICTATION_ACCELERATOR.to_string(),
            ),
            (
                "transform".to_string(),
                DEFAULT_TRANSFORM_ACCELERATOR.to_string(),
            ),
        ]))))
        .manage(LastTranscript(Mutex::new(String::new())))
        .manage(PasteLock(TokioMutex::new(())))
        .invoke_handler(tauri::generate_handler![
            transcribe,
            cleanup_text,
            transform_text,
            capture_selection,
            report_event,
            send_feedback,
            paste_text,
            show_flowbar,
            hide_flowbar,
            resize_flowbar,
            open_settings,
            has_api_key,
            set_api_key,
            check_accessibility,
            request_accessibility,
            open_privacy_pane,
            update_shortcut
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
            register_action_shortcut(app.handle(), "dictation", DEFAULT_DICTATION_ACCELERATOR)?;
            if let Err(err) =
                register_action_shortcut(app.handle(), "transform", DEFAULT_TRANSFORM_ACCELERATOR)
            {
                // Another app owns ⌥T — dictation still works; users can rebind in Shortcuts.
                eprintln!("transform shortcut unavailable: {err}");
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
            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                // Dedicated black alpha-mask glyph for macOS template tinting.
                .icon_as_template(true)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "home" => show_main_section(app, Some("home")),
                    "shortcuts" => show_main_section(app, Some("shortcuts")),
                    "check_updates" => {
                        let _ = app
                            .opener()
                            .open_url(format!("{REPO_URL}/releases"), None::<&str>);
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
        normalize_audio_mime, privacy_pane_url, shortcut_event_for_action, transform_system_prompt,
        upload_extension_for_mime,
    };

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
}
