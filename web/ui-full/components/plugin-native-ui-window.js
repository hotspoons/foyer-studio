// Plugin native-UI window — a `<foyer-window>` that embeds an
// xpra HTML5 client viewing the X display Ardour is painting onto.
//
// Wire chain (see also Phase 2 plan):
//   1. Plugin panel toggle → `ws.send({type: "open_plugin_gui", ...})`
//      (also calls `openPluginNativeUi` from this file)
//   2. WS dispatch → `backend.show_plugin_gui` → IPC → shim
//   3. Shim emits `Processor::ShowUI` (libardour signal)
//   4. gtk2_ardour catches it, opens the plugin's editor on $DISPLAY
//   5. xpra (running on the same $DISPLAY) captures the new window
//   6. THIS widget — an iframe pointed at xpra's HTML5 endpoint —
//      renders that capture inside Foyer's UI.
//
// xpra URL resolution:
//   - Default: same-origin `/_xpra/` — foyer-server mounts xpra's
//     HTML5 dist (from `/usr/share/xpra/www/` by default) at this
//     path, AND proxies `/ws/plugin-gui` to the local xpra TCP
//     socket. xpra's protocol multiplexes all plugin windows over
//     that one WS, so we stay under the browser's per-origin
//     connection cap regardless of how many editors are open.
//   - Override: `?foyer.xpraUrl=...` query param at page load,
//     OR `localStorage.setItem("foyer.xpra.url", ...)`. Useful for
//     pointing at an out-of-band xpra during dev (e.g. one started
//     manually for diagnostics).
//
// Filtering: this is v1 — the iframe shows the whole xpra session
// (Ardour's main editor + every plugin window). The plugin the
// user toggled is the most-recently-opened window, so it's the
// natural focus. A future iteration could pass `?windows=<id>` to
// xpra-html5 to restrict the canvas to one window-id, but that
// needs a roundtrip to discover the X11 window id assigned to the
// just-opened plugin (xpra exposes this via its protocol).

import { LitElement, html, css } from "lit";

function xpraUrl() {
  const url = new URL(window.location.href);
  const override =
    url.searchParams.get("foyer.xpraUrl") ||
    window.localStorage.getItem("foyer.xpra.url");
  if (override) return override;
  // Same-origin: xpra HTML5 dist mounted at `/_xpra/` and the WS
  // proxy at `/ws/plugin-gui`. xpra-html5's index.html reads:
  //   server  → window.location.hostname (defaulted)
  //   port    → window.location.port     (defaulted)
  //   ssl     → derived from https flag  (defaulted)
  //   path    → from `?path=...` query   (we set explicitly)
  // `submit=true` auto-submits the connect form so the user
  // doesn't have to click anything; `insecure=true` allows
  // plain WS (we're tunneling through Foyer's already-TLS-or-
  // not connection, no need for inner TLS).
  const params = new URLSearchParams({
    path: "/ws/plugin-gui",
    action: "connect",
    submit: "true",
    insecure: "true",
    // Keep the on-screen keyboard OFF — we want plugin windows to
    // get the host browser's real keyboard via the canvas. The
    // virtual keyboard takes ~half the viewport on tablet sizes.
    keyboard: "false",
    floating_menu: "false",
    tray: "false",
    // Auto-resize the canvas to fit the iframe rather than pinning
    // a fixed virtual desktop. Plugin windows don't have a "best
    // size" beyond what they ask for, so let the container drive.
    autoresize: "true",
    // Don't try to forward audio over the WS — we'd have an awful
    // time managing two audio paths. Foyer's egress already handles
    // master-bus playback for the user; xpra audio would conflict.
    audio: "false",
    speaker: "false",
    microphone: "false",
  });
  return `/_xpra/index.html?${params.toString()}`;
}

export class PluginNativeUiWindow extends LitElement {
  static properties = {
    pluginId: { type: String },
    pluginName: { type: String },
  };

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      background: var(--color-surface, #111);
      color: var(--color-text, #eee);
      font-family: var(--font-sans);
    }
    iframe {
      display: block;
      width: 100%;
      height: 100%;
      border: 0;
      background: #000;
    }
    .help {
      padding: 12px 16px;
      font-size: 11px;
      color: var(--color-text-muted, #aaa);
      line-height: 1.5;
    }
    .help code {
      font-family: var(--font-mono);
      background: var(--color-surface-elevated, #222);
      padding: 1px 4px;
      border-radius: 3px;
    }
  `;

  constructor() {
    super();
    this.pluginId = "";
    this.pluginName = "";
  }

  render() {
    const url = xpraUrl();
    return html`
      <iframe
        title=${`Native GUI — ${this.pluginName || this.pluginId}`}
        src=${url}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        @load=${(e) => this._installWindowFilter(e.target)}
      ></iframe>
    `;
  }

  /**
   * Filter the xpra-html5 iframe to show only windows whose X11
   * title contains the plugin's name. Strategy: parent-side DOM
   * observation via MutationObserver — same-origin so we can
   * touch the iframe's document directly.
   *
   * Why not script injection: timing is fragile (script may
   * inject before xpra-html5's XpraWindow class is defined) and
   * harder to debug from the host page's console.
   *
   * xpra-html5's window structure (verified in
   * /usr/share/xpra/www/js/Window.js):
   *   <div id="${wid}" class="window wmclass-...">
   *     <div id="head${wid}" class="windowhead">
   *       <span class="windowtitle" id="title${wid}">TITLE</span>
   *       …
   *     </div>
   *     <canvas></canvas>
   *   </div>
   * The `.windowtitle` span text is the X11 title.
   */
  _installWindowFilter(iframe) {
    if (!iframe || !this.pluginName) return;
    let doc;
    try {
      doc = iframe.contentDocument;
    } catch {
      // Cross-origin (shouldn't happen — same origin via /_xpra/)
      // but if it does, bail out and accept the unfiltered view.
      return;
    }
    if (!doc) return;

    // Body / menu reset.
    const style = doc.createElement("style");
    style.textContent = `
      #float_menu, #pasteboard, #tray { display: none !important; }
      html, body {
        background: #111 !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
      }
    `;
    doc.head.appendChild(style);

    // Run the filter pass, then watch for DOM changes. xpra-html5
    // creates new <div class="window"> elements as the X11
    // server reports new windows, and updates .windowtitle text
    // when titles change — both are observable from the parent.
    this._applyFilter(doc);
    if (this._mutationObserver) {
      try { this._mutationObserver.disconnect(); } catch {}
    }
    this._mutationObserver = new MutationObserver(() => this._applyFilter(doc));
    this._mutationObserver.observe(doc.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    // Belt-and-braces: also poll for the first 5s in case
    // MutationObserver misses something during xpra's burst of
    // initial window creation.
    let polls = 0;
    const tick = () => {
      if (polls++ > 25 || !this.isConnected) return;
      this._applyFilter(doc);
      setTimeout(tick, 200);
    };
    setTimeout(tick, 200);
  }

  disconnectedCallback() {
    if (this._mutationObserver) {
      try { this._mutationObserver.disconnect(); } catch {}
      this._mutationObserver = null;
    }
    super.disconnectedCallback();
  }

  /**
   * Apply the visibility filter to every xpra window in the
   * iframe document. Pure DOM operations — no script injection,
   * no hooking xpra-html5 internals. Idempotent: re-running on
   * already-styled windows is a no-op (we set inline styles via
   * `setProperty` with !important).
   */
  _applyFilter(doc) {
    const needle = (this.pluginName || "").toLowerCase();
    if (!needle) return;
    // xpra-html5 tags every X11 window with class="window".
    // Tooltips / popup menus / override-redirect get class
    // "window" too, plus modifiers like "tooltip" or
    // "override-redirect". Picking just `.window` matches them
    // all — exactly what we want to filter.
    const wins = doc.querySelectorAll(".window");
    let matchedWin = null;
    let preStyleNatW = 0, preStyleNatH = 0;
    for (const winDiv of wins) {
      const titleEl = winDiv.querySelector(".windowtitle");
      const title = (titleEl?.textContent || "").trim();
      const isMatch = title && title.toLowerCase().includes(needle);
      if (isMatch) {
        matchedWin = winDiv;
        // Measure natural size BEFORE styling — _stylePluginWindow
        // stretches the div to 100vw/100vh which would mask the
        // X11 native dimensions in the bounding rect.
        const canvas = winDiv.querySelector("canvas");
        const bbox = winDiv.getBoundingClientRect?.();
        preStyleNatW = (canvas && canvas.width > 0 ? canvas.width : 0)
                    || (bbox && bbox.width > 0 ? Math.round(bbox.width) : 0);
        preStyleNatH = (canvas && canvas.height > 0 ? canvas.height : 0)
                    || (bbox && bbox.height > 0 ? Math.round(bbox.height) : 0);
        this._stylePluginWindow(winDiv);
      } else {
        // Hide everything else.
        winDiv.style.setProperty("display", "none", "important");
      }
    }
    // Once we've found the matched window, postMessage its
    // natural width/height up to the plugin panel so it can
    // resize + lock the foyer-window. We read from the
    // computed dimensions of the canvas (which is sized to the
    // X11 window) before our CSS stretches it.
    if (matchedWin && !this._sentNaturalSize) {
      if (preStyleNatW > 0 && preStyleNatH > 0) {
        this._sentNaturalSize = true;
        try {
          window.postMessage(
            {
              type: "foyer.plugin-gui.size",
              pluginName: this.pluginName,
              w: preStyleNatW,
              h: preStyleNatH,
            },
            window.location.origin,
          );
        } catch {}
      }
    }
  }

  /**
   * Style a matched `.window` div: hide the head bar (decorations)
   * and stretch the div + canvas to fill the iframe.
   */
  _stylePluginWindow(winDiv) {
    const d = winDiv;
    d.style.setProperty("display",   "block",  "important");
    d.style.setProperty("position",  "fixed",  "important");
    d.style.setProperty("top",       "0",      "important");
    d.style.setProperty("left",      "0",      "important");
    d.style.setProperty("width",     "100vw",  "important");
    d.style.setProperty("height",    "100vh",  "important");
    d.style.setProperty("margin",    "0",      "important");
    d.style.setProperty("padding",   "0",      "important");
    d.style.setProperty("border",    "0",      "important");
    d.style.setProperty("box-shadow", "none",  "important");
    d.style.setProperty("transform", "none",   "important");
    for (const child of d.children) {
      if (child.tagName === "CANVAS") {
        child.style.setProperty("position",  "absolute", "important");
        child.style.setProperty("top",       "0",        "important");
        child.style.setProperty("left",      "0",        "important");
        child.style.setProperty("width",     "100%",     "important");
        child.style.setProperty("height",    "100%",     "important");
        child.style.setProperty("max-width", "none",     "important");
        child.style.setProperty("max-height", "none",    "important");
      } else if (
        // The headerbar: id="head${wid}" class="windowhead".
        child.classList?.contains("windowhead") ||
        (child.id && child.id.startsWith("head"))
      ) {
        child.style.setProperty("display", "none", "important");
      } else if (child.classList?.contains("spinneroverlay")) {
        // xpra's "loading" spinner overlay — keep it visible
        // briefly while the plugin paints, but don't let it block
        // pointer events on the canvas.
        child.style.setProperty("pointer-events", "none", "important");
      }
    }
  }
}

customElements.define("foyer-plugin-native-ui-window", PluginNativeUiWindow);
