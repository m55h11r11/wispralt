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
const DEFAULT_CHAT_MODEL: &str = "qwen/qwen3.8-27b";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Groq's transcription endpoint rejects files over 25 MB.
const GROQ_MAX_BYTES: usize = 25 * 1024 * 1024;
/// Output-token budgets for the chat layers. The floors are the old fixed caps;
/// the ceiling stays conservative because a request above a model's completion
/// limit is rejected outright, which is worse than the truncation it prevents.
const CLEANUP_MIN_TOKENS: u32 = 900;
const TRANSFORM_MIN_TOKENS: u32 = 1200;
const MAX_OUTPUT_TOKENS: u32 = 8192;
/// Longest `retry-after` a rate-limited chat call waits out before its one
/// retry. Free-tier keys hit per-minute token limits on back-to-back transforms
/// (Groq counts each request's `max_tokens`); a wait of a few seconds is better
/// than a failure the user must redo by hand. Anything longer fails at once.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(10);
/// Floor for the wait, so a `retry-after: 0` cannot turn into an instant re-hit.
const MIN_RETRY_AFTER: Duration = Duration::from_millis(500);

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
        cleanup_token_budget(&text),
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
    let out = groq_chat(
        api_key,
        model,
        system,
        user,
        transform_token_budget(&text),
        "Groq transform API",
    )
    .await?;

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

    let client = client()?;
    let mut retried = false;
    loop {
        let resp = client
            .post(CHAT_URL)
            .bearer_auth(&api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = resp.status();
        if !retried {
            let retry_after = resp
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok());
            if let Some(wait) = rate_limit_wait(status.as_u16(), retry_after) {
                retried = true;
                tokio::time::sleep(wait).await;
                continue;
            }
        }
        let body = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("{error_label} {status}: {body}"));
        }
        return parse_chat_completion(&body);
    }
}

/// How long to wait before retrying a rate-limited call, or `None` when it
/// should fail now. Only a 429 that says when to come back (`retry-after`, in
/// seconds — Groq sends whole seconds; a fraction is accepted) within
/// `MAX_RETRY_AFTER` is worth waiting for. A 429 without the header is a quota
/// that will not clear in seconds, and an HTTP-date form is not used by Groq.
pub fn rate_limit_wait(status: u16, retry_after: Option<&str>) -> Option<Duration> {
    if status != 429 {
        return None;
    }
    let secs: f64 = retry_after?.trim().parse().ok()?;
    // Range-check before converting: `Duration::from_secs_f64` panics on NaN,
    // negatives and values too large to represent.
    if !(0.0..=MAX_RETRY_AFTER.as_secs_f64()).contains(&secs) {
        return None;
    }
    Some(Duration::from_secs_f64(secs).max(MIN_RETRY_AFTER))
}

/// A cleanup rewrite is roughly as long as its input. Every byte-level BPE token
/// covers at least one UTF-8 byte, so the input's byte length bounds its token
/// count from above — a budget sized from it cannot cut off a faithful rewrite
/// of a long dictation the way the old fixed 900 did (Arabic especially, where
/// a few minutes of speech outgrew it).
pub fn cleanup_token_budget(text: &str) -> u32 {
    u32::try_from(text.len())
        .unwrap_or(u32::MAX)
        .saturating_add(256)
        .clamp(CLEANUP_MIN_TOKENS, MAX_OUTPUT_TOKENS)
}

/// A transform may legitimately expand its input ("turn this into an email"),
/// so it gets twice the byte bound plus room for the added structure.
pub fn transform_token_budget(text: &str) -> u32 {
    u32::try_from(text.len())
        .unwrap_or(u32::MAX)
        .saturating_mul(2)
        .saturating_add(1024)
        .clamp(TRANSFORM_MIN_TOKENS, MAX_OUTPUT_TOKENS)
}

/// Pull the assistant text out of a chat-completions response body.
///
/// `finish_reason: "length"` means the model stopped at `max_tokens` mid-answer.
/// The content is then a plausible-looking prefix of the real output, and
/// returning it would silently drop the rest of the user's words — so it is an
/// error (`output_truncated`), never a result. Callers already recover from
/// errors without loss: dictation keeps the full un-polished transcript, and a
/// failed transform leaves the selection untouched.
pub fn parse_chat_completion(body: &str) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let choice = v.get("choices").and_then(|c| c.get(0));
    if choice
        .and_then(|c| c.get("finish_reason"))
        .and_then(|r| r.as_str())
        == Some("length")
    {
        return Err("output_truncated".into());
    }
    Ok(choice
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

    fn completion(content: &str, finish_reason: &str) -> String {
        json!({
            "choices": [{
                "index": 0,
                "message": { "role": "assistant", "content": content },
                "finish_reason": finish_reason
            }]
        })
        .to_string()
    }

    #[test]
    fn returns_content_when_the_model_finished() {
        let body = completion("  \"Hello there.\"  ", "stop");
        assert_eq!(parse_chat_completion(&body).unwrap(), "Hello there.");
    }

    #[test]
    fn a_length_stop_is_an_error_not_a_shorter_answer() {
        let body = completion("The first half of what you actually sa", "length");
        assert_eq!(
            parse_chat_completion(&body).unwrap_err(),
            "output_truncated"
        );
    }

    #[test]
    fn missing_choices_still_parse_as_empty_for_the_empty_output_errors() {
        assert_eq!(parse_chat_completion("{}").unwrap(), "");
        assert!(parse_chat_completion("not json").is_err());
    }

    #[test]
    fn short_inputs_keep_the_previous_floors() {
        assert_eq!(cleanup_token_budget("hello"), CLEANUP_MIN_TOKENS);
        assert_eq!(transform_token_budget("hello"), TRANSFORM_MIN_TOKENS);
    }

    #[test]
    fn long_arabic_dictation_gets_a_budget_above_its_own_size() {
        // ~3 minutes of Arabic speech: two bytes per letter in UTF-8 put this
        // well past the old fixed cap of 900 tokens.
        let dictation = "والله يا اخوي الموضوع هذا يبي له جلسة طويلة ونتفاهم فيه زين ".repeat(40);
        assert!(dictation.len() > 900 * 2);
        let cleanup = cleanup_token_budget(&dictation);
        let transform = transform_token_budget(&dictation);
        assert!(cleanup as usize >= dictation.len().min(MAX_OUTPUT_TOKENS as usize));
        assert!(transform >= cleanup);
    }

    #[test]
    fn a_short_rate_limit_is_waited_out_once() {
        assert_eq!(
            rate_limit_wait(429, Some("2")),
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            rate_limit_wait(429, Some(" 1.5 ")),
            Some(Duration::from_millis(1500))
        );
        // A zero wait still pauses briefly instead of re-hitting the limit.
        assert_eq!(rate_limit_wait(429, Some("0")), Some(MIN_RETRY_AFTER));
        assert_eq!(rate_limit_wait(429, Some("10")), Some(MAX_RETRY_AFTER));
    }

    #[test]
    fn other_failures_and_long_waits_fail_at_once() {
        assert_eq!(rate_limit_wait(500, Some("2")), None);
        assert_eq!(rate_limit_wait(200, Some("2")), None);
        assert_eq!(rate_limit_wait(429, None), None);
        assert_eq!(rate_limit_wait(429, Some("11")), None);
        assert_eq!(rate_limit_wait(429, Some("-1")), None);
        assert_eq!(rate_limit_wait(429, Some("NaN")), None);
        assert_eq!(rate_limit_wait(429, Some("inf")), None);
        assert_eq!(rate_limit_wait(429, Some("1e300")), None);
        assert_eq!(
            rate_limit_wait(429, Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            None
        );
    }

    #[test]
    fn budgets_never_exceed_the_ceiling() {
        let huge = "a".repeat(10 * 1024 * 1024);
        assert_eq!(cleanup_token_budget(&huge), MAX_OUTPUT_TOKENS);
        assert_eq!(transform_token_budget(&huge), MAX_OUTPUT_TOKENS);
    }
}
