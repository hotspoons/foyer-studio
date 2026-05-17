// SPDX-License-Identifier: Apache-2.0
//
// Drupal-style runtime i18n for the browser. Shares its catalog
// files (`/locales/<lang>.json`) with the Rust side, so when a string
// is translated for the agent or server emit path it's translated
// for the FE too.
//
// API:
//
//   import { t, tn, setLocale, currentLocale, renderLocalized } from "/core/i18n.js";
//   t("Open %{name}?", { name: session.title });
//   tn("%{count} track", "%{count} tracks", count, { count });
//   await setLocale("es");
//   renderLocalized({ key: "Foo %{x}", params: { x: "1" } });
//
// English is the identity path — `t("Hello")` returns `"Hello"`
// without touching the catalog. The translation work only kicks in
// when the user has flipped locales.
//
// The current locale is broadcast via the `foyer:locale-changed`
// CustomEvent on `window` so Lit components can listen and call
// `requestUpdate()`. Any component that calls `t()` from a `render()`
// method should listen for this event in `connectedCallback`.

const STORAGE_KEY = "foyer.locale";
const EVENT_NAME = "foyer:locale-changed";

const _state = {
  // Active locale code (`"en"`, `"es"`, …). Always-set so callers
  // don't have to null-check; English is the runtime default.
  locale: "en",
  // `lang → { key → translation }` map. English is implicit and
  // missing here — translate() short-circuits before the lookup.
  catalogs: Object.create(null),
  // `lang → _meta` (code / name / native_name / plural_rule).
  // Populated alongside catalogs so the picker UI can render
  // localized labels.
  metas: Object.create(null),
  // Per-locale "loading" promise so concurrent setLocale() calls
  // don't spawn duplicate fetches.
  loading: Object.create(null),
};

/// Look up a translation. Falls back to `key` (English source) when
/// the locale is English, the catalog is missing, or the entry is
/// missing. Substitutes `%{var}` placeholders from `params`.
export function t(key, params) {
  const tpl = _translate(_state.locale, key);
  return _interpolate(tpl, params);
}

/// Plural variant. `count` is the discriminator; it's also bound to
/// the `%{count}` placeholder automatically so the template can
/// reference it without the caller having to thread it through
/// `params` separately.
export function tn(singular, plural, count, params) {
  const tpl = _translatePlural(_state.locale, singular, plural, count);
  const merged = Object.assign({ count }, params || {});
  return _interpolate(tpl, merged);
}

/// Render a server-emitted `LocalizedString` ({ key, params }) using
/// the current locale. The server can't know which locale each
/// connected client wants, so it sends the structured form and we
/// resolve it on receipt. Accepts a plain string too (legacy
/// pre-i18n events) — returns it verbatim.
export function renderLocalized(ls) {
  if (ls == null) return "";
  if (typeof ls === "string") return ls;
  if (typeof ls !== "object" || typeof ls.key !== "string") return String(ls);
  const tpl = _translate(_state.locale, ls.key);
  return _interpolate(tpl, ls.params || {});
}

/// Switch locale. Triggers a JSON fetch on first use of a given
/// locale, broadcasts `foyer:locale-changed` so live components can
/// re-render, and persists the choice in localStorage.
///
/// Pass `code = "en"` to revert to the English identity path; that's
/// the fast path and skips the fetch.
export async function setLocale(code) {
  if (!code) code = "en";
  // Trim trailing whitespace, normalise case so `"ES"` works.
  code = String(code).trim();
  if (!code) code = "en";
  const norm = code.toLowerCase();
  // English is implicit — never fetched.
  if (norm === "en" || norm.startsWith("en-")) {
    _state.locale = norm;
    _persist();
    _broadcast();
    return;
  }
  if (!_state.catalogs[norm]) {
    await _ensureCatalog(norm);
  }
  _state.locale = norm;
  _persist();
  _broadcast();
}

/// Read the active locale code. Cheap; safe to call from `render()`.
export function currentLocale() {
  return _state.locale;
}

/// Returns the locale's `_meta` object (or undefined). The picker UI
/// uses this to label entries with `native_name`.
export function localeMeta(code) {
  if (!code) code = _state.locale;
  return _state.metas[code.toLowerCase()];
}

/// List of catalogs known to be loaded (or available to load). The
/// picker queries this to populate its dropdown. Note: English is
/// always included even if `/locales/en.json` isn't present — it's
/// the identity case.
export function availableLocales() {
  const seen = new Set(["en"]);
  for (const k of Object.keys(_state.metas)) seen.add(k);
  return Array.from(seen).sort();
}

/// Bootstrap entry point. Called from `web/core/bootstrap.js` early
/// in boot so any module that imports `t` synchronously can rely on
/// the user's preferred locale being loaded by the time the first
/// render runs. Idempotent.
export async function installI18n() {
  // Resolution order: explicit user choice in localStorage > the
  // browser's preferred language (`navigator.language`) > `"en"`.
  // The browser fallback only matches if we have a catalog for it —
  // we never request a locale the server doesn't ship.
  let preferred = _readStored();
  if (!preferred) {
    const bcp = (navigator.language || "en").toLowerCase();
    const root = bcp.split("-")[0];
    // Try the catalog manifest first so we know what's available.
    await _ensureManifest();
    if (_state.metas[bcp]) preferred = bcp;
    else if (_state.metas[root]) preferred = root;
    else preferred = "en";
  } else {
    await _ensureManifest();
  }
  await setLocale(preferred);
}

// ─── Internals ────────────────────────────────────────────────────

function _translate(locale, key) {
  if (!locale || locale === "en" || locale.startsWith("en-")) return key;
  const exact = _state.catalogs[locale];
  if (exact && key in exact) return exact[key];
  // BCP-47 fallback: "es-MX" → "es".
  const root = locale.split("-")[0];
  if (root !== locale) {
    const cat = _state.catalogs[root];
    if (cat && key in cat) return cat[key];
  }
  return key;
}

function _translatePlural(locale, singular, plural, count) {
  if (!locale || locale === "en" || locale.startsWith("en-")) {
    return count === 1 ? singular : plural;
  }
  const combined = singular + "||" + plural;
  const exact = _state.catalogs[locale];
  const root = locale.split("-")[0];
  const rootCat = root !== locale ? _state.catalogs[root] : null;
  const meta = _state.metas[locale] || _state.metas[root];
  const rule = (meta && meta.plural_rule) || "n_neq_1";
  const entry = (exact && exact[combined]) || (rootCat && rootCat[combined]);
  if (entry) {
    const parts = entry.split("||");
    const pick = _pickPlural(rule, count, parts.length);
    if (parts[pick] != null) return parts[pick];
  }
  return count === 1 ? singular : plural;
}

function _pickPlural(rule, count, formCount) {
  if (rule === "single") return 0;
  // Default: n_neq_1.
  const idx = count === 1 ? 0 : 1;
  return Math.min(idx, Math.max(0, formCount - 1));
}

function _interpolate(template, params) {
  if (!params) return template;
  const keys = Object.keys(params);
  if (keys.length === 0) return template;
  // Single pass, regex-free so a bad placeholder doesn't blow up
  // template rendering.
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("%{", i);
    if (open < 0) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const close = template.indexOf("}", open + 2);
    if (close < 0) {
      out += template.slice(open);
      break;
    }
    const name = template.slice(open + 2, close);
    if (Object.prototype.hasOwnProperty.call(params, name)) {
      out += String(params[name]);
    } else {
      out += template.slice(open, close + 1);
    }
    i = close + 1;
  }
  return out;
}

/// Fetch `/locales/<code>.json` once and cache it. Resolves to the
/// catalog object so callers can chain off it; rejects gracefully
/// (no exception out of `setLocale`) when the catalog isn't present
/// — i18n is best-effort, missing translations just degrade to
/// English.
function _ensureCatalog(code) {
  if (_state.loading[code]) return _state.loading[code];
  const p = fetch(`/locales/${encodeURIComponent(code)}.json`, {
    credentials: "same-origin",
    cache: "no-cache",
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((doc) => {
      if (!doc || typeof doc !== "object") return null;
      const flat = Object.create(null);
      for (const [k, v] of Object.entries(doc)) {
        if (k === "_meta") {
          _state.metas[code] = v;
          continue;
        }
        if (typeof v === "string") flat[k] = v;
      }
      _state.catalogs[code] = flat;
      return flat;
    })
    .catch((e) => {
      console.warn(`foyer-i18n: catalog ${code} unavailable —`, e);
      return null;
    });
  _state.loading[code] = p;
  return p;
}

let _manifestPromise = null;
/// One-shot fetch of `/locales/index.json` so the picker can list
/// catalogs without probing the FS. Server emits this from
/// `crates/foyer-i18n`'s known_locales list. Falls back to an empty
/// manifest when the server doesn't expose the endpoint (e.g. older
/// builds during a staged rollout).
function _ensureManifest() {
  if (_manifestPromise) return _manifestPromise;
  _manifestPromise = fetch("/locales/index.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((doc) => {
      if (!doc || !Array.isArray(doc.locales)) return;
      for (const meta of doc.locales) {
        if (meta && meta.code) _state.metas[meta.code] = meta;
      }
    })
    .catch(() => {});
  return _manifestPromise;
}

function _persist() {
  try {
    localStorage.setItem(STORAGE_KEY, _state.locale);
  } catch {}
}

function _readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function _broadcast() {
  try {
    window.dispatchEvent(
      new CustomEvent(EVENT_NAME, { detail: { locale: _state.locale } }),
    );
  } catch {}
}

/// Mixin convenience for Lit components: call from `connectedCallback`
/// to auto-`requestUpdate()` whenever the locale changes. Returns a
/// disposer the component should invoke from `disconnectedCallback`.
///
///   connectedCallback() {
///     super.connectedCallback();
///     this._i18nDispose = onLocaleChange(() => this.requestUpdate());
///   }
///   disconnectedCallback() {
///     super.disconnectedCallback();
///     this._i18nDispose?.();
///   }
export function onLocaleChange(handler) {
  const wrapper = () => handler();
  window.addEventListener(EVENT_NAME, wrapper);
  return () => window.removeEventListener(EVENT_NAME, wrapper);
}
