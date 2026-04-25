// Single-tile leaf — the actual content pane. Has a thin header with a view
// picker, a close button, and a focus indicator. The body mounts whichever
// view the leaf currently holds.

import { LitElement, html, css } from "lit";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";
import { icon } from "foyer-ui-core/icons.js";

import { listViews, registerView } from "foyer-core/registry/views.js";
import { showContextMenu } from "foyer-ui-core/widgets/context-menu.js";

import "./text-preview.js";

// Built-in views that every tile needs to know about regardless of UI
// (the preview tile is a core facility for text/markdown inspection).
// Concrete view elements (mixer, timeline, etc.) live in the UI
// package and register themselves when the UI boots. tile-leaf then
// reads the registry at render-time — no hard-coded tag list, no
// ui-core → ui import edge.
registerView({ id: "preview", label: "Preview", icon: "document", elementTag: "foyer-text-preview", order: 999 });

/** Live view catalog — recomputed every render so late registrations
 *  from alternate UIs show up without explicit subscribe. */
function viewCatalog() {
  const m = new Map();
  for (const v of listViews()) m.set(v.id, v);
  return m;
}

export class TileLeaf extends LitElement {
  static properties = {
    leaf: { type: Object },
    store: { type: Object },
    _focused: { state: true, type: Boolean },
    /**
     * Menu mode: `""` (closed), `"swap"` (change this tile's view),
     * `"split-row"` (pick a view for a new tile to the right),
     * `"split-column"` (pick a view for a new tile below).
     */
    _menuMode: { state: true, type: String },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      margin: 4px;
      overflow: hidden;
      transition: border-color 0.12s ease;
    }
    :host([focused]) {
      border-color: var(--color-accent);
      box-shadow: 0 0 0 1px color-mix(in oklab, var(--color-accent) 40%, transparent);
    }

    header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px;
      background: var(--color-surface-elevated);
      border-bottom: 1px solid var(--color-border);
      font-family: var(--font-sans);
      font-size: 10px;
      color: var(--color-text-muted);
      cursor: pointer;
      user-select: none;
    }
    header .label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text);
    }
    header button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font: inherit;
      font-size: 10px;
      color: var(--color-text-muted);
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      padding: 2px 6px;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    header button:hover {
      color: var(--color-text);
      border-color: var(--color-border);
      background: var(--color-surface);
    }
    header .spacer { flex: 1; }

    .body {
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
      display: flex;
      position: relative;
      overflow: hidden;
    }

    .menu {
      /* Inline left/top are set by _openMenu from the trigger
       * button's bounding rect so the menu drops below whichever
       * button opened it. Defaults below as a safety net. */
      position: absolute;
      top: 28px;
      left: 6px;
      min-width: 200px;
      background: color-mix(in oklab, var(--color-surface-elevated) 92%, transparent);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid color-mix(in oklab, var(--color-border) 70%, transparent);
      border-radius: var(--radius-lg, 10px);
      box-shadow: var(--shadow-panel);
      padding: 6px;
      z-index: 10;
      user-select: none;
    }
    .menu-heading {
      padding: 4px 10px 6px;
      font-size: 9px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--color-text-muted);
      font-weight: 600;
    }
    .menu-hint {
      padding: 0 10px 4px;
      font-size: 9px;
      color: var(--color-text-muted);
      opacity: 0.7;
    }
    .menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 7px 10px;
      font-family: var(--font-sans);
      font-size: 12px;
      font-weight: 500;
      color: var(--color-text);
      background: transparent;
      border: 0;
      border-radius: var(--radius-sm);
      cursor: grab;
      text-align: left;
      transition: background 0.12s ease, color 0.12s ease, transform 0.1s ease;
      touch-action: none;
    }
    .menu-item:hover {
      background: linear-gradient(90deg,
        color-mix(in oklab, var(--color-accent) 35%, transparent),
        color-mix(in oklab, var(--color-accent-2) 25%, transparent));
      color: #fff;
    }
    .menu-item.tearing {
      opacity: 0.7;
      cursor: grabbing;
      transform: scale(0.98);
    }
    .menu-item .icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 6px;
      background: color-mix(in oklab, var(--color-accent) 15%, transparent);
      color: var(--color-accent-3);
      flex: 0 0 auto;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .menu-item:hover .icon {
      background: rgba(255,255,255,0.18);
      color: #fff;
    }
    .menu-item .grip {
      margin-left: auto;
      font-family: var(--font-mono);
      font-size: 9px;
      color: var(--color-text-muted);
      opacity: 0.55;
    }
    .menu-item:hover .grip {
      color: #fff;
      opacity: 0.9;
    }
  `;

  constructor() {
    super();
    this._focused = false;
    this._menuMode = "";
    this._onStoreChange = () => {
      const f = this.store?.focusId === this.leaf?.id;
      if (f !== this._focused) {
        this._focused = f;
        if (f) this.setAttribute("focused", ""); else this.removeAttribute("focused");
      }
      this.requestUpdate();
    };
    this._onDocClick = (e) => {
      if (this._menuMode && !this.renderRoot.querySelector(".menu")?.contains(e.target)) {
        this._menuMode = "";
      }
    };
    // The body of this tile reads session from the data store at render time,
    // so we need to re-render whenever the snapshot / controls change — not
    // only on layout changes.
    this._onDataChange = () => this.requestUpdate();
  }

  connectedCallback() {
    super.connectedCallback();
    this.store?.addEventListener("change", this._onStoreChange);
    this._onStoreChange();
    window.__foyer?.store?.addEventListener("change", this._onDataChange);
    document.addEventListener("click", this._onDocClick, true);
  }
  disconnectedCallback() {
    this.store?.removeEventListener("change", this._onStoreChange);
    window.__foyer?.store?.removeEventListener("change", this._onDataChange);
    document.removeEventListener("click", this._onDocClick, true);
    super.disconnectedCallback();
  }

  _focus() { this.store?.focus(this.leaf.id); }

  _swapView(id) {
    this._menuMode = "";
    this.store?.focus(this.leaf.id);
    this.store?.setFocusedView(id);
  }

  _close(ev) {
    ev.stopPropagation();
    // Removing the last tile should leave the workspace empty — the
    // "Workspace is empty · use New menu" placeholder renders then.
    // Without allowEmpty the store backfills with a fresh mixer, which
    // is indistinguishable to the user from "close didn't work."
    this.store?.removeLeaf(this.leaf.id, { allowEmpty: true });
  }

  /** Apply the selected view to whatever action the menu was opened for. */
  _pickView(id) {
    const mode = this._menuMode;
    this._menuMode = "";
    this.store?.focus(this.leaf.id);
    if (mode === "split-row") {
      this.store?.split("row", id);
    } else if (mode === "split-column") {
      this.store?.split("column", id);
    } else {
      this.store?.setFocusedView(id);
    }
  }

  _openMenu(mode, ev) {
    ev.stopPropagation();
    this.store?.focus(this.leaf.id);
    // Anchor the menu to the button the user actually clicked.
    // Previously the menu CSS pinned `left: 6px; top: 28px` so a
    // mixer / timeline tile's view-picker always popped in the
    // upper-left of the tile regardless of where the trigger button
    // sat. Capture the button's offset within the host so the menu
    // hangs immediately below it (Rich, TODO #54).
    const btn = ev.currentTarget;
    const host = this.getBoundingClientRect();
    const r = btn?.getBoundingClientRect?.();
    if (r && host) {
      this._menuLeft = Math.max(2, Math.round(r.left - host.left));
      this._menuTop  = Math.max(2, Math.round(r.bottom - host.top + 2));
    } else {
      this._menuLeft = 6;
      this._menuTop  = 28;
    }
    this._menuMode = this._menuMode === mode ? "" : mode;
  }

  _float() {
    this.store?.focus(this.leaf.id);
    this.store?.floatFocused();
  }

  /**
   * Right-click anywhere in the tile (header or body) pops a rescue menu.
   * Essential when the title-bar buttons are hard to hit, and the
   * desktop-environment framing means native right-click should never
   * surface browser chrome.
   */
  _onContextMenu(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    this.store?.focus(this.leaf.id);
    const items = [
      { heading: viewCatalog().get(this.leaf.view)?.label || this.leaf.view },
      {
        label: "Change view…",
        icon: "adjustments-horizontal",
        action: () => { this._menuMode = "swap"; this.requestUpdate(); },
      },
      { separator: true },
      {
        label: "Split right as…",
        icon: "split-right",
        action: () => { this._menuMode = "split-row"; this.requestUpdate(); },
      },
      {
        label: "Split below as…",
        icon: "split-below",
        action: () => { this._menuMode = "split-column"; this.requestUpdate(); },
      },
      { separator: true },
      {
        label: "Float (detach)",
        icon: "arrow-top-right-on-square",
        action: () => this._float(),
      },
      {
        label: "Dock to slot…",
        icon: "squares-2x2",
        action: () => this._dockTarget(),
      },
      { separator: true },
      {
        label: "Close tile",
        icon: "x-mark",
        tone: "danger",
        action: () => this.store?.closeFocused(),
      },
    ];
    showContextMenu(ev, items);
  }

  /**
   * Dock-target: detach the tile to a floating window and immediately open
   * the slot picker so the user can pick where it lands. Two-click flow —
   * click the dock icon, then click the slot.
   */
  _dockTarget() {
    this.store?.focus(this.leaf.id);
    const view = this.leaf.view;
    const props = this.leaf.props || {};
    this.store?.closeFocused();
    const id = this.store?.openFloating(view, props);
    if (!id) return;
    // Defer one tick so the floating window mounts, then prompt for the slot.
    setTimeout(() => {
      const ft = window.__foyer?.floatingTiles;
      if (ft) ft._slotPickerFor = id;
    }, 0);
  }

  /**
   * Tear-out: if the pointer moves past a threshold while still down on the
   * header, detach this leaf into a floating window at the cursor and hand
   * the drag off to floating-tiles' own drag handler (via a synthesized
   * pointerdown on the new window's header).
   *
   * Below the threshold, the usual click/focus behavior wins.
   */
  _headerDown(ev) {
    // Left mouse button only. Ignore clicks on nested buttons — they do their
    // own thing.
    if (ev.button !== 0) return;
    if (ev.target && ev.target.closest("button")) return;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const THRESHOLD = 8;
    let tore = false;

    const move = (e) => {
      if (tore) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (dx * dx + dy * dy < THRESHOLD * THRESHOLD) return;
      tore = true;
      this._tearOut(e.clientX, e.clientY);
      cleanup();
    };
    const up = () => cleanup();
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  async _tearOut(x, y) {
    const view = this.leaf.view;
    const props = this.leaf.props || {};
    const w = 540;
    const h = 360;
    const placement = {
      x: Math.max(0, x - w / 2),
      y: Math.max(0, y - 12),
      w,
      h,
    };
    // Tear-out path: remove the leaf and ALLOW the tree to be empty. The
    // default backfill-with-mixer used to kick in here, which looked like
    // "the window I dragged duplicated itself in place."
    this.store?.removeLeaf(this.leaf.id, { allowEmpty: true });
    const id = this.store?.openFloating(view, props, placement);
    if (!id) return;

    // Dynamically import to avoid a circular dependency with layout-store.
    const [{ dropZones }, { slotBounds }] = await Promise.all([
      import("./drop-zones.js"),
      import("./slots.js"),
    ]);
    const zones = dropZones();
    zones.show();
    zones.update(x, y);

    // Alt/Ctrl/Shift during the tear drag hides the slot grid and drops the
    // torn-out window at raw pixel coordinates — same bypass chord as the
    // floating-tile drag path.
    const isBypass = (e) => !!(e && (e.altKey || e.ctrlKey || e.shiftKey));
    const move = (e) => {
      const nx = Math.max(0, e.clientX - w / 2);
      const ny = Math.max(0, e.clientY - 12);
      this.store.floatSet(id, { x: nx, y: ny, slot: null });
      if (isBypass(e)) {
        zones.setBypassed(true);
      } else {
        zones.setBypassed(false);
        zones.update(e.clientX, e.clientY);
      }
    };
    const up = (e) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const snap = zones.currentSlot();
      zones.hide();
      if (snap && !isBypass(e)) {
        const rect = slotBounds(snap);
        if (rect) {
          this.store.floatSet(id, { ...rect, slot: snap });
          try {
            localStorage.setItem(`foyer.layout.sticky.${view}`, snap);
          } catch {}
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  render() {
    const meta = viewCatalog().get(this.leaf.view) || { id: this.leaf.view, label: this.leaf.view, icon: "document" };
    return html`
      <header
        @click=${() => this._focus()}
        @pointerdown=${(e) => this._headerDown(e)}
        @contextmenu=${(e) => this._onContextMenu(e)}
      >
        <button @click=${(e) => this._openMenu("swap", e)}
                title="Change view">
          ${icon(meta.icon, 12)}
          <span class="label">${meta.label}</span>
        </button>
        <span class="spacer"></span>
        <button @click=${this._close} title="Close tile">${icon("close", 12)}</button>
        <!-- Split / Float / Dock-to-slot buttons removed 2026-04-25.
             Identical actions are reachable from the right-click
             context menu and the top "+ New" menu, so the chrome was
             pure visual noise on every tile. (Rich, TODO #50.) -->

      </header>
      <div class="body"
           @pointerdown=${() => this._focus()}
           @contextmenu=${(e) => this._onContextMenu(e)}>
        ${this._renderBody(meta)}
      </div>
      ${this._menuMode ? this._renderMenu() : null}
    `;
  }

  _renderMenu() {
    const items = Array.from(viewCatalog().values()).filter(v => v.id !== "preview");
    const heading = this._menuMode === "split-row"    ? "Split right as…"
                  : this._menuMode === "split-column" ? "Split below as…"
                  : "Change view to…";
    const hint = this._menuMode === "swap"
      ? "Click to swap · drag out to float"
      : "Click to split · drag out to float";
    const style = `left:${this._menuLeft ?? 6}px;top:${this._menuTop ?? 28}px`;
    return html`
      <div class="menu" style=${style} @click=${(e) => e.stopPropagation()}>
        <div class="menu-heading">${heading}</div>
        <div class="menu-hint">${hint}</div>
        ${items.map(v => html`
          <button
            class="menu-item"
            @click=${() => this._pickView(v.id)}
            @pointerdown=${(e) => this._menuItemDown(e, v)}
          >
            <span class="icon">${icon(v.icon, 14)}</span>
            <span class="label">${v.label}</span>
            <span class="grip">⠿</span>
          </button>
        `)}
      </div>
    `;
  }

  /**
   * Drag a menu item out to tear it into the workspace as a floating window.
   * Under the threshold the pointer-up still fires the button's @click
   * (which does the swap/split); past the threshold we switch into
   * tear-out mode and hand the drag off to drop-zones + layout store.
   */
  _menuItemDown(ev, viewMeta) {
    if (ev.button !== 0) return;
    const startX = ev.clientX;
    const startY = ev.clientY;
    const THRESHOLD = 10;
    const button = ev.currentTarget;
    let tore = false;

    const move = (e) => {
      if (tore) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (dx * dx + dy * dy < THRESHOLD * THRESHOLD) return;
      tore = true;
      // Block the item's @click from firing on pointerup.
      button.addEventListener("click", swallow, { once: true, capture: true });
      button.classList.add("tearing");
      this._menuMode = "";
      this._tearMenuItem(viewMeta, e.clientX, e.clientY);
      cleanup();
    };
    const up = () => cleanup();
    const swallow = (e) => { e.stopImmediatePropagation(); e.preventDefault(); };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  async _tearMenuItem(viewMeta, x, y) {
    const view = viewMeta.id;
    const w = 540;
    const h = 360;
    const placement = {
      x: Math.max(0, x - w / 2),
      y: Math.max(0, y - 14),
      w, h,
    };
    const id = this.store?.openFloating(view, {}, placement);
    if (!id) return;

    const [{ dropZones }, { slotBounds }] = await Promise.all([
      import("./drop-zones.js"),
      import("./slots.js"),
    ]);
    const zones = dropZones();
    zones.show();
    zones.update(x, y);

    const isBypass = (e) => !!(e && (e.altKey || e.ctrlKey || e.shiftKey));
    const move = (e) => {
      const nx = Math.max(0, e.clientX - w / 2);
      const ny = Math.max(0, e.clientY - 14);
      this.store.floatSet(id, { x: nx, y: ny, slot: null });
      if (isBypass(e)) {
        zones.setBypassed(true);
      } else {
        zones.setBypassed(false);
        zones.update(e.clientX, e.clientY);
      }
    };
    const up = (e) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const snap = zones.currentSlot();
      zones.hide();
      if (snap && !isBypass(e)) {
        const rect = slotBounds(snap);
        if (rect) {
          this.store.floatSet(id, { ...rect, slot: snap });
          try { localStorage.setItem(`foyer.layout.sticky.${view}`, snap); } catch {}
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  _renderBody() {
    const v = this.leaf.view;
    const session = window.__foyer?.store?.state.session || null;
    const meta = viewCatalog().get(v);
    if (!meta || !meta.elementTag) {
      return html`<div style="padding:20px;color:var(--color-text-muted)">
        Unknown view: ${v}. Register it with
        <code>registerView({ id: "${v}", elementTag: "my-element" })</code>.
      </div>`;
    }
    // Static-html + unsafeStatic lets Lit treat `<${tag}>` as a stable
    // template part: same tag across renders = same DOM node, so the
    // mounted element's lifecycle (connected/disconnected/state) isn't
    // churned every re-render. An earlier pass used
    // `document.createElement()` here, which broke reuse — the mixer's
    // Listen-preference apply, the timeline's waveform caching, and
    // audio-listener contexts all re-mounted on every store change,
    // producing a Listen-start loop + the screen-flash on refresh.
    const tag = unsafeStatic(meta.elementTag);
    const path = this.leaf.props?.path || "";
    return staticHtml`<${tag} .session=${session} .path=${path}></${tag}>`;
  }
}
customElements.define("foyer-tile-leaf", TileLeaf);
