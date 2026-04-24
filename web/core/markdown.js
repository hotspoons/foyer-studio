// SPDX-License-Identifier: Apache-2.0
//
// Markdown + syntax highlight for chat bodies.
//
// Libraries are loaded lazily via <script> tags on first render so the
// ~170 KB of marked + hljs + yaml grammar never hits users who don't
// open the chat FAB. Both ship as UMD globals (the browser-friendly
// build shape vendored from the reference project), so we adopt them
// from `window.marked` / `window.hljs` once loaded and re-export as an
// ES-module façade.

const MARKED_URL = "/vendor/marked/marked.min.js";
const HLJS_URL = "/vendor/highlight/highlight.min.js";
const HLJS_YAML_URL = "/vendor/highlight/hljs-yaml.min.js";
const HLJS_CSS_URL = "/vendor/highlight/highlight.css";

let _ready = null;
let _configured = false;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-foyer-md="${url}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
      } else {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`failed to load ${url}`)), { once: true });
      }
      return;
    }
    const s = document.createElement("script");
    s.src = url;
    s.async = false;
    s.dataset.foyerMd = url;
    s.addEventListener("load", () => { s.dataset.loaded = "true"; resolve(); }, { once: true });
    s.addEventListener("error", () => reject(new Error(`failed to load ${url}`)), { once: true });
    document.head.appendChild(s);
  });
}

function loadStylesheet(url) {
  if (document.querySelector(`link[data-foyer-md="${url}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  link.dataset.foyerMd = url;
  document.head.appendChild(link);
}

/**
 * Kick off lazy load (idempotent). Returns a promise that resolves when
 * `window.marked` + `window.hljs` are ready. Subsequent calls return the
 * same in-flight promise.
 */
export function ensureMarkdownReady() {
  if (_ready) return _ready;
  _ready = (async () => {
    loadStylesheet(HLJS_CSS_URL);
    // Load marked + hljs in parallel; the yaml grammar depends on hljs.
    await Promise.all([loadScript(MARKED_URL), loadScript(HLJS_URL)]);
    await loadScript(HLJS_YAML_URL).catch((e) => {
      // YAML grammar failing to load isn't fatal — plain fenced blocks
      // still render.
      console.warn("[markdown] yaml grammar:", e);
    });
    configureMarked();
  })();
  return _ready;
}

function configureMarked() {
  if (_configured) return;
  if (typeof window.marked === "undefined") return;
  window.marked.setOptions({ breaks: false, gfm: true });
  if (typeof window.hljs !== "undefined") {
    const renderer = {
      code(token) {
        const lang = (token.lang || "").toLowerCase();
        const code = token.text || "";
        if (lang && window.hljs.getLanguage(lang)) {
          try {
            const hl = window.hljs.highlight(code, { language: lang }).value;
            return `<pre><code class="hljs language-${lang}">${hl}</code></pre>`;
          } catch {
            // Fall through to plain rendering on grammar error.
          }
        }
        return `<pre><code>${escapeHtml(code)}</code></pre>`;
      },
    };
    window.marked.use({ renderer });
  }
  _configured = true;
}

function escapeHtml(s) {
  const table = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return (s || "").replace(/[&<>"']/g, (c) => table[c]);
}

/**
 * Render `md` (markdown) to a sanitized-ish HTML string. If the libs
 * haven't loaded yet, returns escaped plain text; the caller should
 * await `ensureMarkdownReady()` before calling for the richest output.
 *
 * @param {string | null | undefined} md
 * @returns {string}
 */
export function renderMarkdown(md) {
  const input = md || "";
  if (typeof window.marked === "undefined") {
    return `<pre>${escapeHtml(input)}</pre>`;
  }
  configureMarked();
  try {
    return window.marked.parse(input);
  } catch (err) {
    console.warn("[markdown] parse failed:", err);
    return escapeHtml(input);
  }
}
