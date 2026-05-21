// Floating quadrant-based agent panel + draggable FAB.
//
// Adapted from the Patapsco AI Platform's platform-agent-panel (same idea,
// trimmed for Foyer's current scope). The panel anchors to the opposite corner
// of whichever quadrant the FAB is in — drag the FAB anywhere and the panel
// follows with the correct geometry. Resize handles appear on the edges facing
// away from the FAB so the panel always grows INTO the screen.
//
// MCP wiring (M8) will replace the placeholder send handler with real agent
// round-trips. For now the transcript echoes what you type so the UX is
// exercised end-to-end.

import { LitElement, html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icon } from "foyer-ui-core/icons.js";
import "./agent-settings-modal.js";
import { renderMarkdown, ensureMarkdownReady } from "foyer-core/markdown.js";
import { panelStyles, FAB_SIZE } from "./agent-panel.styles.js";
// `t` is shadowed in this file by transcript-row variables (e.g. the
// `_renderMsg(t)` lambdas), so alias the i18n function as `tr` to
// dodge the collision.
import { t as tr, tn, onLocaleChange } from "/core/i18n.js";
const GAP = 8;
const LS_KEY = "foyer.agent.panel.v1";
const DEFAULT_STATE = {
  fabRight: 24,
  fabBottom: 24,
  panelWidth: 420,
  panelHeight: 520,
  open: false,
  // Persisted composer textarea height — the user drags the SE grip
  // to grow it for multi-line prompts, and the size sticks across
  // page reloads.
  composerHeight: 64,
};

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const p = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...p };
  } catch {
    return { ...DEFAULT_STATE };
  }
}
function saveState(s) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {}
}

/// Strip inline base64 media keys from a parsed JSON object so the
/// Pretty / Raw views don't show hundreds of KB of unreadable
/// gibberish. Returns a shallow clone — callers can mutate freely.
function stripMedia(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out = { ...value };
  for (const k of ["image_png_b64", "image_jpg_b64", "image_jpeg_b64", "image_webp_b64"]) {
    if (k in out) delete out[k];
  }
  return out;
}

/// Cap a long string with an ellipsis. The agent-panel renders the
/// truncated form by default and reveals the full text behind a
/// "see full" expander — long tool outputs (catalog dumps, full
/// session snapshots, etc.) otherwise blow up the transcript and
/// drown actual results.
const TOOL_BLOCK_TRUNCATE = 400;

/// Read a File / Blob and return its base64-encoded contents
/// (standard, no `data:` prefix — the engine adds the data URI on
/// the outbound side when wrapping `image_url` for the LLM).
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result || "";
      const comma = String(result).indexOf(",");
      resolve(comma >= 0 ? String(result).slice(comma + 1) : "");
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/// Split an assistant content stream into multiple
/// `{thinking, ...}` blocks plus the visible `content`.
///
/// Reasoning models stream chain-of-thought either inline as paired
/// tags (`<think>...</think>` for DeepSeek-R1 / QwQ, `<thinking>...
/// </thinking>` for Anthropic-style outputs) or in a separate
/// `reasoning_content` delta field — the engine wraps the latter in
/// `<think>` markers so this one parser handles both shapes.
/// `stillThinking` is true when the last opened tag has no matching
/// close yet, which drives the live "Thinking…" spinner.
///
/// `thinkingSegments` is the list of distinct blocks in order; the
/// UI renders one collapsible `<details>` per segment so a model
/// that thinks several times across a turn gets independently
/// expandable traces (not one fused mega-block).
function parseThinking(raw) {
  const segments = [];
  let content = "";
  let cursor = 0;
  let stillThinking = false;
  const OPENERS = ["<think>", "<thinking>"];
  const CLOSERS = { "<think>": "</think>", "<thinking>": "</thinking>" };
  while (cursor < raw.length) {
    // Find the nearest opener.
    let nextOpenIdx = -1;
    let nextOpenTag = "";
    for (const tag of OPENERS) {
      const i = raw.indexOf(tag, cursor);
      if (i !== -1 && (nextOpenIdx === -1 || i < nextOpenIdx)) {
        nextOpenIdx = i;
        nextOpenTag = tag;
      }
    }
    if (nextOpenIdx === -1) {
      content += raw.slice(cursor);
      break;
    }
    content += raw.slice(cursor, nextOpenIdx);
    const afterOpen = nextOpenIdx + nextOpenTag.length;
    const closer = CLOSERS[nextOpenTag];
    const closeIdx = raw.indexOf(closer, afterOpen);
    if (closeIdx === -1) {
      // Open tag without a close — we're mid-stream. Capture the rest
      // as a still-thinking segment and stop.
      const trailing = raw.slice(afterOpen).trim();
      if (trailing) segments.push({ text: trailing, live: true });
      stillThinking = true;
      cursor = raw.length;
      break;
    }
    const inner = raw.slice(afterOpen, closeIdx).trim();
    if (inner) segments.push({ text: inner, live: false });
    cursor = closeIdx + closer.length;
  }
  return { thinkingSegments: segments, content, stillThinking };
}

export class AgentPanel extends LitElement {
  static properties = {
    _fabRight:     { state: true, type: Number },
    _fabBottom:    { state: true, type: Number },
    _panelWidth:   { state: true, type: Number },
    _panelHeight:  { state: true, type: Number },
    _open:         { state: true, type: Boolean },
    _input:        { state: true, type: String },
    _transcript:   { state: true, type: Array },
    _settingsOpen: { state: true, type: Boolean },
    _agentBusy:    { state: true, type: Boolean },
    _agentConfig:  { state: true, type: Object },
    _agentSkills:  { state: true, type: Array },
    _agentMemories:{ state: true, type: Array },
    _agentTemplates:{ state: true, type: Array },
    _slideMode:    { state: true, type: Boolean },
    _sessions:     { state: true, type: Array },
    _activeSessionId: { state: true, type: String },
    _sessionsOpen: { state: true, type: Boolean },
    _pendingDeleteId: { state: true, type: String },
    _attachments: { state: true, type: Array },
    _dropHover: { state: true, type: Boolean },
    /// Click-to-raise z-index for the panel + FAB pair. Both elements
    /// position:fixed in the document stacking context and need to
    /// raise together over peer floating layers (foyer-window stack,
    /// plugin panels). Bumped via the global stack counter on each
    /// pointerdown into either element so they win against the most
    /// recent foyer-window raise.
    _zOverride: { state: true, type: Number },
    /// Text composer's current pixel height; persisted between
    /// reloads via `_persist()`. Updated on `mouseup`/`blur` of the
    /// textarea (after the user drags the SE resize grip).
    _composerHeight: { state: true, type: Number },
    /// Queued user message parked while the agent is busy. Cleared
    /// after dispatch or when the user edits it back into the box.
    _queuedMessage: { state: true, type: Object },
    /// `true` when the user's last interaction left the transcript
    /// scrolled to (or near) the bottom. While set, every new token /
    /// tool update pins the viewport to the tail so live streaming is
    /// visible. Once the user scrolls UP — wheel, drag, PageUp,
    /// keyboard nav — we drop the latch and stop forcing scroll, so
    /// they can review earlier turns. Scrolling back to the bottom
    /// re-acquires the latch.
    _pinnedToBottom: { state: true, type: Boolean },
    /// Set of `call_id` strings whose tool cards have been switched
    /// to raw JSON view. Default view is the formatted K/V pairs.
    _rawToolCards: { state: true, type: Object },
    /// Set of `<call_id>:<slot>` keys whose tool blocks the user has
    /// chosen to fully expand past the default ~few-hundred-byte
    /// truncation. `slot` is `input` / `output` / `media`.
    _expandedToolBlocks: { state: true, type: Object },
    /// `{ src, alt }` for the zoom modal — `null` when no image is
    /// being inspected.
    _zoomImage: { state: true, type: Object },
  };

  /** Right-dock slide-out hooks (mirror chat-panel.js).
   *  The dock calls these to reparent us into its slot when the user
   *  taps the rail icon, and to pop us back to the body when the
   *  slide closes. Without these the dock opens an empty slide-out
   *  while we render our own off-screen docked panel — two separate
   *  surfaces fighting for the same gesture. */
  enterSlideMode(dockHost) {
    if (!dockHost) return;
    this._slideMode = true;
    this._open = true;
    this.setAttribute("slot", "slide-out");
    if (this.parentElement !== dockHost) dockHost.appendChild(this);
    this.requestUpdate();
    queueMicrotask(() => {
      window.__foyer?.ws?.send({ type: "agent_history_request" });
    });
  }
  exitSlideMode() {
    if (!this._slideMode) return;
    this._slideMode = false;
    // Deliberately don't touch `_open` here — the caller decides.
    // The tear-out-to-floating path wants the floating panel to
    // pop open; the X-close path wants the panel hidden. Either
    // way they set `_open` themselves before us.
    this.removeAttribute("slot");
    if (this.parentElement && this.parentElement !== document.body) {
      document.body.appendChild(this);
    }
    this.requestUpdate();
  }

  static styles = panelStyles;

  constructor() {
    super();
    const s = loadState();
    this._fabRight = s.fabRight;
    this._fabBottom = s.fabBottom;
    this._panelWidth = s.panelWidth;
    this._panelHeight = s.panelHeight;
    this._composerHeight = Math.max(36, Math.min(360, s.composerHeight ?? 64));
    this._open = s.open;
    this._input = "";
    this._transcript = [];
    this._settingsOpen = false;
    this._agentBusy = false;
    this._agentConfig = null;
    this._agentSkills = [];
    this._agentMemories = [];
    this._agentTemplates = [];
    this._slideMode = false;
    this._sessions = [];
    this._activeSessionId = "";
    this._sessionsOpen = false;
    this._pendingDeleteId = "";
    this._attachments = [];
    this._dropHover = false;
    this._zOverride = 0;
    this._dragState = null;
    this._resizeState = null;
    this._pinnedToBottom = true;
    this._rawToolCards = new Set();
    this._expandedToolBlocks = new Set();
    this._zoomImage = null;
    /// `{ body, attachments }` parked while the agent is busy. The
    /// composer's send button switches to "Stop & send" while a
    /// queued message is parked; clicking stops the current turn
    /// then dispatches the queued one. Auto-flushed when the agent
    /// goes idle (in case the user wants to wait it out).
    this._queuedMessage = null;
    /// Live set of `.transcript` containers we've attached scroll
    /// listeners to. The panel renders a transcript element per mount
    /// mode (floating panel / docked slide / tear-out window); each
    /// gets the same latch behaviour.
    this._scrollContainers = new WeakSet();
    this._onWindowPointerMove = this._onWindowPointerMove.bind(this);
    this._onWindowPointerUp = this._onWindowPointerUp.bind(this);
    this._onWindowResize = this._onWindowResize.bind(this);
    this._onTranscriptScroll = this._onTranscriptScroll.bind(this);
  }

  storageKey = "foyer.agent";

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("pointermove", this._onWindowPointerMove);
    window.addEventListener("pointerup", this._onWindowPointerUp);
    window.addEventListener("pointercancel", this._onWindowPointerUp);
    window.addEventListener("resize", this._onWindowResize);
    // Register with the layout store so the right-dock can show a rail icon
    // while we're docked. Wider default dock width — the agent panel needs
    // room for conversation turns.
    this._onLayoutChange = () => this.requestUpdate();
    window.__foyer?.layout?.addEventListener("change", this._onLayoutChange);
    window.__foyer?.layout?.registerFab(
      this.storageKey,
      {
        label: tr("Agent"),
        icon: "chat-bubble-left-right",
        accent: "accent",
        expandsRail: true,
        dockWidth: 400,
        defaultDocked: true,
      },
      this,
    );
    // Subscribe to control-WS envelopes for agent_* events. The WS
    // emits `envelope` CustomEvents on itself; we listen, filter to
    // agent events, and update the transcript. Request history on
    // mount so a reload picks up the in-memory ring.
    window.__foyer?.ws?.addEventListener("envelope", this._onEnvelope);
    queueMicrotask(() => {
      window.__foyer?.ws?.send({ type: "agent_history_request" });
    });
    // Once marked + (optional) hljs land, force a re-render so any
    // assistant messages that rendered in <pre>-fallback mode pick
    // up the real markdown output.
    ensureMarkdownReady().then(() => this.requestUpdate()).catch(() => {});
    // Wobbly windows: same opt-in pattern QuadrantFab uses.
    this._wobbleEnable = () => this._installWobbles();
    this._wobbleDisable = () => this._uninstallWobbles();
    window.addEventListener("foyer:wobbly-enabled", this._wobbleEnable);
    window.addEventListener("foyer:wobbly-disabled", this._wobbleDisable);
    requestAnimationFrame(() => this._installWobbles());
    this._i18nDispose = onLocaleChange(() => this.requestUpdate());
  }
  disconnectedCallback() {
    window.__foyer?.ws?.removeEventListener("envelope", this._onEnvelope);
    window.removeEventListener("pointermove", this._onWindowPointerMove);
    window.removeEventListener("pointerup", this._onWindowPointerUp);
    window.removeEventListener("pointercancel", this._onWindowPointerUp);
    window.removeEventListener("resize", this._onWindowResize);
    window.__foyer?.layout?.removeEventListener("change", this._onLayoutChange);
    window.__foyer?.layout?.unregisterFab(this.storageKey);
    window.removeEventListener("foyer:wobbly-enabled", this._wobbleEnable);
    window.removeEventListener("foyer:wobbly-disabled", this._wobbleDisable);
    this._uninstallWobbles();
    this._i18nDispose?.();
    this._i18nDispose = null;
    super.disconnectedCallback();
  }

  async _installWobbles() {
    const mod = await import("foyer-core/wobbly-windows.js");
    if (!mod.wobblyEnabled()) return;
    const fab = this.renderRoot?.querySelector?.(".fab");
    const panel = this.renderRoot?.querySelector?.(".panel");
    // `visualOnly: true` — wobble is decoration only. The host's
    // native pointer handlers own drag state, position, and any
    // drop detection. Drop / position math is therefore identical
    // to the non-jiggle code path.
    if (panel) {
      const header = panel.querySelector?.("header") || panel;
      const handles = fab ? [header, fab] : [header];
      mod.attachWobble(panel, handles, {
        followers: fab ? [fab] : [],
        passthroughClick: true,
        visualOnly: true,
      });
    } else if (fab) {
      mod.attachWobble(fab, undefined, {
        passthroughClick: true,
        visualOnly: true,
      });
    }
    this._wobbleAttached = { fab, panel };
  }

  async _uninstallWobbles() {
    if (!this._wobbleAttached) return;
    const mod = await import("foyer-core/wobbly-windows.js");
    const { fab, panel } = this._wobbleAttached;
    if (fab) mod.detachWobble(fab);
    if (panel) mod.detachWobble(panel);
    this._wobbleAttached = null;
  }

  firstUpdated() {
    // Shadow-DOM copy fix: `document.getSelection()` doesn't see
    // selections that live inside an open shadow root in Chromium,
    // so Ctrl/Cmd+C from the transcript / thinking blocks ends up
    // copying nothing (or the focused-element's value, e.g. the
    // empty textarea). Hooking the `copy` event at the shadow root
    // lets us hand the selection text to the clipboard manually.
    // Right-click → Copy goes through the same event, so this fix
    // covers both paths.
    this.shadowRoot?.addEventListener("copy", (ev) => {
      const sel = this.shadowRoot.getSelection?.();
      const text = sel ? sel.toString() : "";
      if (!text) return;
      ev.clipboardData?.setData("text/plain", text);
      ev.preventDefault();
    });
  }

  updated(changed) {
    // Reattach wobble after a Lit re-render: the `.panel` only
    // exists when `_open` is true, so a fresh open needs a fresh
    // attach. The wobble module's attach is idempotent — it bails
    // when the element already has a wobble — so calling on every
    // updated() is cheap.
    if (this._wobbleAttached || this._open) {
      this._installWobbles();
    }
    // Mirror the `console-view.js` pattern: attach a scroll listener
    // ONCE per transcript element, sync-apply `scrollTop=scrollHeight`
    // when the user is currently "following" (within slack of the
    // bottom). No rAF, no flag — the synthetic scroll event our own
    // `scrollTop=…` fires re-enters `_onTranscriptScroll` at
    // distance=0, which correctly keeps `_pinnedToBottom=true`.
    //
    // The earlier rAF-based version raced the user's input: between
    // `updated()` queuing the frame and the frame firing, a user
    // scroll could land, set `_pinnedToBottom=false`, then the rAF
    // would snap them back down. Going synchronous removes the race
    // entirely.
    const containers = this.shadowRoot
      ? this.shadowRoot.querySelectorAll(".transcript")
      : [];
    for (const el of containers) {
      if (!this._scrollContainers.has(el)) {
        this._scrollContainers.add(el);
        el.addEventListener("scroll", this._onTranscriptScroll, { passive: true });
      }
      if (this._pinnedToBottom) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }

  _onTranscriptScroll(ev) {
    const el = ev.currentTarget;
    if (!el) return;
    // 32px slack — matches console-view; covers padding + scrollbar
    // overshoot on dense transcripts.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    this._pinnedToBottom = distance < 32;
  }

  _isDocked() {
    return !!window.__foyer?.layout?.isFabDocked(this.storageKey);
  }

  _isOverRail(x, y) {
    const rd = window.__foyer?.rightDock;
    const r = rd?.railRect?.();
    return !!(r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  }

  openFromDock(top) { this._dockIconTop = top; this._open = true; this._persist(); this.requestUpdate(); }
  closeFromDock() {
    this._open = false;
    this._persist();
    this.requestUpdate();
    // When closing from inside the right-dock slide-out, we also
    // need to tell the dock to retract its slide column — the
    // dock owns that bit of state, not us. Mirrors quadrant-fab.
    if (this._slideMode) {
      window.dispatchEvent(new CustomEvent("foyer:fab-slide-close", {
        detail: { id: this.storageKey },
      }));
    }
  }
  toggleFromDock(t) { if (this._open) this.closeFromDock(); else this.openFromDock(t); }

  /** Tear-out icon handler: hand off to the right-dock so it can
   *  stagger our position against other floating FABs and open our
   *  panel atomically. Falls back to a plain undock if the dock
   *  isn't reachable. */
  _tearOutToFloating() {
    const rd = window.__foyer?.rightDock;
    if (rd && typeof rd.tearFabToFloating === "function") {
      rd.tearFabToFloating(this.storageKey);
      return;
    }
    if (this._slideMode) this.exitSlideMode();
    this._open = true;
    this._persist();
    this.requestUpdate();
    window.__foyer?.layout?.undockFab(this.storageKey);
  }

  /** Called by right-dock to render the agent chat inside its slide-out
   *  panel area (when this FAB is docked). We can't reuse
   *  `_renderPanel` here directly because it positions itself
   *  absolutely (anchored near the FAB); inside the dock we want
   *  regular flow layout that fills the dock panel. */
  dockPanelContent() {
    return html`
      <div style="display:flex;flex-direction:column;height:100%;min-height:0;gap:6px;padding:4px 6px">
        <div style="display:flex;align-items:center;gap:6px;padding:4px 2px">
          <div style="font-weight:600;font-size:12px;color:var(--color-text)">${tr("Agent")}</div>
          <div style="flex:1"></div>
          <button style="background:transparent;border:1px solid transparent;border-radius:var(--radius-sm);padding:3px 6px;color:var(--color-text-muted);cursor:pointer;line-height:1"
                  @click=${() => { this._settingsOpen = true; }}
                  title=${tr("Settings")}>
            ${icon("cog", 14)}
          </button>
        </div>
        <div style="flex:1;overflow-y:auto;padding:6px;background:var(--color-surface-elevated);border:1px solid var(--color-border);border-radius:var(--radius-sm);min-height:0">
          ${this._transcript.length === 0
            ? html`<div style="color:var(--color-text-muted);font-size:11px;text-align:center;padding:20px 10px"><strong>${tr("Foyer Agent")}</strong><br>${tr("Ask to move faders, arm tracks, or explain the mix.")}</div>`
            : this._transcript.map((m) => this._renderMsg(m))}
        </div>
        <div style="display:flex;gap:4px">
          <textarea
            placeholder=${tr("Ask the agent…")}
            style="flex:1;background:var(--color-surface-elevated);border:1px solid var(--color-border);border-radius:var(--radius-sm);color:var(--color-text);font:inherit;font-size:12px;padding:6px 8px;resize:none;min-height:60px"
            .value=${this._input}
            @input=${(e) => { this._input = e.target.value; }}
            @keydown=${this._onInputKey}
          ></textarea>
        </div>
      </div>
    `;
  }
  /** Lazy-connect when the dock panel is first opened. */
  onDockPanelOpen() {
    // Agent panel already lazily wires its settings + WS on first
    // render, so there is nothing to kick off here yet. Hook left in
    // place so future changes (e.g. prefetching model list) slot in.
  }

  _persist() {
    saveState({
      fabRight: this._fabRight,
      fabBottom: this._fabBottom,
      panelWidth: this._panelWidth,
      panelHeight: this._panelHeight,
      composerHeight: this._composerHeight,
      open: this._open,
    });
  }

  /// Capture the composer textarea's current height after the user
  /// finishes dragging the SE resize grip. Native `<textarea>` doesn't
  /// fire a resize event, so we sample `getBoundingClientRect()` on
  /// `mouseup` / `blur` — both reliably fire after a resize drag.
  _onComposerResize = (ev) => {
    const ta = ev.currentTarget;
    if (!ta) return;
    const h = Math.round(ta.getBoundingClientRect().height);
    if (h > 0 && h !== this._composerHeight) {
      this._composerHeight = h;
      this._persist();
    }
  };

  _onWindowResize() {
    // Clamp FAB + panel into the new viewport.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this._fabRight = Math.max(0, Math.min(vw - FAB_SIZE, this._fabRight));
    this._fabBottom = Math.max(0, Math.min(vh - FAB_SIZE, this._fabBottom));
    this._persist();
  }

  // ─── FAB drag / toggle ─────────────────────────────────────────────────

  /// Bump our z-index above peer floating layers (foyer-window stack,
  /// plugin float layer) using the layout store's global stack counter.
  /// Idempotent — skips the bump when no visible foyer-window outranks
  /// us already, so a click into a focused agent panel doesn't inflate
  /// the global stack counter on every interaction (Rich, 2026-05-16).
  _raise() {
    const layout = window.__foyer?.layout;
    if (!layout?.bumpGlobalStackZ) return;
    // Highest z among visible foyer-windows. We want to outrank that
    // value; if we already do, leave the counter alone.
    let peerMax = 0;
    for (const el of document.querySelectorAll("foyer-window")) {
      if (el.hasAttribute("hidden-by-layer") || el.minimized) continue;
      const z = parseInt(el.style.zIndex || "1000", 10);
      if (z > peerMax) peerMax = z;
    }
    if (this._zOverride > peerMax) return;
    const z = layout.bumpGlobalStackZ();
    if (Number.isFinite(z)) this._zOverride = z;
  }

  _onFabDown(ev) {
    this._raise();
    ev.preventDefault();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this._dragState = {
      kind: "fab",
      startX: ev.clientX,
      startY: ev.clientY,
      origRight: this._fabRight,
      origBottom: this._fabBottom,
      vw, vh,
      moved: false,
      pointerId: ev.pointerId,
    };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    this.requestUpdate();
  }

  _onWindowPointerMove(ev) {
    if (this._dragState?.kind === "fab") {
      const ds = this._dragState;
      const dx = ev.clientX - ds.startX;
      const dy = ev.clientY - ds.startY;
      if (!ds.moved && Math.hypot(dx, dy) > 4) ds.moved = true;
      // Skip per-tick position updates when a wobble is attached —
      // its matrix3d / follower-translate transforms are providing
      // the visual movement, and updating _fabRight here would
      // double-shift the FAB. The final position is committed
      // from cursor delta in _onWindowPointerUp.
      if (!this._wobbleAttached) {
        this._fabRight = Math.max(0, Math.min(ds.vw - FAB_SIZE, ds.origRight - dx));
        this._fabBottom = Math.max(0, Math.min(ds.vh - FAB_SIZE, ds.origBottom - dy));
      }
      window.__foyer?.rightDock
        ?.setDropHighlight?.(this._isOverRail(ev.clientX, ev.clientY));
      this.requestUpdate();
    } else if (this._dragState?.kind === "panel-header") {
      const ds = this._dragState;
      const dx = ev.clientX - ds.startX;
      const dy = ev.clientY - ds.startY;
      if (!this._wobbleAttached) {
        this._fabRight = Math.max(0, Math.min(ds.vw - FAB_SIZE, ds.origRight - dx));
        this._fabBottom = Math.max(0, Math.min(ds.vh - FAB_SIZE, ds.origBottom - dy));
        this.requestUpdate();
      }
    } else if (this._resizeState) {
      const rs = this._resizeState;
      const dx = ev.clientX - rs.startX;
      const dy = ev.clientY - rs.startY;
      const wSign = rs.corner.includes("e") === rs.panelGrowsE ? 1 : -1;
      const hSign = rs.corner.includes("s") === rs.panelGrowsS ? 1 : -1;
      this._panelWidth = Math.max(320, rs.origW + dx * wSign);
      this._panelHeight = Math.max(280, rs.origH + dy * hSign);
      this.requestUpdate();
    }
  }

  _onWindowPointerUp(ev) {
    if (this._dragState?.kind === "fab") {
      const ds = this._dragState;
      const wasMoved = ds.moved;
      // Deferred commit: native onMove skipped the position update
      // while a wobble was attached. Now that we have the release
      // coords, set the final FAB position from cursor delta.
      if (this._wobbleAttached && ev && wasMoved) {
        const dx = ev.clientX - ds.startX;
        const dy = ev.clientY - ds.startY;
        this._fabRight = Math.max(0, Math.min(ds.vw - FAB_SIZE, ds.origRight - dx));
        this._fabBottom = Math.max(0, Math.min(ds.vh - FAB_SIZE, ds.origBottom - dy));
      }
      this._dragState = null;
      window.__foyer?.rightDock?.setDropHighlight?.(false);
      if (!wasMoved) {
        this._toggle();
      } else if (ev && this._isOverRail(ev.clientX, ev.clientY)) {
        window.__foyer?.layout?.dockFab(this.storageKey);
        this._open = false;
      }
      this._persist();
      this.requestUpdate();
    } else if (this._dragState?.kind === "panel-header") {
      const ds = this._dragState;
      if (this._wobbleAttached && ev) {
        const dx = ev.clientX - ds.startX;
        const dy = ev.clientY - ds.startY;
        this._fabRight = Math.max(0, Math.min(ds.vw - FAB_SIZE, ds.origRight - dx));
        this._fabBottom = Math.max(0, Math.min(ds.vh - FAB_SIZE, ds.origBottom - dy));
        this.requestUpdate();
      }
      this._dragState = null;
      this._persist();
    } else if (this._resizeState) {
      this._resizeState = null;
      this._persist();
    }
    void ev;
  }

  _toggle() {
    this._open = !this._open;
    this._persist();
  }

  _onPanelHeaderDown(ev) {
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
    // Panel grows away from the FAB. If FAB is in the left half, panel is to
    // the right of it, so dragging further right grows width.
    const panelGrowsE = !isLeft; // panel is to the right of FAB ⇒ grows east
    const panelGrowsS = !isTop;  // panel is below FAB ⇒ grows south
    this._resizeState = {
      corner,
      startX: ev.clientX,
      startY: ev.clientY,
      origW: this._panelWidth,
      origH: this._panelHeight,
      panelGrowsE,
      panelGrowsS,
    };
  }

  // ─── Quadrant / anchor computation (Patapsco algorithm) ─────────────────

  _quadrant() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fabCenterX = vw - this._fabRight - FAB_SIZE / 2;
    const fabCenterY = vh - this._fabBottom - FAB_SIZE / 2;
    return {
      isTop: fabCenterY < vh / 2,
      isLeft: fabCenterX < vw / 2,
    };
  }

  _panelStyle() {
    const { isTop, isLeft } = this._quadrant();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fabTop = vh - this._fabBottom - FAB_SIZE;

    const pos = [];
    if (isTop)  pos.push(`top: ${fabTop + FAB_SIZE + GAP}px`);
    else        pos.push(`bottom: ${this._fabBottom + FAB_SIZE + GAP}px`);

    if (isLeft) pos.push(`left: ${vw - this._fabRight - FAB_SIZE}px`);
    else        pos.push(`right: ${this._fabRight}px`);

    // Clamp width so the panel never overlaps the FAB.
    const fabLeftEdge  = vw - this._fabRight - FAB_SIZE;
    const fabRightEdge = vw - this._fabRight;
    const maxW = isLeft
      ? Math.max(320, vw - fabLeftEdge - 16)
      : Math.max(320, fabRightEdge - 16);
    const maxH = isTop
      ? Math.max(280, vh - fabTop - FAB_SIZE - GAP - 16)
      : Math.max(280, vh - this._fabBottom - FAB_SIZE - GAP - 16);

    const w = Math.min(this._panelWidth, maxW);
    const h = Math.min(this._panelHeight, maxH);
    pos.push(`width: ${w}px`, `height: ${h}px`);
    return { style: pos.join("; "), isTop, isLeft };
  }

  // ─── Messaging — talks to the Rust agent runtime over the control WS ─

  _onInputKey(ev) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      this._send();
    }
  }

  async _onComposerPaste(ev) {
    const items = ev.clipboardData?.items;
    if (!items) return;
    // If the clipboard carries text alongside any file (common when
    // copying from a browser: the source rich-text PLUS a screenshot
    // image representation), let the text paste through normally and
    // skip the attachment route — otherwise a `Cmd+V` of plain text
    // surprises the user with a phantom `image.png` attachment.
    const hasText = Array.from(ev.clipboardData?.types || []).includes("text/plain");
    const text = hasText ? ev.clipboardData.getData("text/plain") : "";
    if (text.length > 0) return;
    const files = [];
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      ev.preventDefault();
      await this._ingestFiles(files);
    }
  }

  _onComposerDragOver(ev) {
    if (ev.dataTransfer?.types?.includes("Files")) {
      ev.preventDefault();
      this._dropHover = true;
    }
  }
  _onComposerDragLeave(_ev) {
    this._dropHover = false;
  }
  async _onComposerDrop(ev) {
    ev.preventDefault();
    this._dropHover = false;
    const files = Array.from(ev.dataTransfer?.files || []);
    if (files.length > 0) await this._ingestFiles(files);
  }

  async _ingestFiles(files) {
    const next = [...this._attachments];
    for (const f of files) {
      const kind = f.type || "application/octet-stream";
      // Read the file once and stash its base64 payload alongside the
      // metadata; `_send` ships the b64 to the engine, which folds
      // images into the multi-modal LLM content array for VLMs.
      const b64 = await fileToBase64(f);
      next.push({
        name: f.name || "pasted",
        kind,
        bytes: f.size || 0,
        bytes_b64: b64,
      });
    }
    this._attachments = next;
  }
  _removeAttachment(idx) {
    const next = this._attachments.slice();
    next.splice(idx, 1);
    this._attachments = next;
  }
  async _send() {
    const text = this._input.trim();
    if (!text && this._attachments.length === 0) return;
    const ws = window.__foyer?.ws;
    if (!ws) {
      this._appendLocal("system", tr("control WS not ready"));
      return;
    }
    // Encode any attached files to base64 — only image/* travels to
    // the LLM today (multi-modal `image_url` blocks). Other types
    // are recorded but the engine ignores them for now.
    const attachments = await Promise.all(
      this._attachments.map(async (a) => ({
        name: a.name,
        mime: a.kind,
        b64: a.bytes_b64 || "",
      })),
    );
    const filtered = attachments.filter((a) => a.b64);
    if (this._agentBusy) {
      // Park the message and switch the send affordance to
      // "Stop & send" — the user is signalling they want to redirect
      // the conversation now, not after the LLM finishes its current
      // (probably runaway) thought.
      this._queuedMessage = { body: text, attachments: filtered };
      this._input = "";
      this._attachments = [];
      return;
    }
    ws.send({ type: "agent_send", body: text, attachments: filtered });
    this._input = "";
    this._attachments = [];
    // Submitting implies "I want to watch the reply" — re-acquire the
    // scroll latch so the user doesn't have to chase it manually if
    // they happened to be reading older context when they hit send.
    this._pinnedToBottom = true;
  }

  /// Interrupt the in-flight assistant turn, then dispatch the
  /// queued user message. The engine captures the partial assistant
  /// output before unwinding so it stays in the transcript as
  /// context for the next round.
  _stopAndSendQueued() {
    const ws = window.__foyer?.ws;
    const q = this._queuedMessage;
    if (!ws || !q) return;
    ws.send({ type: "agent_stop" });
    // Send the queued message right after the stop. The server
    // serialises commands per-connection so the agent observes:
    //   1. cancel  →  partial assistant content finalised
    //   2. agent_send  →  new user message + new turn
    ws.send({ type: "agent_send", body: q.body, attachments: q.attachments });
    this._queuedMessage = null;
    this._pinnedToBottom = true;
  }

  /// Pull a parked queued message back into the composer so the user
  /// can edit / discard it.
  _restoreQueuedToInput() {
    if (!this._queuedMessage) return;
    if (this._input.trim().length === 0) {
      this._input = this._queuedMessage.body;
    }
    this._queuedMessage = null;
  }

  /// Composer block shared across floating / docked / slide / tear-out
  /// render modes. Adds the queued-message banner with the
  /// Stop & send button when a message is parked.
  _renderComposer() {
    const queued = this._queuedMessage;
    const busy = this._agentBusy;
    return html`
      <div class="composer ${this._dropHover ? "drop-hover" : ""}"
           @dragover=${this._onComposerDragOver}
           @dragleave=${this._onComposerDragLeave}
           @drop=${this._onComposerDrop}>
        ${queued ? html`
          <div class="queued-banner">
            <div class="queued-banner-body">
              <strong>${tr("Queued:")}</strong>
              <span class="queued-text" title=${queued.body}>${queued.body}</span>
            </div>
            <div class="queued-banner-actions">
              <button class="queued-stop"
                      @click=${this._stopAndSendQueued}
                      title=${tr("Interrupt the agent and send this message now")}>
                ${tr("Stop & send")}
              </button>
              <button class="queued-restore"
                      @click=${this._restoreQueuedToInput}
                      title=${tr("Pull the queued message back into the composer")}>
                ${tr("Edit")}
              </button>
              <button class="queued-cancel"
                      @click=${() => { this._queuedMessage = null; }}
                      title=${tr("Discard the queued message")}>
                ${icon("x-mark", 12)}
              </button>
            </div>
          </div>
        ` : nothing}
        ${this._renderAttachments()}
        <textarea
          placeholder=${busy ? tr("Type to queue while the agent works…") : tr("Ask the agent…")}
          style=${`height: ${this._composerHeight}px`}
          .value=${this._input}
          @input=${(e) => { this._input = e.target.value; }}
          @keydown=${this._onInputKey}
          @paste=${this._onComposerPaste}
          @mouseup=${this._onComposerResize}
          @blur=${this._onComposerResize}
        ></textarea>
        <button
          class=${busy && this._input.trim().length > 0 ? "send-stop" : ""}
          @click=${busy && this._input.trim().length > 0 ? this._sendInterrupting : this._send}
          ?disabled=${!busy && !this._input.trim() && this._attachments.length === 0}
          title=${busy && this._input.trim().length > 0
            ? tr("Stop the agent and send this message")
            : tr("Send")}>
          ${busy && this._input.trim().length > 0
            ? icon("x-circle", 14)
            : icon("paper-airplane", 14)}
        </button>
      </div>
    `;
  }

  /// Convenience for the send button: when the composer has fresh
  /// text AND the agent is busy, hitting send should both stop the
  /// runaway turn AND dispatch the new message — same effect as
  /// queueing + clicking the banner's Stop & send, but in one tap.
  _sendInterrupting = async () => {
    const text = this._input.trim();
    if (!text && this._attachments.length === 0) return;
    // Stage as queued, then trip stop. `_stopAndSendQueued` reads
    // _queuedMessage so we need the parked record there.
    const attachments = this._attachments
      .map((a) => ({ name: a.name, mime: a.kind, b64: a.bytes_b64 || "" }))
      .filter((a) => a.b64);
    this._queuedMessage = { body: text, attachments };
    this._input = "";
    this._attachments = [];
    this._stopAndSendQueued();
  };
  _clear() {
    this._transcript = [];
    window.__foyer?.ws?.send({ type: "agent_clear_history" });
  }

  /// Render-only fallback for client-side notices that aren't
  /// echoed by the server (transport errors, etc.). Doesn't touch
  /// the canonical transcript on the server side.
  _appendLocal(role, text) {
    this._transcript = [...this._transcript, { id: -Date.now(), role, text }];
  }

  _confirmTool(call_id, approve) {
    window.__foyer?.ws?.send({ type: "agent_confirm_tool", call_id, approve });
  }

  // ─── Chat sessions ────────────────────────────────────────────

  _openSessions() {
    this._sessionsOpen = true;
    this._pendingDeleteId = "";
    window.__foyer?.ws?.send({ type: "agent_session_list" });
  }
  _closeSessions() {
    this._sessionsOpen = false;
    this._pendingDeleteId = "";
  }
  _newSession() {
    window.__foyer?.ws?.send({ type: "agent_session_new" });
    this._sessionsOpen = false;
  }
  _loadSession(id) {
    window.__foyer?.ws?.send({ type: "agent_session_load", id });
    this._sessionsOpen = false;
  }
  _renameSession(id, currentTitle) {
    const next = prompt(tr("Rename session"), currentTitle || "");
    if (next == null) return;
    const title = next.trim();
    if (!title || title === currentTitle) return;
    window.__foyer?.ws?.send({ type: "agent_session_rename", id, title });
  }
  /// Individual session delete — fire-and-forget. The per-row confirm
  /// step was redundant with the (much more dangerous) "delete all"
  /// affordance below, which DOES still gate behind a confirm.
  _deleteSession(id) {
    if (!id) return;
    window.__foyer?.ws?.send({ type: "agent_session_delete", id });
  }
  _askDeleteAllSessions() { this._pendingDeleteId = "__ALL__"; }
  _cancelDeleteSession() { this._pendingDeleteId = ""; }
  _confirmDeleteAllSessions() {
    const ws = window.__foyer?.ws;
    if (!ws) return;
    // Snapshot ids so a mid-loop session-list refresh doesn't drop one.
    for (const s of this._sessions) {
      ws.send({ type: "agent_session_delete", id: s.id });
    }
    this._pendingDeleteId = "";
  }

  _renderSessionsOverlay() {
    if (!this._sessionsOpen) return nothing;
    const confirmingAll = this._pendingDeleteId === "__ALL__";
    return html`
      <div class="sessions-backdrop" @click=${(e) => { if (e.target === e.currentTarget) this._closeSessions(); }}>
        <div class="sessions-modal" @click=${(e) => e.stopPropagation()}>
          <header>
            <div class="title">${tr("Chat Sessions")}</div>
            <div class="spacer"></div>
            <button @click=${this._newSession} title=${tr("New session")}>
              ${icon("plus", 14)} ${tr("New")}
            </button>
            <button
              class="danger"
              ?disabled=${this._sessions.length === 0}
              @click=${this._askDeleteAllSessions}
              title=${tr("Delete every saved session")}>
              ${icon("trash", 14)} ${tr("Delete all")}
            </button>
            <button @click=${this._closeSessions} title=${tr("Close")}>
              ${icon("x-mark", 14)}
            </button>
          </header>
          <div class="sessions-body">
            ${this._sessions.length === 0
              ? html`<div class="sessions-empty">${tr("No saved sessions yet.")}</div>`
              : this._sessions.map((s) => this._renderSessionRow(s))}
          </div>
          ${confirmingAll ? html`
            <div class="sessions-confirm">
              <span>${tr("Delete ALL %{count} session(s)? This can't be undone.", { count: this._sessions.length })}</span>
              <div style="display:flex; gap:6px;">
                <button @click=${this._cancelDeleteSession}>${tr("Cancel")}</button>
                <button class="danger" @click=${this._confirmDeleteAllSessions}>${tr("Delete all")}</button>
              </div>
            </div>
          ` : nothing}
        </div>
      </div>
    `;
  }

  _renderSessionRow(s) {
    const active = s.id === this._activeSessionId;
    return html`
      <div class="session-row ${active ? "active" : ""}">
        <button class="session-pick" @click=${() => this._loadSession(s.id)}>
          <div class="session-title">${s.title}${active ? " ·" : ""}</div>
          <div class="session-meta">
            ${tn("%{count} msg", "%{count} msg", s.message_count, { count: s.message_count })} · ${new Date(s.updated_ms).toLocaleString()}
          </div>
        </button>
        <button class="session-action" title=${tr("Rename")}
                @click=${() => this._renameSession(s.id, s.title)}>
          ${icon("cog", 12)}
        </button>
        <button class="session-action danger" title=${tr("Delete")}
                @click=${() => this._deleteSession(s.id)}>
          ${icon("trash", 12)}
        </button>
      </div>
    `;
  }

  /// Render a single transcript row. `tool`-role rows (raw context
  /// results being fed back to the model) are hidden from the
  /// visible transcript — they're surfaced as collapsible cards
  /// attached to the assistant turn that emitted them. Records the
  /// harness synthesizes for the LLM's own consumption
  /// (`m.synthetic` set — currently the tool-vision-context push
  /// after a media-producing tool call) are also hidden, since they
  /// were never anything the user actually typed. The tool card
  /// already surfaces the image / audio chip; the synthetic record
  /// is purely backend plumbing for the vision tower.
  _renderMsg(m) {
    if (m.role === "tool") return nothing;
    if (m.synthetic) return nothing;
    const calls = (m.tool_calls || []).map((c) => this._renderToolCard(c));
    if (m.role === "user") {
      return html`<div class="msg user">${m.text || ""}</div>`;
    }
    if (m.role === "assistant") {
      const { thinkingSegments, content, stillThinking } = parseThinking(m.text || "");
      const visible = content.trim();
      const md = visible ? unsafeHTML(renderMarkdown(visible)) : nothing;
      return html`
        ${thinkingSegments.map((seg, i) => this._renderThinking(
          seg.text,
          seg.live,
          // Stable-per-row index keys ensure Lit reuses the right
          // <details>; without keys, expanding one block could shift
          // its open state to a neighbour on the next token tick.
          `${m.id}-${i}`,
        ))}
        ${visible ? html`<div class="msg assistant"><div class="md">${md}</div></div>` : nothing}
        ${calls}
        ${stillThinking && thinkingSegments.length === 0
          ? this._renderThinking(tr("Thinking…"), true, `${m.id}-live`)
          : nothing}
      `;
    }
    // system or fallback
    return html`<div class="msg system">${m.text || ""}</div>`;
  }

  /// Collapsible reasoning trace, one per `<think>` block. The `key`
  /// is rendered as a `data-key` attribute (and used by Lit's repeat
  /// keying via the parent's `.map` so each block keeps its open /
  /// closed state independently). `live=true` paints the spinner.
  _renderThinking(text, live, key) {
    const cls = `thinking${live ? " live" : ""}`;
    return html`
      <details class=${cls} ?open=${live} data-key=${key || ""}>
        <summary>
          ${live
            ? html`<span class="spinner"></span><span>${tr("Thinking…")}</span>`
            : html`<span class="caret">▶</span><span>${tr("Thinking")}</span>`}
        </summary>
        <div class="body">${text}</div>
      </details>
    `;
  }

  /// Patapsco-style tool-call card: status icon + name in the
  /// always-visible header, expand to see args / result / errors.
  _renderAttachments() {
    if (this._attachments.length === 0) return nothing;
    return html`
      <div class="attachments">
        ${this._attachments.map((a, i) => {
          const isImage = typeof a.kind === "string" && a.kind.startsWith("image/");
          const src = isImage && a.bytes_b64
            ? `data:${a.kind};base64,${a.bytes_b64}`
            : null;
          return html`
            <div class="chip" title=${tr("%{kind} · %{size} · forwarded to the model on send", { kind: a.kind, size: formatBytes(a.bytes) })}>
              ${src ? html`
                <button
                  class="thumb"
                  title=${tr("Click to expand")}
                  @click=${(e) => { e.preventDefault(); this._zoomImage = { src, alt: a.name }; }}>
                  <img src=${src} alt=${a.name} />
                </button>
              ` : nothing}
              <span class="name">${a.name}</span>
              <button @click=${() => this._removeAttachment(i)} title=${tr("Remove")}>${icon("x-mark", 10)}</button>
            </div>
          `;
        })}
      </div>
    `;
  }

  _renderToolCard(c) {
    const status = c.status || "pending";
    const cls = `tool-card ${status}`;
    const iconName =
      status === "running"          ? "clock" :
      status === "error"            ? "x-circle" :
      status === "awaiting_confirm" ? "clock" :
      status === "rejected"         ? "x-circle" :
                                      "check-circle";
    const parsedArgs = (() => {
      try {
        return JSON.parse(c.args_json || "{}");
      } catch {
        return null;
      }
    })();
    const argsText = parsedArgs && Object.keys(parsedArgs).length
      ? JSON.stringify(parsedArgs, null, 2)
      : "";
    const parsedResult = (() => {
      if (!c.result_json) return null;
      try {
        return JSON.parse(c.result_json);
      } catch {
        return null;
      }
    })();
    // Detect inline media on the tool result so we can render a tiny
    // thumbnail + click-to-zoom modal instead of dumping the base64
    // string into the result block. Currently `visualize.*` is the
    // only producer; the shape is `{ image_png_b64: "<b64>" }` (the
    // Rust ToolResult also serializes other variants like
    // `image_jpg_b64` if we ever add them — handled here for
    // forward-compat).
    const media = (() => {
      if (!parsedResult || typeof parsedResult !== "object") return null;
      for (const [k, v] of Object.entries(parsedResult)) {
        if (typeof v !== "string" || !v) continue;
        if (k === "image_png_b64") return { mime: "image/png", b64: v };
        if (k === "image_jpg_b64" || k === "image_jpeg_b64") {
          return { mime: "image/jpeg", b64: v };
        }
        if (k === "image_webp_b64") return { mime: "image/webp", b64: v };
      }
      return null;
    })();
    const resultText = (() => {
      const raw = c.result_json || "";
      if (!raw) return "";
      if (parsedResult && typeof parsedResult === "object") {
        // Strip any base64 media payload before dumping JSON: the raw
        // string would otherwise be hundreds of KB of unreadable
        // gibberish that drowns the actual result.
        const pruned = { ...parsedResult };
        for (const k of [
          "image_png_b64", "image_jpg_b64", "image_jpeg_b64", "image_webp_b64",
        ]) {
          if (k in pruned) delete pruned[k];
        }
        return JSON.stringify(pruned, null, 2);
      }
      if (typeof parsedResult === "string") return parsedResult;
      return raw;
    })();
    // Single-line condensed label for the closed card so the user
    // can see what the call did without expanding. Pulls the
    // subcommand from args and the structured `summary` from the
    // result. Falls back to the raw result string for legacy tools.
    const subcommand = parsedArgs && typeof parsedArgs.subcommand === "string"
      ? parsedArgs.subcommand
      : "";
    const inlineLabel = c.tool_name
      ? subcommand
        ? `${c.tool_name}.${subcommand}`
        : c.tool_name
      : "(tool)";
    const inlineSummary = (() => {
      if (parsedResult && typeof parsedResult === "object" && typeof parsedResult.summary === "string") {
        return parsedResult.summary;
      }
      if (typeof parsedResult === "string") return parsedResult;
      // Running / awaiting — surface the preview when present.
      if (c.preview) return String(c.preview);
      return "";
    })();
    const hasDetails = argsText || resultText || media;
    const isAwaiting = status === "awaiting_confirm";
    const showRaw = this._rawToolCards.has(c.call_id);
    return html`
      <details class=${cls} ?open=${status === "running" || isAwaiting || status === "error"}>
        <summary>
          ${icon(iconName, 14)}
          <span class="tool-name">${inlineLabel}</span>
          ${inlineSummary
            ? html`<span class="tool-inline-summary">${inlineSummary}</span>`
            : nothing}
          <span class="tool-status">${status}</span>
        </summary>
        ${hasDetails ? html`
          <div class="tool-details">
            <div class="tool-view-toggle">
              <button
                class=${showRaw ? "" : "active"}
                @click=${(e) => { e.preventDefault(); this._setToolCardRaw(c.call_id, false); }}
              >${tr("Pretty")}</button>
              <button
                class=${showRaw ? "active" : ""}
                @click=${(e) => { e.preventDefault(); this._setToolCardRaw(c.call_id, true); }}
              >${tr("Raw")}</button>
            </div>
            ${showRaw
              ? html`
                ${argsText ? html`<div class="tool-section-label">${tr("Input")}</div>
                                   ${this._renderToolBlock(c.call_id, "input", argsText)}` : nothing}
                ${resultText ? html`<div class="tool-section-label">${tr("Output")}</div>
                                     ${this._renderToolBlock(c.call_id, "output", resultText)}` : nothing}
                ${media ? html`<div class="tool-section-label">${tr("Media")}</div>
                                ${this._renderToolMedia(media, inlineLabel)}` : nothing}
              `
              : html`
                ${parsedArgs && Object.keys(parsedArgs).length
                  ? html`<div class="tool-section-label">${tr("Input")}</div>
                          ${this._renderKvBlock(parsedArgs)}` : nothing}
                ${parsedResult !== null
                  ? html`<div class="tool-section-label">${tr("Output")}</div>
                          ${this._renderKvBlock(stripMedia(parsedResult))}` : nothing}
                ${media ? this._renderToolMedia(media, inlineLabel) : nothing}
              `}
          </div>
        ` : nothing}
        ${isAwaiting ? html`
          <div class="tool-confirm-row">
            <button @click=${() => this._confirmTool(c.call_id, true)}>${tr("Approve")}</button>
            <button @click=${() => this._confirmTool(c.call_id, false)}>${tr("Reject")}</button>
          </div>
        ` : nothing}
      </details>
    `;
  }

  _setToolCardRaw(callId, raw) {
    const next = new Set(this._rawToolCards);
    if (raw) next.add(callId); else next.delete(callId);
    this._rawToolCards = next;
  }

  /// Render a long string body as a tool-block with truncation +
  /// "see full" expander. The expanded state is tracked per
  /// `<call_id>:<slot>` key so the user can independently expand
  /// the input and output of the same card.
  _renderToolBlock(callId, slot, text) {
    if (!text) return nothing;
    const key = `${callId}:${slot}`;
    const expanded = this._expandedToolBlocks.has(key);
    const truncated = text.length > TOOL_BLOCK_TRUNCATE && !expanded;
    const body = truncated ? text.slice(0, TOOL_BLOCK_TRUNCATE) + "…" : text;
    return html`
      <div class="tool-block">${body}</div>
      ${text.length > TOOL_BLOCK_TRUNCATE
        ? html`
          <button
            class="tool-block-expand"
            @click=${(e) => {
              e.preventDefault();
              const next = new Set(this._expandedToolBlocks);
              if (expanded) next.delete(key); else next.add(key);
              this._expandedToolBlocks = next;
            }}
          >${expanded
            ? html`${tr("Collapse")}`
            : html`${tr("See full · %{count} chars", { count: text.length.toLocaleString() })}`}
          </button>
        `
        : nothing}
    `;
  }

  /// Render a structured value as a 2-column K/V list. Primitive
  /// values land inline; nested objects recurse one level then fall
  /// back to a JSON snippet (cap depth — agent tool results aren't
  /// typically deep, but `session.full` would otherwise sprawl).
  _renderKvBlock(value, depth = 0) {
    if (value === null || value === undefined) {
      return html`<div class="tool-block muted">${tr("(empty)")}</div>`;
    }
    if (typeof value !== "object") {
      return html`<div class="tool-kv-scalar">${String(value)}</div>`;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return html`<div class="tool-block muted">${tr("(empty list)")}</div>`;
      }
      return html`
        <ol class="tool-kv-list">
          ${value.map((v) => html`<li>${this._renderKvValue(v, depth + 1)}</li>`)}
        </ol>
      `;
    }
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return html`<div class="tool-block muted">${tr("(empty)")}</div>`;
    }
    return html`
      <dl class="tool-kv">
        ${entries.map(([k, v]) => html`
          <dt>${k}</dt>
          <dd>${this._renderKvValue(v, depth + 1)}</dd>
        `)}
      </dl>
    `;
  }

  _renderKvValue(v, depth) {
    if (v === null) return html`<span class="muted">null</span>`;
    if (v === undefined) return html`<span class="muted">undefined</span>`;
    if (typeof v === "boolean") return html`<span class="tool-kv-bool">${v ? "true" : "false"}</span>`;
    if (typeof v === "number") return html`<span class="tool-kv-num">${v}</span>`;
    if (typeof v === "string") return html`<span class="tool-kv-str">${v}</span>`;
    // Cap recursion at depth 2 so giant payloads don't blow up the
    // card. Past that, render a JSON snippet inline.
    if (depth > 2) {
      return html`<code class="tool-kv-json">${JSON.stringify(v)}</code>`;
    }
    return this._renderKvBlock(v, depth);
  }

  /// Inline media thumbnail with click-to-zoom. The base64 lives on
  /// the tool result already; we wrap it in a data: URL for the <img>
  /// src. Clicking opens the modal lightbox bound to `_zoomImage`.
  _renderToolMedia(media, label) {
    const src = `data:${media.mime};base64,${media.b64}`;
    const alt = label || tr("tool output image");
    return html`
      <button
        class="tool-media-thumb"
        @click=${(e) => {
          e.preventDefault();
          this._zoomImage = { src, alt };
        }}
        title=${tr("Click to expand")}
      >
        <img src=${src} alt=${alt} />
      </button>
    `;
  }

  _renderZoomModal() {
    if (!this._zoomImage) return nothing;
    const close = () => { this._zoomImage = null; };
    return html`
      <div
        class="media-zoom-backdrop"
        @click=${close}
        @keydown=${(e) => { if (e.key === "Escape") close(); }}
        tabindex="-1"
      >
        <img
          class="media-zoom-image"
          src=${this._zoomImage.src}
          alt=${this._zoomImage.alt}
          @click=${(e) => e.stopPropagation()}
        />
        <button class="media-zoom-close" @click=${close} title=${tr("Close")}>
          ${icon("x-mark", 18)}
        </button>
      </div>
    `;
  }

  /// Translate one record from `foyer_schema::AgentMessageRecord`
  /// into the panel's local row shape. The panel currently keys on
  /// `id`, `role`, `text`, `tool_calls`, `tool_call_id`, and the
  /// optional `synthetic` marker (set on harness-generated records
  /// like the tool-vision-context push — `_renderMsg` hides those
  /// rows so they don't masquerade as user messages in the FAB).
  _recordToRow(record) {
    return {
      id: record.id,
      role: record.role,
      text: record.content || "",
      tool_calls: record.tool_calls || [],
      tool_call_id: record.tool_call_id || null,
      synthetic: record.synthetic || null,
    };
  }

  /// Subscribe to the control-WS envelope stream and translate
  /// `agent_*` events into transcript updates.
  _onEnvelope = (ev) => {
    const body = ev.detail?.body;
    if (!body || typeof body.type !== "string") return;
    switch (body.type) {
      case "agent_history": {
        this._transcript = (body.records || []).map((r) => this._recordToRow(r));
        return;
      }
      case "agent_message": {
        const row = this._recordToRow(body.record);
        // The engine streams tokens BEFORE finalizing the
        // assistant record. If we already have a row for this id
        // (from prior token deltas), replace it; otherwise append.
        const idx = this._transcript.findIndex((r) => r.id === row.id);
        if (idx >= 0) {
          const next = this._transcript.slice();
          next[idx] = row;
          this._transcript = next;
        } else {
          this._transcript = [...this._transcript, row];
        }
        return;
      }
      case "agent_token": {
        const id = body.message_id;
        const delta = body.delta || "";
        const idx = this._transcript.findIndex((r) => r.id === id);
        if (idx >= 0) {
          const next = this._transcript.slice();
          next[idx] = { ...next[idx], text: (next[idx].text || "") + delta };
          this._transcript = next;
        } else {
          // First token arrived before the AgentMessage record —
          // synthesize a placeholder so we have somewhere to land
          // the delta. The eventual record will replace it.
          this._transcript = [
            ...this._transcript,
            { id, role: "assistant", text: delta, tool_calls: [], tool_call_id: null },
          ];
        }
        return;
      }
      case "agent_tool_update": {
        const id = body.message_id;
        const idx = this._transcript.findIndex((r) => r.id === id);
        if (idx < 0) return;
        const row = this._transcript[idx];
        const calls = (row.tool_calls || []).map((c) =>
          c.call_id === body.call_id
            ? {
                ...c,
                status: body.status,
                preview: body.preview || c.preview,
                result_json: body.result_json || c.result_json,
              }
            : c,
        );
        const next = this._transcript.slice();
        next[idx] = { ...row, tool_calls: calls };
        this._transcript = next;
        return;
      }
      case "agent_state": {
        this._agentBusy = !!body.busy;
        this._agentConfig = body.config || null;
        return;
      }
      case "agent_skills_listed": {
        this._agentSkills = body.skills || [];
        return;
      }
      case "agent_memories_listed": {
        this._agentMemories = body.memories || [];
        return;
      }
      case "agent_templates_listed": {
        this._agentTemplates = body.templates || [];
        return;
      }
      case "agent_sessions_listed": {
        this._sessions = body.sessions || [];
        if (typeof body.active_id === "string") {
          this._activeSessionId = body.active_id;
        }
        return;
      }
      case "agent_session_activated": {
        // The runtime cleared its conversation and is about to
        // refill via AgentMessage events. Drop our local transcript
        // so the new session paints from scratch.
        this._transcript = [];
        this._activeSessionId = body.id || "";
        return;
      }
      default:
        return;
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  render() {
    // Slide-out mode: rendered inside the right-dock's slot. We've
    // been reparented under the dock host via `enterSlideMode`; the
    // panel fills the slot, no fixed positioning needed.
    if (this._slideMode) {
      return html`
        ${this._renderSlidePanel()}
        <foyer-agent-settings-modal
          ?open=${this._settingsOpen}
          @save=${() => { this._settingsOpen = false; }}
          @close=${() => { this._settingsOpen = false; }}
        ></foyer-agent-settings-modal>
        ${this._renderZoomModal()}
      `;
    }
    // Docked mode without slide: the rail icon is visible but the
    // panel isn't open. (Slide mode is the normal "open" path now;
    // this kept around for backwards-compat with `openFromDock`.)
    if (this._isDocked()) {
      return html`
        ${this._open ? this._renderDockedPanel() : nothing}
        <foyer-agent-settings-modal
          ?open=${this._settingsOpen}
          @save=${() => { this._settingsOpen = false; }}
          @close=${() => { this._settingsOpen = false; }}
        ></foyer-agent-settings-modal>
        ${this._renderZoomModal()}
      `;
    }

    const zSuffix = this._zOverride > 0 ? `; z-index: ${this._zOverride + 1}` : "";
    const fabStyle = `right: ${this._fabRight}px; bottom: ${this._fabBottom}px${zSuffix}`;
    const fabClasses = [
      "fab",
      this._open ? "open" : "",
      this._dragState?.kind === "fab" ? "dragging" : "",
    ].filter(Boolean).join(" ");

    return html`
      <button
        class=${fabClasses}
        style=${fabStyle}
        @pointerdown=${this._onFabDown}
        aria-label=${this._open ? tr("Close agent") : tr("Open agent")}
        title=${this._open ? tr("Close agent") : tr("Open agent")}
      >
        ${icon("chat-bubble-left-right", 22)}
      </button>

      ${this._open ? this._renderPanel() : nothing}
      <foyer-agent-settings-modal
        ?open=${this._settingsOpen}
        @save=${() => { this._settingsOpen = false; }}
        @close=${() => { this._settingsOpen = false; }}
      ></foyer-agent-settings-modal>
      ${this._renderZoomModal()}
    `;
  }

  /**
   * Docked presentation: the panel anchors to the right rail instead of to
   * the floating FAB position. The rail itself stays thin; we extend LEFT
   * from the rail with the agent's preferred width so long conversation
   * turns get readable line length.
   */
  _renderSlidePanel() {
    return html`
      <div class="panel" style="position:relative;width:100%;height:100%;border-radius:0;box-shadow:none;border:0"
           role="dialog" aria-label=${tr("Foyer agent")}>
        <header style="cursor:default">
          <div class="title">${tr("Agent")}</div>
          <div class="spacer"></div>
          <button @click=${this._newSession} title=${tr("New session")}>
            ${icon("plus", 14)}
          </button>
          <button @click=${this._openSessions} title=${tr("Chat history")}>
            ${icon("clock", 14)}
          </button>
          <button @click=${() => { this._settingsOpen = true; }} title=${tr("Settings")}>
            ${icon("cog", 14)}
          </button>
          <button @click=${() => this._tearOutToFloating()}
                  title=${tr("Tear out — return to floating FAB")}>
            ${icon("arrow-top-right-on-square", 14)}
          </button>
          <button @click=${this.closeFromDock} title=${tr("Close")}>
            ${icon("x-mark", 14)}
          </button>
        </header>
        <div class="transcript">
          ${this._transcript.length === 0
            ? html`<div class="empty">
                <strong>${tr("Foyer Agent")}</strong>
                ${tr("Ask the agent to move faders, arm tracks, or explain the mix. Configure the LLM endpoint in settings; WebLLM runs locally in this tab.")}
              </div>`
            : this._transcript.map((m) => this._renderMsg(m))}
        </div>
        ${this._renderComposer()}
        ${this._renderSessionsOverlay()}
      </div>
    `;
  }

  _renderDockedPanel() {
    const rd = window.__foyer?.rightDock;
    const rail = rd?.railRect?.();
    const right = rail ? window.innerWidth - rail.left + 8 : 60;
    const top = Math.max(16, this._dockIconTop || 120);
    const vh = window.innerHeight;
    const w = Math.min(this._panelWidth, Math.max(360, window.innerWidth - right - 16));
    const h = Math.min(this._panelHeight, Math.max(360, vh - top - 16));
    const style = `position:fixed;right:${right}px;top:${top}px;width:${w}px;height:${h}px`;
    // Re-use the existing panel DOM so chat, settings, header all work.
    // The resize corner has no meaningful direction in docked mode, so we
    // just omit it — docked width is controlled by the rail.
    return html`
      <div class="panel" role="dialog" aria-label=${tr("Foyer agent")} style=${style}>
        <header>
          <div class="title">${tr("Agent")}</div>
          <div class="spacer"></div>
          <button @click=${() => { this._settingsOpen = true; }} title=${tr("Settings")}>
            ${icon("cog", 14)}
          </button>
          <button @click=${() => this._tearOutToFloating()}
                  title=${tr("Undock")}>
            ${icon("arrow-top-right-on-square", 14)}
          </button>
          <button @click=${this.closeFromDock} title=${tr("Close")}>
            ${icon("x-mark", 14)}
          </button>
        </header>
        <div class="transcript">
          ${this._transcript.length === 0
            ? html`<div class="empty">${tr("Docked agent — conversation will appear here.")}</div>`
            : this._transcript.map((t) => this._renderMsg(t))}
        </div>
        ${this._renderComposer()}
        ${this._renderSessionsOverlay()}
      </div>
    `;
  }

  _renderPanel() {
    const { style, isTop, isLeft } = this._panelStyle();
    // The resize corner is the one pointing AWAY from the FAB.
    const corner = `${isTop ? "s" : "n"}${isLeft ? "e" : "w"}`;
    const styleZ = this._zOverride > 0 ? `${style}; z-index: ${this._zOverride}` : style;
    return html`
      <div class="panel" role="dialog" aria-label=${tr("Foyer agent")} style=${styleZ}
           @pointerdown=${() => this._raise()}>
        <div class="resize ${corner}" @pointerdown=${(e) => this._onResizeDown(e, corner)}></div>
        <header @pointerdown=${this._onPanelHeaderDown}>
          <div class="title">${tr("Agent")}</div>
          <div class="spacer"></div>
          <button @pointerdown=${(e) => e.stopPropagation()}
                  @click=${this._newSession}
                  title=${tr("New session")}>
            ${icon("plus", 14)}
          </button>
          <button @pointerdown=${(e) => e.stopPropagation()}
                  @click=${this._openSessions}
                  title=${tr("Chat history")}>
            ${icon("clock", 14)}
          </button>
          <button @pointerdown=${(e) => e.stopPropagation()}
                  @click=${() => { this._settingsOpen = true; }}
                  title=${tr("Settings")}>
            ${icon("cog", 14)}
          </button>
          <button @pointerdown=${(e) => e.stopPropagation()}
                  @click=${() => { this._open = false; this._persist(); this.requestUpdate(); }}
                  title=${tr("Close")}>
            ${icon("x-mark", 14)}
          </button>
        </header>
        <div class="transcript">
          ${this._transcript.length === 0
            ? html`<div class="welcome"><strong>${tr("Foyer Agent")}</strong>${tr("Ask the agent to move faders, arm tracks, or explain the mix. Configure the LLM endpoint in settings; WebLLM runs locally in this tab.")}</div>`
            : this._transcript.map((m) => this._renderMsg(m))}
        </div>
        <div class="input-area ${this._dropHover ? "drop-hover" : ""}"
             @dragover=${this._onComposerDragOver}
             @dragleave=${this._onComposerDragLeave}
             @drop=${this._onComposerDrop}>
          ${this._renderAttachments()}
          <textarea
            placeholder=${tr("Ask the agent…")}
            style=${`height: ${this._composerHeight}px`}
            .value=${this._input}
            @input=${(e) => { this._input = e.target.value; }}
            @keydown=${this._onInputKey}
            @paste=${this._onComposerPaste}
            @mouseup=${this._onComposerResize}
            @blur=${this._onComposerResize}
          ></textarea>
          <button @click=${this._send} ?disabled=${!this._input.trim() && this._attachments.length === 0} title=${tr("Send")}>
            <svg viewBox="0 0 24 24"><path d="M4 12l16-8-8 16-2-7-6-1z"/></svg>
          </button>
        </div>
        ${this._renderSessionsOverlay()}
      </div>
    `;
  }
}
customElements.define("foyer-agent-panel", AgentPanel);

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
