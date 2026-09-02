// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 mshrmnsr

//! Shared Lirrly pipeline — everything that is *not* macOS-specific.
//!
//! Both the full app and the sandboxed App Store build depend on this crate so
//! the Groq calls and, most importantly, the Arabic dialect-preserving prompts
//! exist in exactly one place. Nothing here touches Accessibility, global
//! shortcuts, synthetic keystrokes, or private APIs, so it is App Sandbox safe.

pub mod groq;
pub mod keychain;

pub use groq::{cleanup_text, transcribe, transform_text};
pub use keychain::Keychain;
