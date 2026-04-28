// Lightweight text preview with:
//  - markdown for .md (hand-rolled minimal parser)
//  - syntax coloring for .json / .xml / .yaml / .lua / .js / .ts via a tiny
//    tokenizer — enough to look decent without a full highlight.js.
//  - plain monospace for everything else
//
// Fetches file contents via foyer-server's path listing / WS? No — there's no
// READ_FILE command yet. Using `fetch` against the jail proxy we have at
// `/files/<path>` — which we'll add to foyer-server. For now, show an inert
// placeholder; the file-read command lands in a follow-up.

import { LitElement, html, css } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

export class TextPreview extends LitElement {
  static properties = {
    path: { type: String },
    _content: { state: true, type: String },
    _loading: { state: true, type: Boolean },
    _error: { state: true, type: String },
  };

  static styles = css`
    :host { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
    .toolbar {
      display: flex; gap: 8px; align-items: center;
      padding: 6px 12px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text-muted);
      font-size: 11px;
    }
    .toolbar .path { font-family: var(--font-mono); color: var(--color-text); }
    .body {
      flex: 1;
      overflow: auto;
      padding: 14px 18px;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.55;
      color: var(--color-text);
    }
    .md h1, .md h2, .md h3, .md h4 {
      font-family: var(--font-sans);
      color: var(--color-text);
      margin: 1em 0 0.4em;
      font-weight: 700;
    }
    .md h1 { font-size: 20px; }
    .md h2 { font-size: 16px; }
    .md h3 { font-size: 14px; }
    .md h4 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .md p  { margin: 0.6em 0; }
    .md code {
      background: var(--color-surface-elevated);
      padding: 1px 5px;
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--color-accent-3);
    }
    .md pre {
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      padding: 10px 12px;
      overflow-x: auto;
    }
    .md pre code {
      background: transparent;
      padding: 0;
      color: var(--color-text);
    }
    .md ul, .md ol { padding-left: 20px; margin: 0.6em 0; }
    .md li { margin: 0.2em 0; }
    .md a  { color: var(--color-accent-3); text-decoration: underline; }
    .md blockquote {
      border-left: 3px solid var(--color-accent);
      padding-left: 10px;
      margin: 0.6em 0;
      color: var(--color-text-muted);
    }
    .md hr {
      border: none;
      border-top: 1px solid var(--color-border);
      margin: 1.2em 0;
    }
    .tok-str      { color: #a5d6a7; }
    .tok-num      { color: #ffcc80; }
    .tok-kw       { color: #c4b5fd; font-weight: 600; }
    .tok-punc     { color: var(--color-text-muted); }
    .tok-key      { color: #90caf9; }
    .tok-comment  { color: var(--color-text-muted); font-style: italic; }
    .tok-tag      { color: #90caf9; }
    .tok-attr     { color: #ffcc80; }
    .empty { color: var(--color-text-muted); padding: 20px; }
  `;

  constructor() {
    super();
    this.path = "";
    this._content = "";
    this._loading = false;
    this._error = "";
  }

  updated(changed) {
    if (changed.has("path")) this._load();
  }

  async _load() {
    this._content = "";
    this._error = "";
    if (!this.path) return;
    this._loading = true;
    try {
      const resp = await fetch("/files/" + encodeURI(this.path));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ct = resp.headers.get("content-type") || "";
      if (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(this.path)) {
        this._content = `__IMAGE__${this.path}`;
      } else {
        this._content = await resp.text();
      }
    } catch (e) {
      this._error = String(e.message || e);
    } finally {
      this._loading = false;
    }
  }

  _kind() {
    const p = this.path.toLowerCase();
    if (p.endsWith(".md") || p.endsWith(".markdown")) return "md";
    if (p.endsWith(".json")) return "json";
    if (p.endsWith(".xml") || p.endsWith(".ardour") || p.endsWith(".svg") || p.endsWith(".html")) return "xml";
    if (p.endsWith(".yaml") || p.endsWith(".yml")) return "yaml";
    if (p.endsWith(".lua")) return "lua";
    if (p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".ts")) return "js";
    if (p.endsWith(".css")) return "css";
    if (p.endsWith(".toml")) return "toml";
    return "plain";
  }

  render() {
    return html`
      <div class="toolbar">
        <span>preview</span>
        <span class="path">${this.path || "—"}</span>
      </div>
      <div class="body">${this._renderContent()}</div>
    `;
  }

  _renderContent() {
    if (!this.path) return html`<div class="empty">Select a file from the session view to preview it here.</div>`;
    if (this._loading) return html`<div class="empty">Loading…</div>`;
    if (this._error)   return html`<div class="empty">Couldn't read ${this.path}: ${this._error}</div>`;
    if (!this._content) return html`<div class="empty">(empty)</div>`;
    if (this._content.startsWith("__IMAGE__")) {
      return html`<img src="/files/${encodeURI(this.path)}" style="max-width:100%">`;
    }
    const kind = this._kind();
    if (kind === "md") {
      return html`<div class="md">${unsafeHTML(renderMarkdown(this._content))}</div>`;
    }
    if (kind !== "plain") {
      return html`<pre>${unsafeHTML(tokenize(this._content, kind))}</pre>`;
    }
    return html`<pre>${this._content}</pre>`;
  }
}
customElements.define("foyer-text-preview", TextPreview);

// ─────────────────────────────────────────────────────────────────────────
// Minimal markdown renderer. Handles headings, bold/italic/code, links,
// lists, blockquotes, code fences, hr. Not CommonMark-complete but good
// enough for the files we'll see.

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inlineMd(s) {
  // Protect inline code first so we don't mangle its contents.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  return s;
}

function renderMarkdown(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    // code fence
    if (/^```/.test(l)) {
      const lang = l.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i]); i++;
      }
      i++; // skip closing fence
      const code = body.join("\n");
      const hi = lang ? tokenize(code, lang) : escapeHtml(code);
      out.push(`<pre><code>${hi}</code></pre>`);
      continue;
    }
    // hr
    if (/^\s*(---|\*\*\*|___)\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    // headings
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inlineMd(h[2])}</h${lvl}>`);
      i++; continue;
    }
    // blockquote
    if (/^>\s?/.test(l)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote>${inlineMd(buf.join(" "))}</blockquote>`);
      continue;
    }
    // list
    if (/^\s*[-*]\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++;
      }
      out.push("<ul>" + items.map(t => `<li>${inlineMd(t)}</li>`).join("") + "</ul>");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++;
      }
      out.push("<ol>" + items.map(t => `<li>${inlineMd(t)}</li>`).join("") + "</ol>");
      continue;
    }
    // blank → paragraph break
    if (/^\s*$/.test(l)) { i++; continue; }
    // paragraph
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^```/.test(lines[i]) && !/^>\s/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${inlineMd(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Tiny tokenizer for code blocks. Not perfect but never wrong enough to
// annoy. Emits spans of classes `tok-str|num|kw|punc|key|comment|tag|attr`.

const KW = {
  js: ["const", "let", "var", "function", "return", "if", "else", "for", "while",
       "class", "import", "export", "from", "async", "await", "new", "of", "in",
       "this", "null", "undefined", "true", "false", "try", "catch", "throw", "typeof"],
  ts: [], // reuse js below
  lua: ["local", "function", "end", "if", "then", "else", "elseif", "return",
        "for", "while", "do", "in", "and", "or", "not", "nil", "true", "false",
        "require"],
  toml: [],
  yaml: [],
  json: ["true", "false", "null"],
  css: [],
};
KW.ts = KW.js;

function tokenize(src, kind) {
  src = src.replace(/\r/g, "");
  if (kind === "xml") return tokenizeXml(src);
  if (kind === "css") return tokenizeCss(src);
  if (kind === "yaml" || kind === "toml") return tokenizeYaml(src);
  return tokenizeGeneric(src, kind);
}

function tokenizeGeneric(src, kind) {
  const kws = KW[kind] || [];
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    // line comment
    if (src.startsWith("//", i) || (kind === "lua" && src.startsWith("--", i))) {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += `<span class="tok-comment">${escapeHtml(src.slice(i, stop))}</span>`;
      i = stop;
      continue;
    }
    // block comment /* */
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += `<span class="tok-comment">${escapeHtml(src.slice(i, stop))}</span>`;
      i = stop;
      continue;
    }
    // string
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === "\\") j += 2; else j++;
      }
      j = Math.min(j + 1, src.length);
      out += `<span class="tok-str">${escapeHtml(src.slice(i, j))}</span>`;
      i = j; continue;
    }
    // number
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9._eE+-]/.test(src[j])) j++;
      out += `<span class="tok-num">${escapeHtml(src.slice(i, j))}</span>`;
      i = j; continue;
    }
    // identifier / keyword
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (kws.includes(word)) {
        out += `<span class="tok-kw">${escapeHtml(word)}</span>`;
      } else if (kind === "json" && src[j] === ":" && /[\w-]/.test(word[0])) {
        out += `<span class="tok-key">${escapeHtml(word)}</span>`;
      } else {
        out += escapeHtml(word);
      }
      i = j; continue;
    }
    if (/[{}()\[\],.:;]/.test(c)) {
      out += `<span class="tok-punc">${escapeHtml(c)}</span>`;
      i++; continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

function tokenizeXml(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      const stop = end === -1 ? src.length : end + 3;
      out += `<span class="tok-comment">${escapeHtml(src.slice(i, stop))}</span>`;
      i = stop; continue;
    }
    if (src[i] === "<") {
      const end = src.indexOf(">", i);
      const stop = end === -1 ? src.length : end + 1;
      const tag = src.slice(i, stop);
      // coarse: tag name + attrs
      const highlighted = tag.replace(
        /^(<\/?)([A-Za-z][A-Za-z0-9_:-]*)([\s\S]*)(\/?>)$/,
        (_, open, name, rest, close) => {
          const attrs = rest.replace(/([\w:-]+)="([^"]*)"/g,
            (_1, k, v) => `<span class="tok-attr">${escapeHtml(k)}</span>=<span class="tok-str">"${escapeHtml(v)}"</span>`);
          return `<span class="tok-punc">${open}</span><span class="tok-tag">${escapeHtml(name)}</span>${attrs}<span class="tok-punc">${close}</span>`;
        }
      );
      out += highlighted === tag ? escapeHtml(tag) : highlighted;
      i = stop; continue;
    }
    out += escapeHtml(src[i]);
    i++;
  }
  return out;
}

function tokenizeCss(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => `<span class="tok-comment">${escapeHtml(m)}</span>`)
    .replace(/^([\s\w.#:*,\-\[\]>"'=()]+)\s*\{/gm,
      (_, sel) => `<span class="tok-key">${escapeHtml(sel)}</span>{`)
    .replace(/([\w-]+)\s*:/g, (_, k) => `<span class="tok-attr">${escapeHtml(k)}</span>:`);
}

function tokenizeYaml(src) {
  return src
    .split("\n")
    .map(line => {
      const m = /^(\s*)([\w.-]+)\s*:\s*(.*)$/.exec(line);
      if (m) {
        return `${m[1]}<span class="tok-key">${escapeHtml(m[2])}</span>: <span class="tok-str">${escapeHtml(m[3])}</span>`;
      }
      if (/^\s*#/.test(line)) return `<span class="tok-comment">${escapeHtml(line)}</span>`;
      return escapeHtml(line);
    })
    .join("\n");
}
