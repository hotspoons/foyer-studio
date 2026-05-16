// SPDX-License-Identifier: Apache-2.0
//
// foyer-code-editor — lightweight syntax-highlighted text editor.
//
// Uses a contenteditable <pre><code> element with caret-position
// preservation around each re-highlight. hljs is loaded lazily so the
// ~80 KB grammar bundle stays out of the boot path; the host scripting
// surface (foyer-script-editor) is currently the only consumer and it
// already gates on a user opening the Scripts panel.
//
// Grammars beyond `lua` can be added by extending `LANG_URLS` below.
// Pass `language=""` to render plaintext (no highlighting).

import { LitElement, html, css, nothing } from "lit";

const HLJS_URL = "/vendor/highlight/highlight.min.js";
const HLJS_CSS_URL = "/vendor/highlight/highlight.css";

// Map of `language` prop value → vendor URL. Add a new grammar by
// dropping the file into `web/vendor/highlight/` and listing it here.
const LANG_URLS = {
  lua: "/vendor/highlight/hljs-lua.min.js",
  yaml: "/vendor/highlight/hljs-yaml.min.js",
};

const LOADED_LANGS = new Set();
let _coreReady = null;
// Cached highlight.css text. The browser <link rel="stylesheet"> in <head>
// only styles top-level DOM — it does NOT cross shadow-root boundaries,
// which is why hljs.* classes rendered no color in our shadow-rooted
// editor. We fetch the stylesheet text once and inject a <style> clone
// into each editor's shadow root.
let _themeCssText = null;
let _themeCssPromise = null;
async function loadThemeCss() {
  if (_themeCssText) return _themeCssText;
  if (_themeCssPromise) return _themeCssPromise;
  _themeCssPromise = (async () => {
    try {
      const r = await fetch(HLJS_CSS_URL);
      _themeCssText = await r.text();
    } catch {
      _themeCssText = ""; // fall back to plain colors
    }
    return _themeCssText;
  })();
  return _themeCssPromise;
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-foyer-hljs="${url}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`load ${url}`)), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = url;
    s.async = false;
    s.dataset.foyerHljs = url;
    s.addEventListener(
      "load",
      () => {
        s.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    s.addEventListener("error", () => reject(new Error(`load ${url}`)), { once: true });
    document.head.appendChild(s);
  });
}

function loadStylesheet(url) {
  if (document.querySelector(`link[data-foyer-hljs="${url}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  link.dataset.foyerHljs = url;
  document.head.appendChild(link);
}

async function ensureHljsReady() {
  if (_coreReady) return _coreReady;
  _coreReady = (async () => {
    loadStylesheet(HLJS_CSS_URL);
    try {
      await loadScript(HLJS_URL);
    } catch {
      /* hljs missing → plaintext */
    }
  })();
  return _coreReady;
}

async function ensureLanguage(lang) {
  if (!lang || !LANG_URLS[lang] || LOADED_LANGS.has(lang)) return;
  await ensureHljsReady();
  if (typeof window.hljs === "undefined") return;
  try {
    await loadScript(LANG_URLS[lang]);
    LOADED_LANGS.add(lang);
  } catch {
    /* grammar missing → plaintext */
  }
}

export class CodeEditor extends LitElement {
  static properties = {
    value: { type: String },
    language: { type: String },
    readonly: { type: Boolean, reflect: true },
    hideLineNumbers: { type: Boolean, attribute: "hide-line-numbers" },
    placeholder: { type: String },
    /** Used to seed the editor on attach (changes after attach are
     *  ignored to avoid clobbering edits in-progress; emit an
     *  `editor-change` listener if you need round-trip). */
    minHeight: { type: String, attribute: "min-height" },
  };

  static styles = css`
    :host {
      display: block;
      position: relative;
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 12px;
      line-height: 1.5;
      color: var(--color-text, #ddd);
      background: var(--color-surface-deep, #111);
      border: 1px solid var(--color-border, #333);
      border-radius: 4px;
      overflow: hidden;
    }
    :host(:focus-within) {
      border-color: var(--color-accent, #5a8);
    }
    .wrap {
      display: flex;
      overflow: auto;
      min-height: var(--ce-min-height, 200px);
      max-height: 100%;
    }
    .gutter {
      flex: 0 0 auto;
      padding: 8px 8px 8px 12px;
      text-align: right;
      color: var(--color-text-muted, #777);
      background: var(--color-surface, #1a1a1a);
      border-right: 1px solid var(--color-border, #333);
      user-select: none;
      white-space: pre;
      font-size: 11px;
      line-height: 18px;
    }
    .gutter.hidden { display: none; }
    pre.editor {
      position: relative;
      margin: 0;
      flex: 1;
      padding: 8px 12px;
      outline: none;
      caret-color: var(--color-accent, #5a8);
      min-height: 100%;
      overflow: visible;
      white-space: pre;
      tab-size: 2;
      -moz-tab-size: 2;
    }
    pre.editor[contenteditable="false"] {
      cursor: default;
    }
    code.code {
      font: inherit;
      background: transparent;
      display: block;
      min-height: 18px;
    }
    /* Placeholder sits absolute-positioned inside the editor pre at
       the pre's content-box origin. Inherits the pre's left padding
       so the placeholder text starts where the caret would, without
       depending on the gutter width. */
    .placeholder {
      position: absolute;
      top: 8px;
      left: 12px;
      pointer-events: none;
      color: var(--color-text-muted, #888);
      font-style: italic;
    }
  `;

  constructor() {
    super();
    this.value = "";
    this.language = "";
    this.readonly = false;
    this.hideLineNumbers = false;
    this.placeholder = "";
    this.minHeight = "200px";
    this._text = "";
    this._focused = false;
    this._suppressUpdate = false;
  }

  willUpdate(changed) {
    if (changed.has("value") && !this._suppressUpdate) {
      this._text = this.value ?? "";
    }
    if (changed.has("language")) {
      ensureLanguage(this.language).then(() => this._applyHighlight());
    }
  }

  firstUpdated() {
    ensureLanguage(this.language).then(() => this._applyHighlight());
    // Inject the highlight.js theme into the shadow root so its
    // `.hljs-*` color rules actually reach the rendered tokens.
    // Without this, hljs.highlight() emits the right spans but every
    // token paints in the inherited foreground colour and the editor
    // looks like plain text.
    loadThemeCss().then((cssText) => {
      if (!cssText || !this.renderRoot) return;
      try {
        const style = document.createElement("style");
        style.textContent = cssText;
        this.renderRoot.appendChild(style);
      } catch {}
    });
  }

  updated(changed) {
    if (changed.has("value") && !this._suppressUpdate && !this._focused) {
      this._applyHighlight();
    }
    this._suppressUpdate = false;
  }

  // ── Caret math (offset-into-textContent, robust across innerHTML swaps) ──

  _caretOffset(container) {
    const sel = this.shadowRoot.getSelection?.() || window.getSelection();
    if (!sel || !sel.rangeCount) return 0;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.startContainer)) return 0;
    const pre = document.createRange();
    pre.selectNodeContents(container);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  }

  _setCaretOffset(container, offset) {
    const sel = this.shadowRoot.getSelection?.() || window.getSelection();
    const range = document.createRange();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let pos = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const len = node.textContent.length;
      if (pos + len >= offset) {
        range.setStart(node, offset - pos);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      pos += len;
    }
    range.selectNodeContents(container);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  _codeEl() {
    return this.renderRoot?.querySelector?.("code.code");
  }

  _applyHighlight() {
    const el = this._codeEl();
    if (!el) return;
    const text = this._text ?? "";
    if (!text) {
      el.innerHTML = "\n";
      return;
    }
    if (
      typeof window.hljs !== "undefined" &&
      this.language &&
      window.hljs.getLanguage?.(this.language)
    ) {
      try {
        el.innerHTML =
          window.hljs.highlight(text, {
            language: this.language,
            ignoreIllegals: true,
          }).value + "\n";
        return;
      } catch {
        /* fall through */
      }
    }
    el.textContent = text + "\n";
  }

  _onInput() {
    const el = this._codeEl();
    if (!el) return;
    const offset = this._caretOffset(el);
    this._text = el.textContent.replace(/\n$/, "");
    this._applyHighlight();
    this._setCaretOffset(el, offset);
    this._emitChange();
  }

  _onKeydown(e) {
    const el = this._codeEl();
    if (!el) return;
    if (e.key === "Tab") {
      e.preventDefault();
      const offset = this._caretOffset(el);
      const text = this._text;
      if (e.shiftKey) {
        const before = text.substring(0, offset);
        const ls = before.lastIndexOf("\n") + 1;
        const n = text.substring(ls).match(/^ {1,2}/)?.[0]?.length || 0;
        if (n) {
          this._text = text.substring(0, ls) + text.substring(ls + n);
          this._applyHighlight();
          this._setCaretOffset(el, Math.max(ls, offset - n));
          this._emitChange();
        }
      } else {
        this._text = text.substring(0, offset) + "  " + text.substring(offset);
        this._applyHighlight();
        this._setCaretOffset(el, offset + 2);
        this._emitChange();
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const offset = this._caretOffset(el);
      const text = this._text;
      const before = text.substring(0, offset);
      const lastNl = before.lastIndexOf("\n");
      const line = before.substring(lastNl + 1);
      const indent = line.match(/^(\s*)/)[1];
      const insert = "\n" + indent;
      this._text = text.substring(0, offset) + insert + text.substring(offset);
      this._applyHighlight();
      this._setCaretOffset(el, offset + insert.length);
      this._emitChange();
    }
  }

  _onPaste(e) {
    e.preventDefault();
    const text = e.clipboardData?.getData?.("text/plain") ?? "";
    if (!text) return;
    const el = this._codeEl();
    if (!el) return;
    const startOffset = this._caretOffset(el);
    const current = this._text;
    this._text = current.substring(0, startOffset) + text + current.substring(startOffset);
    this._applyHighlight();
    this._setCaretOffset(el, startOffset + text.length);
    this._emitChange();
  }

  _emitChange() {
    this._suppressUpdate = true;
    this.value = this._text;
    this.dispatchEvent(
      new CustomEvent("editor-change", {
        detail: { value: this._text },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    const ro = this.readonly;
    const empty = !this._text && !this._focused;
    const lines = (this._text || "").split("\n");
    // Render the placeholder as an absolutely-positioned sibling
    // inside .wrap (which is the flex container holding the gutter +
    // pre). Positioning relative to the wrap means we don't need to
    // calculate the gutter width — the placeholder sits on top of
    // the editor cell and inherits its padding via .editor's padding.
    return html`
      <div class="wrap" style="--ce-min-height:${this.minHeight}">
        <div class="gutter ${this.hideLineNumbers ? "hidden" : ""}">
          ${lines.map((_, i) => html`${i + 1}\n`)}
        </div>
        <pre
          class="editor"
          contenteditable=${ro ? "false" : "true"}
          spellcheck="false"
          tabindex=${ro ? "-1" : "0"}
          @input=${ro ? null : () => this._onInput()}
          @keydown=${ro ? null : (e) => this._onKeydown(e)}
          @paste=${ro ? null : (e) => this._onPaste(e)}
          @focus=${() => (this._focused = true)}
          @blur=${() => (this._focused = false)}
        ><code class="code hljs"></code>${empty && this.placeholder
            ? html`<span class="placeholder">${this.placeholder}</span>`
            : nothing}</pre>
      </div>
    `;
  }
}

customElements.define("foyer-code-editor", CodeEditor);
