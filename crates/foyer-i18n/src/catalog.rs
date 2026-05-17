// SPDX-License-Identifier: Apache-2.0
//! Locale catalog — flat `key → translation` JSON, one file per
//! locale. Loaded once at process start from an `include_dir!`
//! pointing at the workspace's `web/locales/` directory so the same
//! JSON files serve the browser (via static file routing) AND the
//! Rust process (via the bundled bytes here).

use std::collections::HashMap;

use include_dir::{include_dir, Dir};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The bundled tree. Path is relative to this crate's manifest dir.
/// `crates/foyer-i18n/../../web/locales` lands on the workspace's
/// canonical home for translations, which doubles as the static-
/// asset path the FE fetches at runtime.
static LOCALES_DIR: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../web/locales");

/// Per-locale metadata. Drives the locale picker UI; everything
/// else operates on the flat key map.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocaleMeta {
    pub code: String,
    /// English-language name of the locale (`"Spanish"`).
    pub name: String,
    /// Native-language name (`"Español"`). Used for the picker so
    /// users see their target language in its own script.
    #[serde(default)]
    pub native_name: String,
    /// Plural-form rule id. Recognised values:
    ///   * `"n_neq_1"` — Latin / Germanic / most romance languages.
    ///     Singular when `n == 1`, plural otherwise.
    ///   * `"single"` — languages with no morphological plural
    ///     (Japanese, Korean, Chinese, Vietnamese, Thai).
    ///
    ///     Anything else falls back to `"n_neq_1"`. Plural-rich
    ///     languages (Polish, Arabic, …) will need their own rule
    ///     names once we add catalogs for them.
    #[serde(default = "default_plural_rule")]
    pub plural_rule: String,
}

fn default_plural_rule() -> String {
    "n_neq_1".to_string()
}

pub struct Catalog {
    by_locale: HashMap<String, HashMap<String, String>>,
    metas: HashMap<String, LocaleMeta>,
}

impl Catalog {
    fn load() -> Self {
        let mut by_locale = HashMap::new();
        let mut metas = HashMap::new();
        for file in LOCALES_DIR.files() {
            let Some(stem) = file.path().file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if file.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(content) = std::str::from_utf8(file.contents()) else {
                tracing::warn!("foyer-i18n: non-utf8 catalog {}", stem);
                continue;
            };
            let parsed: Value = match serde_json::from_str(content) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!("foyer-i18n: skipping {}: parse error: {e}", stem);
                    continue;
                }
            };
            let Some(obj) = parsed.as_object() else {
                continue;
            };
            let mut flat: HashMap<String, String> = HashMap::with_capacity(obj.len());
            for (k, v) in obj {
                if k == "_meta" {
                    if let Ok(meta) = serde_json::from_value::<LocaleMeta>(v.clone()) {
                        metas.insert(stem.to_string(), meta);
                    }
                    continue;
                }
                if let Some(s) = v.as_str() {
                    flat.insert(k.clone(), s.to_string());
                }
            }
            by_locale.insert(stem.to_string(), flat);
        }
        if !metas.contains_key("en") {
            metas.insert(
                "en".into(),
                LocaleMeta {
                    code: "en".into(),
                    name: "English".into(),
                    native_name: "English".into(),
                    plural_rule: "n_neq_1".into(),
                },
            );
        }
        Self { by_locale, metas }
    }

    /// Look up `key` against `locale`. Falls back through the
    /// language-only form (e.g. `"es-MX"` → `"es"`) before
    /// surrendering to the source key.
    pub fn translate(&self, locale: &str, key: &str) -> String {
        if let Some(s) = self.lookup_exact(locale, key) {
            return s;
        }
        if let Some(lang) = locale.split('-').next().filter(|s| !s.is_empty()) {
            if lang != locale {
                if let Some(s) = self.lookup_exact(lang, key) {
                    return s;
                }
            }
        }
        key.to_string()
    }

    fn lookup_exact(&self, locale: &str, key: &str) -> Option<String> {
        self.by_locale.get(locale).and_then(|m| m.get(key)).cloned()
    }

    /// Plural lookup. Translations carry both forms in one entry
    /// joined by `||`, e.g. `"%{count} track||%{count} tracks"` →
    /// `"%{count} pista||%{count} pistas"`. Plural rule decided by
    /// the locale's `_meta.plural_rule`.
    pub fn translate_plural(
        &self,
        locale: &str,
        singular: &str,
        plural: &str,
        count: i64,
    ) -> String {
        let combined = combined_key(singular, plural);
        let rule = self
            .metas
            .get(locale)
            .or_else(|| {
                locale
                    .split('-')
                    .next()
                    .and_then(|lang| self.metas.get(lang))
            })
            .map(|m| m.plural_rule.as_str())
            .unwrap_or("n_neq_1");
        if let Some(entry) = self.lookup_exact(locale, &combined).or_else(|| {
            locale
                .split('-')
                .next()
                .filter(|lang| *lang != locale)
                .and_then(|lang| self.lookup_exact(lang, &combined))
        }) {
            let parts: Vec<&str> = entry.split("||").collect();
            let pick = pick_plural(rule, count, parts.len());
            if let Some(s) = parts.get(pick) {
                return (*s).to_string();
            }
        }
        // No translation; English-side picker.
        if count == 1 {
            singular.to_string()
        } else {
            plural.to_string()
        }
    }

    pub fn known_locales(&self) -> Vec<LocaleMeta> {
        let mut v: Vec<LocaleMeta> = self.metas.values().cloned().collect();
        v.sort_by(|a, b| a.code.cmp(&b.code));
        v
    }

    pub fn meta(&self, locale: &str) -> Option<&LocaleMeta> {
        self.metas
            .get(locale)
            .or_else(|| locale.split('-').next().and_then(|l| self.metas.get(l)))
    }
}

fn combined_key(singular: &str, plural: &str) -> String {
    let mut s = String::with_capacity(singular.len() + plural.len() + 2);
    s.push_str(singular);
    s.push_str("||");
    s.push_str(plural);
    s
}

fn pick_plural(rule: &str, count: i64, available_forms: usize) -> usize {
    match rule {
        "single" => 0,
        // Default: "n != 1" (Latin / Germanic / romance / Slavic-
        // simplified). Two forms.
        _ => {
            let idx = if count == 1 { 0 } else { 1 };
            idx.min(available_forms.saturating_sub(1))
        }
    }
}

static CATALOG: Lazy<Catalog> = Lazy::new(Catalog::load);

pub fn registry() -> &'static Catalog {
    &CATALOG
}
