// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 mshrmnsr

//! Groq API key storage. The key lives in the macOS Keychain and never reaches
//! the webview — callers only ever learn whether one exists.

const KEYCHAIN_USER: &str = "groq-api-key";

/// Keychain-backed API key store, scoped to one service name so the full app
/// and the sandboxed App Store build never share a credential.
pub struct Keychain {
    service: String,
}

impl Keychain {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, KEYCHAIN_USER).map_err(|e| e.to_string())
    }

    /// The stored key, or `missing_api_key` when none is saved.
    pub fn load(&self) -> Result<String, String> {
        let entry = self.entry()?;
        match entry.get_password() {
            Ok(k) if !k.trim().is_empty() => Ok(k),
            Ok(_) | Err(keyring::Error::NoEntry) => Err("missing_api_key".into()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn has(&self) -> bool {
        self.load().is_ok()
    }

    /// Save the key, or clear it when given an empty string.
    pub fn set(&self, key: &str) -> Result<(), String> {
        let entry = self.entry()?;
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
}
