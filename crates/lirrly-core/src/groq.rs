// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 mshrmnsr

//! Groq API calls: Whisper transcription plus the LLM cleanup and transform
//! layers. Callers pass the API key in, so this module stays independent of how
//! the key is stored.

use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use serde_json::json;

const TRANSCRIBE_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const CHAT_URL: &str = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_CHAT_MODEL: &str = "llama-3.1-8b-instant";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Groq's transcription endpoint rejects files over 25 MB.
const GROQ_MAX_BYTES: usize = 25 * 1024 * 1024;

/// Strip codec params ("audio/webm;codecs=opus") — Groq rejects them in Content-Type.
pub fn normalize_audio_mime(mime: &str) -> String {
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

pub fn upload_extension_for_mime(mime: &str) -> &'static str {
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

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Transcribe a base64 audio clip via the Groq Whisper API.
pub async fn transcribe(
    api_key: String,
    audio_b64: String,
    mime: String,
    model: String,
    language: Option<String>,
    prompt: Option<String>,
) -> Result<String, String> {
    let bytes = general_purpose::STANDARD
        .decode(audio_b64.as_bytes())
        .map_err(|e| e.to_string())?;
    if bytes.len() > GROQ_MAX_BYTES {
        return Err("recording_too_large".into());
    }

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

    let resp = client()?
        .post(TRANSCRIBE_URL)
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

/// System prompt for the cleanup layer. Arabic input keeps its dialect —
/// Lirrly's edge over tools that normalize everything to MSA.
pub fn cleanup_system_prompt(language_hint: &str) -> String {
    let arabic_hint = if language_hint == "ar" {
        " The input is Arabic: preserve the speaker's dialect — do not normalize to Modern Standard Arabic unless the input already is MSA. Keep colloquial expressions intact and fix only clear recognition errors."
    } else {
        ""
    };
    format!(
        "You are Lirrly's transcript cleanup layer. Return only the final edited text. Do not explain. Do not add facts, names, dates, links, or contact details. Preserve the user's meaning, language, and intent.{arabic_hint}"
    )
}

/// Turn a raw transcript into readable prose while keeping meaning intact.
pub async fn cleanup_text(
    api_key: String,
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
    let context_hint = context
        .filter(|c| !c.trim().is_empty())
        .unwrap_or_else(|| "personal".to_string());
    let cleanup_model = if model.trim().is_empty() {
        DEFAULT_CHAT_MODEL
    } else {
        model.trim()
    };

    let system = cleanup_system_prompt(&language_hint);
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

/// System prompt for the transform layer. Arabic keeps the dialect-preserving
/// rule so transforms never MSA-normalize by accident.
pub fn transform_system_prompt(language: Option<&str>) -> String {
    let arabic_hint = if language == Some("ar") {
        " The text is Arabic: preserve the speaker's dialect — do not normalize to Modern Standard Arabic unless the instruction asks for it. Keep colloquial expressions intact."
    } else {
        ""
    };
    format!(
        "You are Lirrly's text transform layer. Apply the given transform instruction to the text. Return only the transformed text — no explanations, no preamble, no quotes. Do not add facts, names, dates, links, or contact details. Preserve the original language and dialect unless the instruction explicitly asks to change them.{arabic_hint}"
    )
}

/// Apply a user-defined transform instruction to arbitrary text.
pub async fn transform_text(
    api_key: String,
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
    let model = if model.trim().is_empty() {
        DEFAULT_CHAT_MODEL
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

/// Shared Groq chat-completions call — the cleanup and transform layers differ
/// only in their prompts, so the HTTP/parsing path lives once.
pub async fn groq_chat(
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

    let resp = client()?
        .post(CHAT_URL)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_codec_params_from_mime() {
        assert_eq!(normalize_audio_mime("audio/webm;codecs=opus"), "audio/webm");
        assert_eq!(normalize_audio_mime(""), "audio/webm");
        assert_eq!(normalize_audio_mime("audio/mp4"), "audio/mp4");
    }

    #[test]
    fn maps_mime_to_upload_extension() {
        assert_eq!(upload_extension_for_mime("audio/webm"), "webm");
        assert_eq!(upload_extension_for_mime("audio/mp4"), "m4a");
        assert_eq!(upload_extension_for_mime("audio/flac"), "webm");
    }

    #[test]
    fn arabic_keeps_dialect_in_both_layers() {
        assert!(cleanup_system_prompt("ar").contains("preserve the speaker's dialect"));
        assert!(!cleanup_system_prompt("en").contains("dialect"));
        assert!(transform_system_prompt(Some("ar")).contains("preserve the speaker's dialect"));
        assert!(!transform_system_prompt(Some("en")).contains("Modern Standard Arabic"));
    }
}
