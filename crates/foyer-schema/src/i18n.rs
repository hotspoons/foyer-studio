// SPDX-License-Identifier: Apache-2.0
//! Wire-shape for translatable strings emitted by the server.
//!
//! Foyer is multi-client: one server can be fanning events out to
//! several browsers in different locales. So error / toast / event
//! text emitted server-side can't be pre-translated — there's no
//! single locale that's correct for every subscriber. The server
//! emits this struct, the client renders it through its own catalog
//! on receipt.
//!
//! Forward-compat: `key` doubles as the English source string. A
//! pre-i18n client that doesn't know about `params` and just reads
//! `key` literally still shows the user something sensible (the
//! original English template). Translation logic + the Drupal-style
//! catalog loader live in `foyer-i18n`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalizedString {
    /// English source string AND the catalog lookup key. Drupal
    /// `t()`-style: the human-readable English is the key. Cuts out
    /// a separate "string ID" file and means a half-translated
    /// catalog still ships English for the un-translated entries.
    pub key: String,
    /// Placeholder bindings, substituted into `%{name}` slots in the
    /// translated template at render time. `BTreeMap` so the wire
    /// form is deterministic — easier for test fixtures and easier
    /// for the client's render path to memoize.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
}

impl LocalizedString {
    pub fn new(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            params: BTreeMap::new(),
        }
    }

    pub fn with_param(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.params.insert(name.into(), value.into());
        self
    }

    /// Identity render against the English source — substitutes
    /// placeholders without touching any catalog. Useful for
    /// server-side log lines that should record what the user
    /// WOULD have seen had they been on English. The translated
    /// render lives in `foyer-i18n::render`.
    pub fn render_english(&self) -> String {
        let mut out = String::with_capacity(self.key.len());
        let mut rest = self.key.as_str();
        while let Some(start) = rest.find("%{") {
            out.push_str(&rest[..start]);
            let after = start + 2;
            match rest[after..].find('}') {
                Some(rel) => {
                    let name = &rest[after..after + rel];
                    match self.params.get(name) {
                        Some(v) => out.push_str(v),
                        None => out.push_str(&rest[start..after + rel + 1]),
                    }
                    rest = &rest[after + rel + 1..];
                }
                None => {
                    out.push_str(&rest[start..]);
                    rest = "";
                    break;
                }
            }
        }
        out.push_str(rest);
        out
    }
}

impl From<&str> for LocalizedString {
    fn from(s: &str) -> Self {
        Self::new(s)
    }
}

impl From<String> for LocalizedString {
    fn from(s: String) -> Self {
        Self::new(s)
    }
}
