// SPDX-License-Identifier: Apache-2.0
//
// In-app relay chat FAB + panel.
//
// Follows the same quadrant-FAB pattern as `agent-panel.js` — drag the
// FAB anywhere, the panel anchors to the opposite corner; drop the FAB
// on the right rail to dock. The chat UI sits on top of `ChatStore`
// (web/core/chat.js) so every connected peer's browser gets the same
// message ring in real time. Markdown + syntax highlighting are lazy-
// loaded from `web/core/markdown.js` on panel first-open.
//
// PTT button lives in the composer: press-and-hold to speak, audio
// relays to everyone else's speakers. See `ChatStore.pttStart/pttStop`.

import { LitElement, html, css, nothing } from "lit";
import { icon } from "foyer-ui-core/icons.js";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";
import { ensureMarkdownReady, renderMarkdown } from "foyer-core/markdown.js";

const FAB_SIZE = 48;
const GAP = 8;
const LS_KEY = "foyer.chat.panel.v1";
const DEFAULT_STATE = {
  fabRight: 84,            // sits left of the agent FAB by default
  fabBottom: 24,
  panelWidth: 420,
  panelHeight: 540,
  open: false,
};

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}
function saveState(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export class FoyerChatPanel extends LitElement {
  static properties = {
    _fabRight: { state: true, type: Number },
    _fabBottom: { state: true, type: Number },
    _panelWidth: { state: true, type: Number },
    _panelHeight: { state: true, type: Number },
    _open: { state: true, type: Boolean },
    _input: { state: true, type: String },
    _tick: { state: true, type: Number },
    _snapshotPrompt: { state: true, type: Boolean },
    _snapshotName: { state: true, type: String },
  };

  static styles = css`
    ${scrollbarStyles}
    :host { display: contents; }

    .fab {
      position: fixed;
      width: ${FAB_SIZE}px;
      height: ${FAB_SIZE}px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--color-accent-2), var(--color-accent-3));
      color: #fff;
      border: none;
      cursor: grab;
      box-shadow: var(--shadow-fab);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      transition: box-shadow 0.15s ease, transform 0.15s ease;
      touch-action: none;
      user-select: none;
    }
    .fab:hover { box-shadow: var(--shadow-fab-hover); transform: scale(1.04); }
    .fab.dragging { cursor: grabbing; transition: none; }
    .fab.open { background: linear-gradient(135deg, var(--color-accent-3), var(--color-accent)); }
    .fab svg { width: 22px; height: 22px; stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .fab .badge {
      position: absolute; top: -4px; right: -4px;
      background: var(--color-error, #ef4444);
      color: #fff;
      border-radius: 999px;
      min-width: 18px; height: 18px;
      padding: 0 5px;
      font: 10px/18px var(--font-sans);
      font-weight: 700;
      text-align: center;
      pointer-events: none;
    }
    .speaker-ring {
      position: absolute; inset: -4px;
      border-radius: 50%;
      border: 2px solid var(--color-accent-2);
      animation: foyer-chat-pulse 1.2s ease-out infinite;
      pointer-events: none;
    }
    @keyframes foyer-chat-pulse {
      0%   { transform: scale(1);    opacity: 0.8; }
      100% { transform: scale(1.25); opacity: 0;   }
    }

    .panel {
      position: fixed;
      min-width: 320px;
      min-height: 320px;
      max-width: calc(100vw - 2.5rem);
      max-height: calc(100vh - 5rem);
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-panel);
      display: flex;
      flex-direction: column;
      z-index: 999;
      color: var(--color-text);
      overflow: hidden;
    }

    header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--color-border);
      cursor: grab;
      background: linear-gradient(180deg, var(--color-surface-muted), var(--color-surface-elevated));
    }
    header.dragging { cursor: grabbing; }
    header .title {
      font-family: var(--font-sans);
      font-weight: 600;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      background: linear-gradient(135deg, var(--color-accent-3), var(--color-accent-2));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    header .spacer { flex: 1; }
    header button {
      background: transparent;
      color: var(--color-text-muted);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      padding: 3px 6px;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    header button:hover { color: var(--color-text); border-color: var(--color-border); }
    header .ptt-banner {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px;
      background: color-mix(in oklab, var(--color-accent) 16%, transparent);
      border: 1px solid var(--color-accent-2);
      border-radius: var(--radius-sm);
      font-size: 10px;
      color: var(--color-text);
    }
    header .ptt-banner svg { width: 12px; height: 12px; }

    .transcript {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 12px;
      scrollbar-width: thin;
      scrollbar-color: var(--color-border) transparent;
    }
    .msg {
      display: flex; flex-direction: column; gap: 2px;
      padding: 8px 10px;
      border-radius: var(--radius-md);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      word-wrap: break-word;
    }
    .msg.self {
      align-self: flex-end;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border-color: transparent;
      max-width: 80%;
    }
    .msg:not(.self) { max-width: 90%; }
    .msg .meta {
      display: flex; gap: 6px; align-items: baseline;
      font-size: 10px; opacity: 0.7;
    }
    .msg .meta .who { font-weight: 600; }
    .msg .body {
      font-size: 12px;
      line-height: 1.5;
    }
    .msg .body p { margin: 0.25em 0; }
    .msg .body p:first-child { margin-top: 0; }
    .msg .body p:last-child  { margin-bottom: 0; }
    .msg .body pre {
      margin: 6px 0;
      padding: 8px;
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-surface) 80%, #000);
      color: var(--color-text);
      overflow-x: auto;
      font-size: 11px;
      font-family: var(--font-mono);
    }
    .msg.self .body pre { background: rgba(0,0,0,0.32); }
    .msg .body code {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 1px 4px;
      border-radius: 3px;
      background: color-mix(in oklab, var(--color-surface) 80%, #000);
    }
    .msg.self .body code { background: rgba(0,0,0,0.28); }
    .empty {
      color: var(--color-text-muted);
      font-size: 12px;
      padding: 24px 12px;
      text-align: center;
    }
    .empty strong { display: block; margin-bottom: 4px; color: var(--color-text); font-weight: 600; }

    .composer {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 6px;
      padding: 10px 12px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    .composer textarea {
      grid-column: 2 / 3;
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 6px 8px;
      font-family: var(--font-sans);
      font-size: 12px;
      resize: none;
      min-height: 36px;
      max-height: 140px;
    }
    .composer textarea:focus {
      outline: none;
      border-color: var(--color-accent);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-accent) 30%, transparent);
    }
    .composer button {
      width: 36px; height: 36px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-elevated);
      color: var(--color-text);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .composer button:hover:not(:disabled) {
      filter: brightness(1.1);
      transform: translateY(-1px);
    }
    .composer button:disabled { opacity: 0.45; cursor: not-allowed; }
    .composer button.send {
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff; border-color: transparent;
    }
    .composer button.ptt { position: relative; }
    .composer button.ptt.holding {
      background: linear-gradient(135deg, var(--color-accent-2), var(--color-accent-3));
      color: #fff; border-color: transparent;
    }
    .composer button.ptt.blocked { opacity: 0.35; cursor: not-allowed; }
    .composer button svg { width: 16px; height: 16px; stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

    .resize {
      position: absolute;
      width: 14px; height: 14px;
      z-index: 2;
    }
    .resize.nw { top: 0; left: 0;   cursor: nw-resize; }
    .resize.ne { top: 0; right: 0;  cursor: ne-resize; }
    .resize.sw { bottom: 0; left: 0; cursor: sw-resize; }
    .resize.se { bottom: 0; right: 0; cursor: se-resize; }

    .snapshot-row {
      display: flex; gap: 6px; padding: 6px 12px;
      border-top: 1px dashed var(--color-border);
      font-size: 11px;
      align-items: center;
    }
    .snapshot-row input {
      flex: 1;
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 4px 6px;
      font: inherit;
      font-size: 11px;
    }
    .snapshot-row button {
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 4px 10px;
      cursor: pointer;
      font: inherit; font-size: 11px;
    }
  `;

  storageKey = "foyer.chat";

  constructor() {
    super();
    const s = loadState();
    this._fabRight = s.fabRight;
    this._fabBottom = s.fabBottom;
    this._panelWidth = s.panelWidth;
    this._panelHeight = s.panelHeight;
    this._open = s.open;
    this._input = "";
    this._tick = 0;
    this._snapshotPrompt = false;
    this._snapshotName = "";
    this._dragState = null;
    this._resizeState = null;
    this._lastSeenCount = 0;
    this._unreadCount = 0;
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onWinResize = this._onWinResize.bind(this);
    this._onChatChange = () => {
      // Track unread when panel is closed.
      if (!this._open && !this._isDocked()) {
        const msgs = this._chat()?.messages ?? [];
        const added = Math.max(0, msgs.length - this._lastSeenCount);
        if (added > 0) this._unreadCount += added;
      }
      this._tick++;
      this._lastSeenCount = this._chat()?.messages?.length ?? 0;
      this.requestUpdate();
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);
    window.addEventListener("pointercancel", this._onPointerUp);
    window.addEventListener("resize", this._onWinResize);
    this._chat()?.addEventListener?.("change", this._onChatChange);
    // Register as a dockable FAB so the right-rail can show an icon
    // while docked (same affordance as the agent FAB).
    window.__foyer?.layout?.registerFab?.(
      this.storageKey,
      {
        label: "Chat",
        icon: "chat-bubble-left-right",
        accent: "accent-2",
        expandsRail: true,
        dockWidth: 400,
      },
      this,
    );
    // Refresh on greeting so self-id is available for "self" styling.
    window.__foyer?.store?.addEventListener?.("greeting", this._onChatChange);
    if (this._open) {
      ensureMarkdownReady().then(() => this.requestUpdate()).catch(() => {});
      this._chat()?.requestHistory?.();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);
    window.removeEventListener("pointercancel", this._onPointerUp);
    window.removeEventListener("resize", this._onWinResize);
    this._chat()?.removeEventListener?.("change", this._onChatChange);
    window.__foyer?.store?.removeEventListener?.("greeting", this._onChatChange);
    window.__foyer?.layout?.unregisterFab?.(this.storageKey);
    super.disconnectedCallback();
  }

  _chat() { return window.__foyer?.chat ?? null; }

  _isDocked() { return !!window.__foyer?.layout?.isFabDocked?.(this.storageKey); }

  _isOverRail(x, y) {
    const r = window.__foyer?.rightDock?.railRect?.();
    return !!(r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  }

  openFromDock(top) { this._dockIconTop = top; this._open = true; this._onOpen(); this._persist(); this.requestUpdate(); }
  closeFromDock() { this._open = false; this._persist(); this.requestUpdate(); }
  toggleFromDock(t) { if (this._open) this.closeFromDock(); else this.openFromDock(t); }

  dockPanelContent() { return this._renderPanelBody({ compact: true }); }

  onDockPanelOpen() { this._onOpen(); }

  _onOpen() {
    this._unreadCount = 0;
    this._lastSeenCount = this._chat()?.messages?.length ?? 0;
    ensureMarkdownReady().then(() => this.requestUpdate()).catch(() => {});
    this._chat()?.requestHistory?.();
  }

  _persist() {
    saveState({
      fabRight: this._fabRight,
      fabBottom: this._fabBottom,
      panelWidth: this._panelWidth,
      panelHeight: this._panelHeight,
      open: this._open,
    });
  }

  _onWinResize() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this._fabRight = Math.max(0, Math.min(vw - FAB_SIZE, this._fabRight));
    this._fabBottom = Math.max(0, Math.min(vh - FAB_SIZE, this._fabBottom));
    this._persist();
  }

  // ── drag + resize ───────────────────────────────────────────────

  _onFabDown(ev) {
    ev.preventDefault();
    this._dragState = {
      kind: "fab",
      startX: ev.clientX,
      startY: ev.clientY,
      origRight: this._fabRight,
      origBottom: this._fabBottom,
      vw: window.innerWidth,
      vh: window.innerHeight,
      moved: false,
      pointerId: ev.pointerId,
    };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    this.requestUpdate();
  }

  _onHeaderDown(ev) {
    ev.preventDefault();
    this._dragState = {
      kind: "panel-header",
      startX: ev.clientX,
      startY: ev.clientY,
      origRight: this._fabRight,
      origBottom: this._fabBottom,
      vw: window.innerWidth,
      vh: window.innerHeight,
      pointerId: ev.pointerId,
    };
  }

  _onResizeDown(ev, corner) {
    ev.preventDefault();
    ev.stopPropagation();
    const { isLeft, isTop } = this._quadrant();
    this._resizeState = {
      corner,
      startX: ev.clientX,
      startY: ev.clientY,
      origW: this._panelWidth,
      origH: this._panelHeight,
      panelGrowsE: !isLeft,
      panelGrowsS: !isTop,
    };
  }

  _onPointerMove(ev) {
    if (this._dragState?.kind === "fab") {
      const ds = this._dragState;
      const dx = ev.clientX - ds.startX;
      const dy = ev.clientY - ds.startY;
      if (!ds.moved && Math.hypot(dx, dy) > 4) ds.moved = true;
      this._fabRight = Math.max(0, Math.min(ds.vw - FAB_SIZE, ds.origRight - dx));
      this._fabBottom = Math.max(0, Math.min(ds.vh - FAB_SIZE, ds.origBottom - dy));
      window.__foyer?.rightDock?.setDropHighlight?.(this._isOverRail(ev.clientX, ev.clientY));
      this.requestUpdate();
    } else if (this._dragState?.kind === "panel-header") {
      const ds = this._dragState;
      const dx = ev.clientX - ds.startX;
      const dy = ev.clientY - ds.startY;
      this._fabRight = Math.max(0, Math.min(ds.vw - FAB_SIZE, ds.origRight - dx));
      this._fabBottom = Math.max(0, Math.min(ds.vh - FAB_SIZE, ds.origBottom - dy));
      this.requestUpdate();
    } else if (this._resizeState) {
      const rs = this._resizeState;
      const dx = ev.clientX - rs.startX;
      const dy = ev.clientY - rs.startY;
      const wSign = rs.corner.includes("e") === rs.panelGrowsE ? 1 : -1;
      const hSign = rs.corner.includes("s") === rs.panelGrowsS ? 1 : -1;
      this._panelWidth = Math.max(320, rs.origW + dx * wSign);
      this._panelHeight = Math.max(320, rs.origH + dy * hSign);
      this.requestUpdate();
    }
  }

  _onPointerUp(ev) {
    if (this._dragState?.kind === "fab") {
      const moved = this._dragState.moved;
      this._dragState = null;
      window.__foyer?.rightDock?.setDropHighlight?.(false);
      if (!moved) {
        this._open = !this._open;
        if (this._open) this._onOpen();
      } else if (ev && this._isOverRail(ev.clientX, ev.clientY)) {
        window.__foyer?.layout?.dockFab?.(this.storageKey);
        this._open = false;
      }
      this._persist();
      this.requestUpdate();
    } else if (this._dragState?.kind === "panel-header") {
      this._dragState = null;
      this._persist();
    } else if (this._resizeState) {
      this._resizeState = null;
      this._persist();
    }
  }

  _quadrant() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = vw - this._fabRight - FAB_SIZE / 2;
    const cy = vh - this._fabBottom - FAB_SIZE / 2;
    return { isTop: cy < vh / 2, isLeft: cx < vw / 2 };
  }

  _panelStyle() {
    const { isTop, isLeft } = this._quadrant();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fabTop = vh - this._fabBottom - FAB_SIZE;
    const parts = [];
    if (isTop) parts.push(`top: ${fabTop + FAB_SIZE + GAP}px`);
    else       parts.push(`bottom: ${this._fabBottom + FAB_SIZE + GAP}px`);
    if (isLeft) parts.push(`left: ${vw - this._fabRight - FAB_SIZE}px`);
    else        parts.push(`right: ${this._fabRight}px`);
    const fabLeftEdge = vw - this._fabRight - FAB_SIZE;
    const fabRightEdge = vw - this._fabRight;
    const maxW = isLeft
      ? Math.max(320, vw - fabLeftEdge - 16)
      : Math.max(320, fabRightEdge - 16);
    const maxH = isTop
      ? Math.max(320, vh - fabTop - FAB_SIZE - GAP - 16)
      : Math.max(320, vh - this._fabBottom - FAB_SIZE - GAP - 16);
    const w = Math.min(this._panelWidth, maxW);
    const h = Math.min(this._panelHeight, maxH);
    parts.push(`width: ${w}px`, `height: ${h}px`);
    return { style: parts.join("; "), isTop, isLeft };
  }

  // ── send + PTT handlers ────────────────────────────────────────

  _onInputKey(ev) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      this._send();
    }
  }
  _send() {
    const text = this._input.trim();
    if (!text) return;
    this._chat()?.send?.(text);
    this._input = "";
    this.requestUpdate();
  }

  _onPttDown(ev) {
    ev.preventDefault();
    if (this._pttBlocked()) return;
    this._chat()?.pttStart?.();
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
  }
  _onPttUp(ev) {
    ev.preventDefault();
    this._chat()?.pttStop?.();
  }
  _pttBlocked() {
    const chat = this._chat();
    if (!chat) return true;
    const s = chat.speaker;
    const selfId = window.__foyer?.store?.state?.selfPeerId;
    // Blocked if someone else is currently speaking.
    return !!(s && selfId && s.peer_id !== selfId);
  }

  _clearHistory() {
    if (!confirm("Clear chat history for everyone?")) return;
    this._chat()?.clear?.();
  }

  _openSnapshot() {
    const base = `chat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
    this._snapshotName = base;
    this._snapshotPrompt = true;
  }
  _doSnapshot() {
    this._chat()?.snapshot?.(this._snapshotName || null);
    this._snapshotPrompt = false;
  }

  _isAdminish() {
    const rbac = window.__foyer?.store?.state?.rbac;
    if (!rbac) return true;
    if (!rbac.isTunnel) return true; // LAN = trusted
    return rbac.roleId === "admin";
  }

  _selfId() { return window.__foyer?.store?.state?.selfPeerId || ""; }

  // ── render ─────────────────────────────────────────────────────

  render() {
    if (this._isDocked()) {
      return this._open ? html`<div class="panel" style=${this._dockStyle()} role="dialog" aria-label="Foyer chat">${this._renderPanelBody({ compact: true })}</div>` : nothing;
    }
    const fabStyle = `right: ${this._fabRight}px; bottom: ${this._fabBottom}px`;
    const unread = this._unreadCount;
    const speaker = this._chat()?.speaker;
    const someoneSpeaking = !!speaker && speaker.peer_id !== this._selfId();
    const fabClasses = [
      "fab",
      this._open ? "open" : "",
      this._dragState?.kind === "fab" ? "dragging" : "",
    ].filter(Boolean).join(" ");
    return html`
      <button class=${fabClasses} style=${fabStyle}
              @pointerdown=${this._onFabDown}
              aria-label=${this._open ? "Close chat" : "Open chat"}
              title=${someoneSpeaking ? `${speaker.label} is speaking` : (this._open ? "Close chat" : "Open chat")}>
        ${someoneSpeaking ? html`<span class="speaker-ring"></span>` : nothing}
        ${icon("chat-bubble-left-right", 22)}
        ${unread > 0 && !this._open ? html`<span class="badge">${unread > 99 ? "99+" : unread}</span>` : nothing}
      </button>
      ${this._open ? this._renderFloatingPanel() : nothing}
    `;
  }

  _dockStyle() {
    const rail = window.__foyer?.rightDock?.railRect?.();
    const right = rail ? window.innerWidth - rail.left + 8 : 60;
    const top = Math.max(16, this._dockIconTop || 120);
    const vh = window.innerHeight;
    const w = Math.min(this._panelWidth, Math.max(360, window.innerWidth - right - 16));
    const h = Math.min(this._panelHeight, Math.max(360, vh - top - 16));
    return `position:fixed;right:${right}px;top:${top}px;width:${w}px;height:${h}px`;
  }

  _renderFloatingPanel() {
    const { style, isTop, isLeft } = this._panelStyle();
    const corner = `${isTop ? "s" : "n"}${isLeft ? "e" : "w"}`;
    return html`
      <div class="panel" style=${style} role="dialog" aria-label="Foyer chat">
        <div class="resize ${corner}" @pointerdown=${(e) => this._onResizeDown(e, corner)}></div>
        ${this._renderPanelBody({ compact: false })}
      </div>
    `;
  }

  _renderPanelBody({ compact }) {
    const chat = this._chat();
    const msgs = chat?.messages ?? [];
    const speaker = chat?.speaker;
    const selfId = this._selfId();
    return html`
      <header @pointerdown=${compact ? null : this._onHeaderDown}>
        <div class="title">Chat</div>
        ${speaker ? html`
          <span class="ptt-banner">
            ${icon("microphone", 12)}
            ${speaker.peer_id === selfId ? "You are speaking" : `${speaker.label} speaking…`}
          </span>
        ` : nothing}
        <div class="spacer"></div>
        ${this._isAdminish() ? html`
          <button title="Save chat to disk" @pointerdown=${(e) => e.stopPropagation()}
                  @click=${this._openSnapshot}>${icon("document", 14)}</button>
          <button title="Clear chat for everyone" @pointerdown=${(e) => e.stopPropagation()}
                  @click=${this._clearHistory}>${icon("trash", 14)}</button>
        ` : nothing}
        ${compact ? html`
          <button title="Undock" @pointerdown=${(e) => e.stopPropagation()}
                  @click=${() => window.__foyer?.layout?.undockFab?.(this.storageKey)}>
            ${icon("arrow-top-right-on-square", 14)}
          </button>
          <button title="Close" @pointerdown=${(e) => e.stopPropagation()}
                  @click=${() => this.closeFromDock()}>${icon("x-mark", 14)}</button>
        ` : html`
          <button title="Close" @pointerdown=${(e) => e.stopPropagation()}
                  @click=${() => { this._open = false; this._persist(); this.requestUpdate(); }}>
            ${icon("x-mark", 14)}
          </button>
        `}
      </header>
      ${this._snapshotPrompt ? html`
        <div class="snapshot-row">
          <span>Filename:</span>
          <input type="text" .value=${this._snapshotName}
                 @input=${(e) => { this._snapshotName = e.target.value; }}
                 @keydown=${(e) => { if (e.key === "Enter") this._doSnapshot(); }}>
          <button @click=${this._doSnapshot}>Save</button>
          <button @click=${() => { this._snapshotPrompt = false; }}>Cancel</button>
        </div>
      ` : nothing}
      <div class="transcript">
        ${msgs.length === 0 ? html`
          <div class="empty">
            <strong>In-app chat</strong>
            Relay conversation between everyone connected. Markdown + code
            blocks (yaml, json, js, shell) render inline. Push-to-talk below.
          </div>
        ` : msgs.map((m) => html`
          <div class="msg ${m.from_peer_id === selfId ? "self" : ""}">
            <div class="meta">
              <span class="who">${m.from_label || m.from_peer_id}</span>
              <span class="time">${formatTime(m.ts_ms)}</span>
            </div>
            <div class="body" .innerHTML=${renderMarkdown(m.body)}></div>
          </div>
        `)}
      </div>
      ${this._renderComposer()}
    `;
  }

  _renderComposer() {
    const chat = this._chat();
    const holding = !!chat?.localPressed;
    const blocked = this._pttBlocked();
    return html`
      <div class="composer">
        <button class=${"ptt" + (holding ? " holding" : "") + (blocked ? " blocked" : "")}
                title=${blocked ? "Someone else is speaking" : "Hold to talk"}
                @pointerdown=${this._onPttDown}
                @pointerup=${this._onPttUp}
                @pointerleave=${this._onPttUp}
                @pointercancel=${this._onPttUp}>
          ${icon("microphone", 16)}
        </button>
        <textarea
          placeholder="Say something…"
          .value=${this._input}
          @input=${(e) => { this._input = e.target.value; }}
          @keydown=${this._onInputKey}></textarea>
        <button class="send"
                title="Send"
                ?disabled=${!this._input.trim()}
                @click=${this._send}>
          ${icon("paper-airplane", 16)}
        </button>
      </div>
    `;
  }
}

customElements.define("foyer-chat-panel", FoyerChatPanel);
