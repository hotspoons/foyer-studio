// SPDX-License-Identifier: Apache-2.0
//! Foyer Studio runtime i18n. Drupal-style: every user-facing string
//! is its own English source key; per-locale JSON catalogs map that
//! key to a translation; missing translations fall through to the
//! source key so nothing breaks while a locale is incomplete.
//!
//! Shape:
//!
//!   * Catalogs live as flat JSON at `web/locales/<lang>.json`. The
//!     SAME files are served statically to the browser AND baked
//!     into every Rust binary via `include_dir!`, so FE + BE never
//!     drift.
//!   * [`tr!`] resolves a translation + substitutes `%{var}`
//!     placeholders. [`tn!`] is the plural variant — same as
//!     gettext's `ngettext`.
//!   * The English path is the identity function: `tr!("en", "Hello
//!     %{name}", name = "rich")` skips the catalog entirely. This
//!     keeps the hot path zero-cost when nobody has flipped locales.
//!
//! Multi-client note: a Foyer server may be serving five clients in
//! five locales simultaneously. There is NO global "current locale"
//! on the server. Every BE call site that emits human text either
//! takes a `locale: &str` explicitly OR (for events that fan out to
//! all subscribers) emits a [`LocalizedString`](localized::LocalizedString)
//! over the wire so each client renders in its own locale at
//! receive time.

pub mod catalog;

use std::collections::BTreeMap;

pub use catalog::{registry, Catalog, LocaleMeta};
pub use foyer_schema::LocalizedString;

/// Substitute `%{var}` placeholders in `template` using `params`.
/// Unknown placeholders are left literal (helps developers spot
/// typos during locale work); extra params are ignored. Same syntax
/// Drupal `t()` used so existing translation muscle memory carries
/// over.
pub fn interpolate(template: &str, params: &BTreeMap<String, String>) -> String {
    if params.is_empty() {
        return template.to_string();
    }
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("%{") {
        out.push_str(&rest[..start]);
        let after_open = start + 2;
        match rest[after_open..].find('}') {
            Some(rel) => {
                let key = &rest[after_open..after_open + rel];
                match params.get(key) {
                    Some(val) => out.push_str(val),
                    None => out.push_str(&rest[start..after_open + rel + 1]),
                }
                rest = &rest[after_open + rel + 1..];
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

/// Look up `key` in `locale`'s catalog. Falls through to `key`
/// itself when the locale is English, unknown, or has no entry.
pub fn translate(locale: &str, key: &str) -> String {
    if locale.is_empty() || locale.starts_with("en") {
        return key.to_string();
    }
    registry().translate(locale, key)
}

/// Plural-aware lookup. Catalog stores plural entries with the
/// pipe-pipe-joined key `"singular||plural"` so a single flat map
/// stays the wire format. Falls through to the English source forms
/// when no translation exists.
pub fn translate_plural(locale: &str, singular: &str, plural: &str, count: i64) -> String {
    if locale.is_empty() || locale.starts_with("en") {
        return if count == 1 { singular } else { plural }.to_string();
    }
    registry().translate_plural(locale, singular, plural, count)
}

/// Top-level helper used by the `tr!` macro for the no-params case.
/// Kept separate so `tr!("foo")` doesn't pay for an empty BTreeMap.
pub fn tr_raw(locale: &str, key: &str) -> String {
    translate(locale, key)
}

/// Render a `LocalizedString` against the given locale. Used by FE-
/// adjacent code paths that receive a structured server message and
/// need a plain string for logging.
pub fn render(locale: &str, ls: &LocalizedString) -> String {
    let template = translate(locale, &ls.key);
    interpolate(&template, &ls.params)
}

/// Drupal-style translation macro.
///
/// ```ignore
/// use foyer_i18n::tr;
/// let s = tr!("es", "Open %{name}?", name = session.title);
/// ```
#[macro_export]
macro_rules! tr {
    ($locale:expr, $key:literal $(,)?) => {{
        $crate::tr_raw($locale, $key)
    }};
    ($locale:expr, $key:literal, $($pkey:ident = $pval:expr),+ $(,)?) => {{
        let mut __params = ::std::collections::BTreeMap::<::std::string::String, ::std::string::String>::new();
        $(
            __params.insert(
                ::std::stringify!($pkey).to_string(),
                ::std::string::ToString::to_string(&$pval),
            );
        )+
        let __t = $crate::translate($locale, $key);
        $crate::interpolate(&__t, &__params)
    }};
}

/// Plural variant. The `count` value substitutes for the `%{count}`
/// placeholder automatically if the template has one.
///
/// ```ignore
/// use foyer_i18n::tn;
/// let s = tn!("es", "%{count} track", "%{count} tracks", n);
/// ```
#[macro_export]
macro_rules! tn {
    ($locale:expr, $singular:literal, $plural:literal, $count:expr $(,)?) => {{
        let __n: i64 = ($count) as i64;
        let __t = $crate::translate_plural($locale, $singular, $plural, __n);
        let mut __params = ::std::collections::BTreeMap::<::std::string::String, ::std::string::String>::new();
        __params.insert("count".into(), __n.to_string());
        $crate::interpolate(&__t, &__params)
    }};
    ($locale:expr, $singular:literal, $plural:literal, $count:expr, $($pkey:ident = $pval:expr),+ $(,)?) => {{
        let __n: i64 = ($count) as i64;
        let __t = $crate::translate_plural($locale, $singular, $plural, __n);
        let mut __params = ::std::collections::BTreeMap::<::std::string::String, ::std::string::String>::new();
        __params.insert("count".into(), __n.to_string());
        $(
            __params.insert(
                ::std::stringify!($pkey).to_string(),
                ::std::string::ToString::to_string(&$pval),
            );
        )+
        $crate::interpolate(&__t, &__params)
    }};
}

/// Build a [`LocalizedString`] inline at a server emit site. Sister
/// to `tr!` but produces the wire shape that travels to clients
/// instead of a fully-rendered string.
///
/// ```ignore
/// use foyer_i18n::loc;
/// Event::Error(loc!("Project %{name} is read-only", name = path.display()));
/// ```
#[macro_export]
macro_rules! loc {
    ($key:literal $(,)?) => {{
        $crate::LocalizedString::new($key)
    }};
    ($key:literal, $($pkey:ident = $pval:expr),+ $(,)?) => {{
        let mut __ls = $crate::LocalizedString::new($key);
        $(
            __ls = __ls.with_param(
                ::std::stringify!($pkey),
                ::std::string::ToString::to_string(&$pval),
            );
        )+
        __ls
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolate_simple() {
        let mut p = BTreeMap::new();
        p.insert("name".into(), "rich".into());
        assert_eq!(interpolate("Hello %{name}", &p), "Hello rich");
    }

    #[test]
    fn interpolate_missing_stays_literal() {
        let p = BTreeMap::new();
        assert_eq!(interpolate("Hello %{name}", &p), "Hello %{name}");
    }

    #[test]
    fn interpolate_multi() {
        let mut p = BTreeMap::new();
        p.insert("a".into(), "1".into());
        p.insert("b".into(), "2".into());
        assert_eq!(interpolate("%{a} and %{b} and %{a}", &p), "1 and 2 and 1");
    }

    #[test]
    fn tr_macro_english_identity() {
        assert_eq!(tr!("en", "Hello"), "Hello");
        let s = tr!("en", "Hello %{name}", name = "rich");
        assert_eq!(s, "Hello rich");
    }

    #[test]
    fn tn_macro_picks_form() {
        assert_eq!(tn!("en", "1 track", "%{count} tracks", 1), "1 track");
        assert_eq!(tn!("en", "1 track", "%{count} tracks", 5), "5 tracks");
    }

    #[test]
    fn loc_macro_builds_wire_shape() {
        let ls = loc!("Open %{name}?", name = "X");
        assert_eq!(ls.key, "Open %{name}?");
        assert_eq!(ls.params.get("name").map(String::as_str), Some("X"));
    }
}
