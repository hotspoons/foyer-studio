// SPDX-License-Identifier: Apache-2.0
// Window position + topology persistence.
//
// Saves, per *display fingerprint* (so a laptop docked to two
// monitors at the office gets a different layout than the same
// laptop solo on a plane):
//
//   · this window's size + screen-coords
//   · for the Primary window: a list of child slot specs
//     `[{ slot, width, height, left, top }]` describing every
//     Secondary that was open when we last shut down
//
// On boot, the Primary reads the saved children and `window.open()`s
// them at their last coords with a `?parent=<my-peer-id>&slot=N`
// URL — the new windows pick that up in `multi-window.js` and
// reconstitute as Secondaries of the same logical peer.
//
// Layout tree state per-window rides the existing `layout-store`
// localStorage scheme; this module adds a per-slot suffix so window 0
// (Primary) and window 1 (one of the Secondaries) keep separate tile
// compositions even though they share a peer_id and session id.
//
// Window Management API
// ---------------------
// `window.getScreenDetails()` (Chrome only, requires `window-
// management` permission) returns the full monitor topology. We use
// it for a high-resolution fingerprint when available and fall back
// to `screen.width/height` on Firefox / Safari / permission-denied.
//
// Caveats
// -------
// `window.open(url, name, "left=X,top=Y,width=W,height=H")` is
// best-effort: Chrome/Firefox sometimes clamp or ignore positioning
// for popup-blocker reasons (especially the first open of a new
// origin in a new monitor). We accept that and let the user nudge
// once — subsequent saves will pick up the corrected position. The
// `?slot=` URL param is the source of truth for identity, not
// position.

const STORAGE_KEY_PREFIX = "foyer:window-layout:";
const SLOT_QS = "slot";
const SAVE_DEBOUNCE_MS = 500;

export class WindowRestore extends EventTarget {
  constructor() {
    super();
    this._store = null;
    this._multiWindow = null;
    this._fingerprint = null;
    this._slotId = null; // "0" for primary, "1", "2", ... for secondaries
    this._saveTimer = null;
    this._attached = false;
  }

  /**
   * @param {object} opts
   * @param {import("./store.js").Store} opts.store
   * @param {import("./multi-window.js").MultiWindow} opts.multiWindow
   */
  attach({ store, multiWindow }) {
    if (this._attached) return;
    this._attached = true;
    this._store = store;
    this._multiWindow = multiWindow;
    if (typeof window === "undefined") return;

    // Read the slot id from URL — Primary opens children with
    // `?slot=N`. Primary itself has no slot param → "0".
    const params = new URLSearchParams(window.location.search);
    this._slotId = params.get(SLOT_QS) || "0";
    if (typeof globalThis !== "undefined") {
      globalThis.__foyer = Object.assign(globalThis.__foyer || {}, {
        windowSlotId: this._slotId,
      });
    }

    // Persistence triggers — debounced so a resize drag doesn't write
    // every animation frame.
    const queueSave = () => this._queueSave();
    window.addEventListener("resize", queueSave);
    // The Window Management API exposes `screenschange`; we listen
    // for it indirectly via `getScreenDetails` if it resolves.
    try {
      // Some browsers fire `move` via the page-lifecycle module; not
      // standard. Skip — we rely on save-on-unload for position.
    } catch {}
    // On close, save our position so a refresh brings us back at the
    // right spot. Secondaries also forget themselves so that a
    // deliberate close doesn't auto-respawn next session — refresh
    // re-adds the entry because the URL still carries `?slot=N`,
    // but a real "close window" doesn't. The Primary always saves
    // itself (it's the anchor of the family).
    window.addEventListener("beforeunload", () => {
      if (this._multiWindow?.isSecondary) {
        // Forget-on-close keeps the saved list trimmed to "windows
        // the user actually wants restored." Best-effort — if the
        // forget fails the next-boot prune below catches it.
        this.forgetSlot(this._slotId).catch(() => {});
      } else {
        this._saveNow();
      }
    });

    // Restore children once the connection has come up (we need our
    // own peer_id to mint the children's `?parent=` URLs). For
    // secondaries, we only restore THIS window's own size on first
    // paint — children belong to the primary.
    store.addEventListener("connection", () => this._onConnection());
  }

  /** Stable storage key for the current display fingerprint. */
  async _ensureFingerprint() {
    if (this._fingerprint) return this._fingerprint;
    this._fingerprint = await displayFingerprint();
    return this._fingerprint;
  }

  /** This window's slot id ("0" for primary, "1"+ for secondaries). */
  get slotId() {
    return this._slotId;
  }

  /** Per-slot key for layout-store etc. to namespace their state. */
  slotKey(base) {
    if (this._slotId === "0") return base;
    return `${base}#slot=${this._slotId}`;
  }

  // ─── boot path ─────────────────────────────────────────────────────

  async _onConnection() {
    if (!this._multiWindow) return;
    if (!this._multiWindow.peerId) return;
    if (!this._multiWindow.isPrimary) {
      // Apply this window's saved position once we know our slot.
      this._applyOwnPosition();
      return;
    }
    this._applyOwnPosition();
    await this._restoreChildren();
    // After children have had a chance to spawn + announce themselves
    // over BroadcastChannel, drop any saved slot that isn't actually
    // alive. Catches dev-time crud, sessions where a child was force-
    // closed before its forget-on-close handler ran, and stale entries
    // from before forget-on-close shipped. 1500 ms is generous; live
    // hellos typically settle in ~200 ms but a popup-blocker prompt
    // can push it out.
    setTimeout(() => this._pruneDeadSlots().catch(() => {}), 1500);
  }

  async _pruneDeadSlots() {
    if (!this._multiWindow?.isPrimary) return;
    const fp = await this._ensureFingerprint();
    const saved = readSaved(fp);
    if (!saved || !Array.isArray(saved.slots)) return;
    const alive = new Set([String(this._slotId || "0")]);
    for (const sib of this._multiWindow.siblings || []) {
      if (sib?.slot != null) alive.add(String(sib.slot));
    }
    const before = saved.slots.length;
    const next = saved.slots.filter((s) => alive.has(String(s?.slot)));
    if (next.length !== before) {
      writeSaved(fp, { slots: next });
    }
  }

  async _applyOwnPosition() {
    if (typeof window === "undefined") return;
    const slot = await this._readSlot(this._slotId);
    if (!slot) return;
    // We can't move/resize a window opened by the user (the browser
    // forbids it on the top-level frame outside `window.open`). For
    // child windows, `window.opener` did the placement when calling
    // `window.open(..., "left=...")`. Nothing else to do — emit an
    // event in case a UI overlay wants to react.
    this.dispatchEvent(new CustomEvent("own-position-known", { detail: slot }));
  }

  async _restoreChildren() {
    if (typeof window === "undefined" || !this._multiWindow) return;
    const fp = await this._ensureFingerprint();
    const saved = readSaved(fp);
    if (!saved || !Array.isArray(saved.slots)) return;
    for (const slot of saved.slots) {
      if (!slot || slot.slot === "0") continue; // primary is us
      // Open the child. URL has `parent` + `slot` so the new tab
      // re-attaches as a Secondary and reads its slot back out of
      // its own URL.
      const url = new URL(window.location.pathname, window.location.href);
      url.searchParams.set("parent", this._multiWindow.peerId);
      url.searchParams.set(SLOT_QS, String(slot.slot));
      const pageToken = new URLSearchParams(window.location.search).get("token");
      if (pageToken) url.searchParams.set("token", pageToken);
      const feat = [
        "popup=yes",
        slot.width  ? `width=${Math.round(slot.width)}`   : null,
        slot.height ? `height=${Math.round(slot.height)}` : null,
        slot.left   != null ? `left=${Math.round(slot.left)}` : null,
        slot.top    != null ? `top=${Math.round(slot.top)}`   : null,
      ]
        .filter(Boolean)
        .join(",");
      try {
        window.open(url.toString(), `foyer-slot-${slot.slot}`, feat);
      } catch (err) {
        console.warn("[window-restore] popup blocked on restore", err);
      }
    }
  }

  // ─── persistence ───────────────────────────────────────────────────

  _queueSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  }

  async _saveNow() {
    if (typeof window === "undefined") return;
    const fp = await this._ensureFingerprint();
    const existing = readSaved(fp) || { slots: [] };
    const slots = Array.isArray(existing.slots) ? existing.slots.slice() : [];
    const idx = slots.findIndex((s) => String(s?.slot) === String(this._slotId));
    const mine = {
      slot: this._slotId,
      role: this._multiWindow?.role || "primary",
      width: window.outerWidth || window.innerWidth,
      height: window.outerHeight || window.innerHeight,
      left: window.screenX,
      top: window.screenY,
      lastSavedAt: Date.now(),
    };
    if (idx >= 0) slots[idx] = mine;
    else slots.push(mine);
    writeSaved(fp, { slots });
  }

  async _readSlot(slotId) {
    const fp = await this._ensureFingerprint();
    const saved = readSaved(fp);
    if (!saved || !Array.isArray(saved.slots)) return null;
    return saved.slots.find((s) => String(s?.slot) === String(slotId)) || null;
  }

  /** Lowest-free slot id, based ONLY on currently-alive windows in
   *  the family (this window + its live siblings via BroadcastChannel).
   *  We deliberately ignore the persisted slot list here — stale rows
   *  from previous sessions or crashed tabs would otherwise push new
   *  windows into double-digit slot numbers ("Window 7" with no
   *  siblings 2-6). Restore-from-disk reads the persisted list
   *  separately (`_restoreChildren`) and uses its own slot ids. */
  async nextSlotId() {
    const used = new Set([String(this._slotId || "0")]);
    const siblings = this._multiWindow?.siblings || [];
    for (const sib of siblings) {
      if (sib?.slot != null) used.add(String(sib.slot));
    }
    let n = 1;
    while (used.has(String(n))) n += 1;
    return String(n);
  }

  /**
   * Remove a saved slot from the current fingerprint. Called when the
   * Primary explicitly closes one of its windows (vs. a refresh,
   * which we want to leave in place so refresh restores it).
   */
  async forgetSlot(slotId) {
    const fp = await this._ensureFingerprint();
    const saved = readSaved(fp);
    if (!saved || !Array.isArray(saved.slots)) return;
    const next = saved.slots.filter((s) => String(s?.slot) !== String(slotId));
    writeSaved(fp, { slots: next });
  }

  /**
   * Drop every saved window for the current display fingerprint.
   * User-triggered reset for the "I'm seeing Window 7 with no
   * siblings 2-6" failure mode — happens when localStorage retains
   * slot entries from dev sessions / forced closes that
   * `_pruneDeadSlots` didn't catch. The Primary stays in place; only
   * the saved restore list is wiped.
   */
  async forgetAllWindows() {
    if (typeof localStorage === "undefined") return;
    const fp = await this._ensureFingerprint();
    try { localStorage.removeItem(STORAGE_KEY_PREFIX + fp); } catch {}
  }
}

// ─── module-private helpers ───────────────────────────────────────────

async function displayFingerprint() {
  if (typeof window === "undefined") return "no-window";
  let sig = `${screen.width}x${screen.height}`;
  if (typeof window.getScreenDetails === "function") {
    try {
      const details = await window.getScreenDetails();
      sig = (details.screens || [])
        .map((s) => `${s.width}x${s.height}@${s.left},${s.top}${s.isPrimary ? "P" : ""}`)
        .sort()
        .join("|");
    } catch { /* permission denied or unsupported — keep fallback */ }
  }
  return await sha1Short(sig);
}

async function sha1Short(s) {
  try {
    const buf = new TextEncoder().encode(s);
    const hash = await crypto.subtle.digest("SHA-1", buf);
    return Array.from(new Uint8Array(hash))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return s.length.toString(16);
  }
}

function readSaved(fp) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + fp);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSaved(fp, value) {
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + fp, JSON.stringify(value));
  } catch (err) {
    console.warn("[window-restore] persist failed", err);
  }
}

export const windowRestore = new WindowRestore();
