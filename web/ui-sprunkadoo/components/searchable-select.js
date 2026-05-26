// Searchable popover picker. Replaces native `<select>` for any list
// that could grow long enough to scroll — GM patches (128), the live
// plugin catalog (often 200+ on a developer's box), preset lists,
// asset packs, etc.
//
// Why not native: dark-mode rendering on Chromium is inconsistent
// (white-on-white option text on some platforms), there's no inline
// filtering, and `<optgroup>` headers can't be styled to match a kid-
// friendly UI. Building one custom element solves all three at once.
//
// API:
//   <sprunki-searchable-select
//     .items=${[{value, label, group?, sublabel?}, …]}
//     .value=${currentValue}
//     .placeholder=${"Choose…"}
//     @change=${e => e.detail.value}
//   ></sprunki-searchable-select>
//
// `group` puts the item under a section header. `sublabel` is a small
// muted line under the main label (vendor name, bank, etc).

import { LitElement, html, css } from "lit";

export class SearchableSelect extends LitElement {
  static properties = {
    items: { type: Array },
    value: { type: String },
    placeholder: { type: String },
    disabled: { type: Boolean },
    _open: { state: true, type: Boolean },
    _query: { state: true, type: String },
    _highlightIdx: { state: true, type: Number },
  };

  static styles = css`
    :host { display: inline-block; position: relative; width: 100%; }
    .trigger {
      width: 100%;
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px;
      padding: 6px 10px;
      background: rgba(255,255,255,0.06);
      color: #e5e8ee;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 6px;
      font: 500 13px system-ui, sans-serif;
      cursor: pointer;
      min-height: 32px;
      box-sizing: border-box;
      text-align: left;
    }
    .trigger:hover:not(:disabled) { background: rgba(255,255,255,0.10); }
    .trigger:focus-visible { outline: 2px solid #8cb2ff; outline-offset: 1px; }
    .trigger:disabled { opacity: 0.5; cursor: not-allowed; }
    .trigger.placeholder .label-text { color: rgba(229,232,238,0.5); }
    .label-text {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex: 1;
    }
    .caret { flex-shrink: 0; color: rgba(229,232,238,0.6); font-size: 10px; }

    .popover {
      position: fixed;
      z-index: 10000;
      background: #1b1e25;
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 8px;
      box-shadow: 0 14px 36px rgba(0,0,0,0.55);
      display: flex; flex-direction: column;
      max-height: 340px;
      overflow: hidden;
    }
    .search { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .search input {
      width: 100%; box-sizing: border-box;
      padding: 6px 10px;
      background: rgba(255,255,255,0.08);
      color: #e5e8ee;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 6px;
      font: 500 13px system-ui, sans-serif;
    }
    .search input:focus { outline: none; border-color: rgba(140,178,255,0.7); }
    .list { overflow-y: auto; flex: 1; min-height: 0; }
    .group {
      padding: 8px 12px 3px;
      font: 700 10px system-ui, sans-serif;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: rgba(229,232,238,0.5);
      background: rgba(255,255,255,0.02);
    }
    .item {
      padding: 7px 12px;
      font: 500 13px system-ui, sans-serif;
      color: #e5e8ee;
      cursor: pointer;
      display: flex; flex-direction: column; gap: 1px;
    }
    .item:hover, .item.highlight { background: rgba(120,150,220,0.20); }
    .item.selected { color: #fff; font-weight: 600; }
    .item .row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px;
    }
    .item .check {
      color: #8cb2ff; flex-shrink: 0; font-size: 12px;
    }
    .item .sub {
      font-size: 11px;
      color: rgba(229,232,238,0.55);
    }
    .empty {
      padding: 18px 12px;
      text-align: center;
      color: rgba(229,232,238,0.55);
      font: 500 12px system-ui, sans-serif;
    }
  `;

  constructor() {
    super();
    this.items = [];
    this.value = "";
    this.placeholder = "Choose…";
    this.disabled = false;
    this._open = false;
    this._query = "";
    this._highlightIdx = 0;
    this._onDocPointer = (e) => {
      if (!this._open) return;
      if (e.composedPath().includes(this)) return;
      this._open = false;
    };
    this._onDocKey = (e) => this._handleKey(e);
    this._onReposition = () => { if (this._open) this._open = false; };
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this._onDocPointer, true);
    document.addEventListener("keydown", this._onDocKey, true);
    // Close on viewport changes — re-positioning the popover while
    // open is more work than just dismissing it; the kid can re-click.
    window.addEventListener("scroll", this._onReposition, true);
    window.addEventListener("resize", this._onReposition, true);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("pointerdown", this._onDocPointer, true);
    document.removeEventListener("keydown", this._onDocKey, true);
    window.removeEventListener("scroll", this._onReposition, true);
    window.removeEventListener("resize", this._onReposition, true);
  }

  _selectedItem() {
    return this.items.find((it) => String(it.value) === String(this.value)) || null;
  }

  _filtered() {
    const q = this._query.trim().toLowerCase();
    if (!q) return this.items;
    return this.items.filter((it) => {
      const l = String(it.label || "").toLowerCase();
      const g = String(it.group || "").toLowerCase();
      const s = String(it.sublabel || "").toLowerCase();
      return l.includes(q) || g.includes(q) || s.includes(q);
    });
  }

  _flatVisible() {
    return this._filtered().filter((it) => !it.disabled);
  }

  _onTriggerClick(e) {
    if (this.disabled) return;
    e.stopPropagation();
    if (this._open) { this._open = false; return; }
    this._query = "";
    // Highlight the currently selected item if visible.
    const flat = this._flatVisible();
    const cur = flat.findIndex((it) => String(it.value) === String(this.value));
    this._highlightIdx = cur >= 0 ? cur : 0;
    this._open = true;
    this.updateComplete.then(() => {
      this.renderRoot.querySelector("input")?.focus();
      this._scrollHighlightIntoView();
    });
  }

  _handleKey(e) {
    if (!this._open) return;
    const flat = this._flatVisible();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this._open = false;
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this._highlightIdx = Math.min(flat.length - 1, this._highlightIdx + 1);
      this._scrollHighlightIntoView();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this._highlightIdx = Math.max(0, this._highlightIdx - 1);
      this._scrollHighlightIntoView();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const it = flat[this._highlightIdx];
      if (it) this._pick(it.value);
    }
  }

  _scrollHighlightIntoView() {
    requestAnimationFrame(() => {
      const list = this.renderRoot.querySelector(".list");
      const hi = this.renderRoot.querySelector(".item.highlight");
      if (!list || !hi) return;
      const r = hi.getBoundingClientRect();
      const lr = list.getBoundingClientRect();
      if (r.top < lr.top) list.scrollBy(0, r.top - lr.top - 4);
      else if (r.bottom > lr.bottom) list.scrollBy(0, r.bottom - lr.bottom + 4);
    });
  }

  _pick(value) {
    this.value = value;
    this._open = false;
    this.dispatchEvent(new CustomEvent("change", {
      detail: { value },
      bubbles: true, composed: true,
    }));
  }

  _onQueryInput(e) {
    this._query = e.currentTarget.value;
    this._highlightIdx = 0;
  }

  _popoverGeometry() {
    const trig = this.renderRoot.querySelector(".trigger");
    if (!trig) return { left: 0, top: 0, width: 240 };
    const r = trig.getBoundingClientRect();
    const w = Math.max(240, r.width);
    // Keep within viewport; if there's not enough room below, flip up.
    const vh = window.innerHeight;
    const spaceBelow = vh - r.bottom;
    const flipUp = spaceBelow < 220 && r.top > spaceBelow;
    const top = flipUp ? Math.max(8, r.top - 8 - 340) : r.bottom + 4;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    return { left, top, width: w };
  }

  render() {
    const sel = this._selectedItem();
    const showPlaceholder = !sel;
    return html`
      <button
        type="button"
        class="trigger ${showPlaceholder ? "placeholder" : ""}"
        ?disabled=${this.disabled}
        title=${sel?.label || this.placeholder}
        @click=${this._onTriggerClick}
      >
        <span class="label-text">${sel?.label || this.placeholder}</span>
        <span class="caret">▾</span>
      </button>
      ${this._open ? this._renderPopover() : ""}
    `;
  }

  _renderPopover() {
    const pos = this._popoverGeometry();
    const filtered = this._filtered();
    // Build sections from the filtered items, preserving order.
    const sections = [];
    let cur = null;
    for (const it of filtered) {
      const g = it.group || "";
      if (!cur || cur.group !== g) {
        cur = { group: g, items: [] };
        sections.push(cur);
      }
      cur.items.push(it);
    }
    const flat = filtered.filter((it) => !it.disabled);
    return html`
      <div
        class="popover"
        style=${`left:${pos.left}px;top:${pos.top}px;width:${pos.width}px;`}
        @pointerdown=${(e) => e.stopPropagation()}
      >
        <div class="search">
          <input
            type="text"
            placeholder="Type to filter…"
            autocomplete="off"
            spellcheck="false"
            .value=${this._query}
            @input=${this._onQueryInput}
            @keydown=${this._handleKey}
          />
        </div>
        <div class="list" role="listbox">
          ${sections.length === 0 || filtered.length === 0
            ? html`<div class="empty">No matches</div>`
            : sections.map((section) => html`
                ${section.group ? html`<div class="group">${section.group}</div>` : ""}
                ${section.items.map((it) => {
                  const flatIdx = flat.indexOf(it);
                  const isHi = flatIdx === this._highlightIdx;
                  const isSel = String(it.value) === String(this.value);
                  return html`
                    <div
                      class="item ${isSel ? "selected" : ""} ${isHi ? "highlight" : ""}"
                      role="option"
                      aria-selected=${isSel ? "true" : "false"}
                      @click=${() => !it.disabled && this._pick(it.value)}
                      @mouseenter=${() => { if (flatIdx >= 0) this._highlightIdx = flatIdx; }}
                    >
                      <div class="row">
                        <span>${it.label}</span>
                        ${isSel ? html`<span class="check">✓</span>` : ""}
                      </div>
                      ${it.sublabel ? html`<span class="sub">${it.sublabel}</span>` : ""}
                    </div>
                  `;
                })}
              `)}
        </div>
      </div>
    `;
  }
}

customElements.define("sprunki-searchable-select", SearchableSelect);
