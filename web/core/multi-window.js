// SPDX-License-Identifier: Apache-2.0
// Multi-window orchestration.
//
// One Foyer logical user can hold multiple browser windows open
// against the same server — useful on a multi-monitor desktop where
// you want the mixer on one screen and the timeline on another. The
// server-side identity model (see `ConnectionRole` in
// `crates/foyer-schema/src/message.rs`) gives every WS connection a
// `connection_id` but every window of the same logical user shares a
// `peer_id`. This module is the client-side glue that:
//
//   · Spawns secondary windows via `window.open(/?parent=<peer_id>)`,
//     so the new window's WS handshake reuses the existing peer_id.
//
//   · Carries a `BroadcastChannel("foyer:<peer_id>")` between
//     siblings for sub-millisecond direct comms (handoff payloads,
//     focus signals, live layout reflows). The server-side bus is
//     reserved for things that need to be persisted or fan out to
//     OTHER peers; sibling-only chatter rides BroadcastChannel.
//
//   · Persists "currently active peer id" in localStorage so a brand-
//     new tab can opportunistically discover the family even when
//     opened by hand (not via `window.open`). Cold-boot fallback
//     for window-restore.
//
//   · Tracks sibling presence — emits `sibling-hello` / `sibling-bye`
//     events so the UI can show "2 windows open" or repaint when a
//     pane handoff arrives.
//
// Audio I/O lives only on the Primary window (the server rejects
// `AudioIngressOpen`/`AudioEgressStart` from Secondaries — see
// `dispatch_command` in `crates/foyer-server/src/ws.rs`). Listeners
// on `multiWindow.role === "primary"` should gate any audio control
// affordance accordingly.

const ACTIVE_PEER_KEY = "foyer:active-peer-id";
const ACTIVE_PEER_AT_KEY = "foyer:active-peer-at";
// localStorage hint older than this is stale — its writer is likely
// gone. Cold-boot child windows ignore it. 5 minutes is generous
// enough that a temporary stall (DevTools breakpoint, OS sleep)
// doesn't kill the family, but short enough that a closed-tab
// remnant doesn't keep advertising forever.
const HINT_TTL_MS = 5 * 60 * 1000;

export class MultiWindow extends EventTarget {
  constructor() {
    super();
    /** @type {import("./store.js").Store | null} */
    this._store = null;
    this._channel = null;
    /** @type {string | null} */
    this._peerId = null;
    /** @type {string | null} */
    this._connectionId = null;
    /** "primary" | "secondary" */
    this._role = "primary";
    /** Sibling connection ids we've heard from (excludes our own). */
    this._siblings = new Map(); // connection_id → { role, lastSeen }
    /** Hooks registered to forward pane-handoff payloads. */
    this._handoffHandlers = new Set();
  }

  /** Attach the multi-window controller to the store. Idempotent. */
  attach(store) {
    if (this._store) return;
    this._store = store;
    // Slot id is canonicalized in window-restore — it reads the URL
    // `?slot=` param + writes back to `globalThis.__foyer.windowSlotId`.
    // Multi-window peeks at the URL directly here so we have a value
    // before window-restore.attach runs (bootstrap calls
    // `multiWindow.attach` first), then re-syncs once window-restore
    // exposes its canonical value.
    this._slotId = readSlotFromUrl() || "0";
    store.addEventListener("connection", () => this._onConnection());
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => this._teardown());
    }
  }

  /** Current connection identity, mirrored from `store.state.connection`. */
  get peerId() { return this._peerId; }
  get connectionId() { return this._connectionId; }
  get role() { return this._role; }
  get isPrimary() { return this._role === "primary"; }
  get isSecondary() { return this._role === "secondary"; }
  /** Snapshot of known siblings (excludes self). */
  get siblings() {
    return Array.from(this._siblings.entries()).map(([id, meta]) => ({
      connectionId: id,
      role: meta.role,
      slot: meta.slot,
      lastSeen: meta.lastSeen,
    }));
  }

  /** Stable user-facing window number for *this* window. Slot 0 (the
   *  Primary) is window 1; numeric slots become slot+1. Non-numeric
   *  slot ids (fallback when window-restore isn't attached) bucket
   *  to a `•` so the user gets *some* identifier even if it isn't
   *  ordered. Sibling rows go through `siblingWindowNumber` for the
   *  same mapping. */
  get windowNumber() {
    return slotToWindowNumber(this._slotId);
  }

  /** Map a sibling's slot id to its user-facing window number. */
  siblingWindowNumber(slot) {
    return slotToWindowNumber(slot);
  }

  /**
   * Open a secondary window. Returns the WindowProxy or null if the
   * popup was blocked / we're not the Primary (only Primaries can
   * spawn — secondaries proxy through their Primary via
   * BroadcastChannel to keep ownership flat).
   *
   * @param {object} [opts]
   * @param {string} [opts.path="/"]   path to open ("/" reuses the SPA)
   * @param {number} [opts.width=1200]
   * @param {number} [opts.height=800]
   * @param {number} [opts.left]
   * @param {number} [opts.top]
   * @param {string} [opts.name]       window.open's `windowFeatures` name
   */
  async openSecondary(opts = {}) {
    if (typeof window === "undefined") return null;
    if (!this._peerId) {
      console.warn("[multi-window] no peer id yet — call after store 'connection' event");
      return null;
    }
    if (this.isSecondary) {
      // A chain of secondaries would mean Primary closing tears down
      // the whole tree. Bounce the request to the Primary so it owns
      // the spawn; if no Primary is listening, return null and let
      // the caller decide.
      this.broadcast({
        kind: "request-open-secondary",
        path: opts.path || "/",
        width: opts.width,
        height: opts.height,
        left: opts.left,
        top: opts.top,
        from: this._connectionId,
      });
      return null;
    }
    // Mint a slot id so window-restore can scope the new window's
    // state. Falls back to a random tag if window-restore isn't
    // attached for some reason — that's still distinct from "0".
    let slotId = opts.slot;
    if (!slotId) {
      const wr = globalThis.__foyer?.windowRestore;
      if (wr && typeof wr.nextSlotId === "function") {
        try { slotId = await wr.nextSlotId(); } catch {}
      }
      if (!slotId) slotId = `t${Math.random().toString(36).slice(2, 8)}`;
    }
    const url = new URL(opts.path || "/", window.location.href);
    url.searchParams.set("parent", this._peerId);
    url.searchParams.set("slot", slotId);
    // Carry the existing token through so a tunnel guest's child
    // window authenticates with the same role.
    const pageToken = new URLSearchParams(window.location.search).get("token");
    if (pageToken) url.searchParams.set("token", pageToken);
    const feat = [
      "popup=yes",
      `width=${Math.round(opts.width ?? 1200)}`,
      `height=${Math.round(opts.height ?? 800)}`,
      opts.left != null ? `left=${Math.round(opts.left)}` : null,
      opts.top != null ? `top=${Math.round(opts.top)}` : null,
    ]
      .filter(Boolean)
      .join(",");
    const w = window.open(url.toString(), opts.name || `foyer-slot-${slotId}`, feat);
    if (!w) {
      // Popup blocker. Tabs are a fine fallback; the user can drag
      // the tab out to its own window manually.
      return window.open(url.toString(), "_blank");
    }
    return w;
  }

  /** Send a typed message to every other sibling window. */
  broadcast(msg) {
    if (!this._channel) return false;
    try {
      this._channel.postMessage({
        ...msg,
        senderConnectionId: this._connectionId,
        senderRole: this._role,
        senderSlot: this._slotId,
        ts: Date.now(),
      });
      return true;
    } catch (err) {
      console.warn("[multi-window] broadcast failed", err);
      return false;
    }
  }

  /**
   * Subscribe to pane-handoff payloads from sibling windows. The
   * payload shape is owned by the caller (timeline / mixer / float
   * layer) — this module is just a transport.
   *
   * @param {(detail: unknown) => void} fn
   * @returns {() => void} unsubscribe
   */
  onHandoff(fn) {
    this._handoffHandlers.add(fn);
    return () => this._handoffHandlers.delete(fn);
  }

  /**
   * Dispatch a pane-handoff payload to ONE specific sibling (or
   * everyone when `targetConnectionId` is omitted). The receiving
   * side picks it up via `onHandoff`.
   */
  sendHandoff(payload, targetConnectionId = null) {
    return this.broadcast({
      kind: "pane-handoff",
      target: targetConnectionId,
      payload,
    });
  }

  // ─── internals ─────────────────────────────────────────────────────

  _onConnection() {
    if (!this._store) return;
    const conn = this._store.state.connection || {};
    const peerChanged = conn.peerId !== this._peerId;
    this._peerId = conn.peerId || null;
    this._connectionId = conn.connectionId || null;
    this._role = conn.role === "secondary" ? "secondary" : "primary";

    if (peerChanged) {
      if (this._channel) {
        try { this._channel.close(); } catch {}
        this._channel = null;
      }
      this._siblings.clear();
      if (
        this._peerId &&
        typeof BroadcastChannel === "function"
      ) {
        this._channel = new BroadcastChannel(`foyer:${this._peerId}`);
        this._channel.addEventListener("message", (ev) =>
          this._onChannelMessage(ev),
        );
        // Greet sibling tabs. They'll greet back, populating the
        // sibling map both directions.
        this.broadcast({ kind: "hello" });
      }
    }

    // Persist a discovery hint so a child window opened by hand (not
    // via window.open) can find its parent on cold boot. We only
    // write when we're the Primary — secondary connections share the
    // same id but the Primary is the canonical "I'm still here"
    // beacon. Refreshed periodically below via the hello loop.
    if (typeof localStorage !== "undefined" && this._peerId && this.isPrimary) {
      try {
        localStorage.setItem(ACTIVE_PEER_KEY, this._peerId);
        localStorage.setItem(ACTIVE_PEER_AT_KEY, String(Date.now()));
      } catch {}
    }

    this.dispatchEvent(new CustomEvent("ready", { detail: { ...conn } }));
  }

  _onChannelMessage(ev) {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.senderConnectionId === this._connectionId) return; // ignore self echoes

    switch (msg.kind) {
      case "hello": {
        // First time we hear from a sibling, greet back so they see
        // us too. Avoid an echo storm by suppressing replies to a
        // reply: `from-hello: true` flags this round.
        if (!this._siblings.has(msg.senderConnectionId)) {
          this._siblings.set(msg.senderConnectionId, {
            role: msg.senderRole,
            slot: msg.senderSlot,
            lastSeen: msg.ts,
          });
          this.dispatchEvent(new CustomEvent("sibling-hello", {
            detail: {
              connectionId: msg.senderConnectionId,
              role: msg.senderRole,
              slot: msg.senderSlot,
            },
          }));
          if (!msg.fromHello) {
            this.broadcast({ kind: "hello", fromHello: true });
          }
        } else {
          // Refresh lastSeen + keep slot in sync (rare but possible
          // if the peer slot was assigned after the first hello).
          const entry = this._siblings.get(msg.senderConnectionId);
          entry.lastSeen = msg.ts;
          if (msg.senderSlot && !entry.slot) entry.slot = msg.senderSlot;
        }
        break;
      }
      case "bye": {
        if (this._siblings.delete(msg.senderConnectionId)) {
          this.dispatchEvent(new CustomEvent("sibling-bye", {
            detail: { connectionId: msg.senderConnectionId },
          }));
        }
        break;
      }
      case "pane-handoff": {
        if (msg.target && msg.target !== this._connectionId) return;
        for (const fn of this._handoffHandlers) {
          try { fn(msg.payload); } catch (err) { console.error(err); }
        }
        this.dispatchEvent(new CustomEvent("pane-handoff", { detail: msg.payload }));
        break;
      }
      case "request-open-secondary": {
        // Only the Primary acts on these. Secondaries ignore.
        if (this.isPrimary) {
          this.openSecondary({
            path: msg.path,
            width: msg.width,
            height: msg.height,
            left: msg.left,
            top: msg.top,
          });
        }
        break;
      }
      default:
        // Pass-through for ad-hoc messages from features that want
        // to ride the same channel.
        this.dispatchEvent(new CustomEvent("message", { detail: msg }));
        break;
    }
  }

  _teardown() {
    if (this._channel) {
      try { this.broadcast({ kind: "bye" }); } catch {}
      try { this._channel.close(); } catch {}
      this._channel = null;
    }
    // If we were the Primary and we're leaving, clear our beacon —
    // otherwise a cold-boot child window finds a stale peer id and
    // its parent-reuse on the server fails (peer gone) and falls back
    // to Primary cleanly. Either way works; clearing is just tidier.
    if (
      typeof localStorage !== "undefined" &&
      this.isPrimary &&
      this._peerId
    ) {
      try {
        const stored = localStorage.getItem(ACTIVE_PEER_KEY);
        if (stored === this._peerId) {
          localStorage.removeItem(ACTIVE_PEER_KEY);
          localStorage.removeItem(ACTIVE_PEER_AT_KEY);
        }
      } catch {}
    }
  }
}

/**
 * Best-effort lookup of the localStorage discovery hint. Returns the
 * stored peer id when it was written less than `HINT_TTL_MS` ago.
 * Used by features that want to opportunistically pass `?parent=`
 * even when the user opened the URL by hand.
 */
export function readActivePeerHint() {
  if (typeof localStorage === "undefined") return null;
  try {
    const id = localStorage.getItem(ACTIVE_PEER_KEY);
    const at = Number(localStorage.getItem(ACTIVE_PEER_AT_KEY) || "0");
    if (!id) return null;
    if (!at || Date.now() - at > HINT_TTL_MS) return null;
    return id;
  } catch {
    return null;
  }
}

function readSlotFromUrl() {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("slot") || null;
  } catch { return null; }
}

function slotToWindowNumber(slot) {
  if (slot === "0" || slot === 0 || slot == null) return 1;
  const n = Number(slot);
  if (Number.isFinite(n) && n >= 0) return Math.round(n) + 1;
  return null;
}

export const multiWindow = new MultiWindow();
