// Reactive session store.
//
// Receives Envelope<Event> from the ws client, reduces into a flat state shape,
// and dispatches "change" events on itself so Lit reactive controllers can
// subscribe. Per the plan, state management is deliberately a thin EventTarget
// layer — not a library.
//
// State shape:
//   {
//     status: "idle" | "open" | "closed" | "error",
//     session: Session | null,          // latest snapshot
//     controls: Map<id, value>,         // live per-control values (includes meters)
//     selfOrigin: string,               // our own origin tag for self-echo detection
//   }

export class Store extends EventTarget {
  constructor({ selfOrigin = "web" } = {}) {
    super();
    this.state = {
      status: "idle",
      session: null,
      controls: new Map(),
      selfOrigin,
      // Rolling map of peer origin → last-seen timestamp (ms since epoch).
      peers: new Map(),
      // Track selection — shared across mixer + timeline. Operations
      // like fade/delete/mute-range use this set to scope their effect.
      selectedTrackIds: new Set(),
      // Anchor used when shift-click extends a range selection. Null
      // means no anchor (first click sets it).
      _selectAnchor: null,
      // ── multi-session ────────────────────────────────────────────
      // List of every currently-open session the sidecar knows about.
      // Populated from `SessionList` + per-op `SessionOpened` /
      // `SessionClosed` events. The switcher chip + welcome screen
      // both render from this.
      sessions: [],
      // Which session this browser tab is currently "looking at".
      // Tracks the sidecar's notion of focus for outbound commands.
      // `null` means no session is currently viewed (welcome state).
      currentSessionId: null,
      // Orphans detected at sidecar startup — running shims we can
      // reattach to, or crashed shims the user can dismiss / reopen.
      // One-shot list (cleared as the user resolves each).
      orphans: [],
    };
    this._peerPruneInterval = null;
    if (typeof window !== "undefined") {
      this._peerPruneInterval = setInterval(() => this._prunePeers(), 3000);
    }
  }

  // ── track selection ────────────────────────────────────────────────
  /**
   * Update the set of selected track ids.
   *   mode:
   *     "replace" — this track only (default on plain click)
   *     "toggle"  — flip membership (Ctrl/Cmd-click)
   *     "extend"  — range from anchor to this track (Shift-click)
   */
  selectTrack(id, mode = "replace") {
    if (!id) return;
    const tracks = this.state.session?.tracks || [];
    const cur = this.state.selectedTrackIds;
    if (mode === "toggle") {
      if (cur.has(id)) cur.delete(id);
      else { cur.add(id); this.state._selectAnchor = id; }
    } else if (mode === "extend") {
      const anchor = this.state._selectAnchor || (cur.size ? Array.from(cur).pop() : id);
      const ids = tracks.map((t) => t.id);
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        cur.clear();
        for (let i = lo; i <= hi; i++) cur.add(ids[i]);
      } else {
        cur.clear();
        cur.add(id);
      }
    } else {
      cur.clear();
      cur.add(id);
      this.state._selectAnchor = id;
    }
    this.dispatchEvent(new CustomEvent("selection"));
  }

  clearTrackSelection() {
    if (this.state.selectedTrackIds.size === 0) return;
    this.state.selectedTrackIds.clear();
    this.state._selectAnchor = null;
    this.dispatchEvent(new CustomEvent("selection"));
  }

  isTrackSelected(id) {
    return this.state.selectedTrackIds.has(id);
  }

  /** Peers we've observed messages from in the last 10s (excludes self). */
  activePeers(windowMs = 10_000) {
    const now = Date.now();
    const out = [];
    for (const [origin, ts] of this.state.peers) {
      if (origin && origin !== this.state.selfOrigin && now - ts < windowMs) {
        out.push({ origin, lastSeen: ts });
      }
    }
    return out;
  }

  _prunePeers() {
    const now = Date.now();
    let pruned = false;
    for (const [origin, ts] of this.state.peers) {
      if (now - ts > 30_000) {
        this.state.peers.delete(origin);
        pruned = true;
      }
    }
    if (pruned) this.dispatchEvent(new CustomEvent("peers"));
  }

  /** Current value for a control ID, or undefined if unknown. */
  get(id) {
    return this.state.controls.get(id);
  }

  // ── multi-session helpers ───────────────────────────────────────
  /** Resolve the SessionInfo for the session this tab is currently
   *  viewing, or `null` if none. */
  currentSession() {
    const id = this.state.currentSessionId;
    if (!id) return null;
    return this.state.sessions.find((s) => s.id === id) || null;
  }
  /** Switch which session the UI focuses on. Doesn't touch the
   *  sidecar's live backend — that's a SelectSession on the WS. */
  setCurrentSession(id) {
    if (this.state.currentSessionId === id) return;
    this.state.currentSessionId = id;
    // Dropped the snapshot so views re-render their loading state
    // while the next SessionSnapshot arrives from the selected
    // session's pump.
    this.state.session = null;
    this.dispatchEvent(new CustomEvent("sessions"));
    this._emit();
    if (this._ws) {
      try { this._ws.send({ type: "select_session", session_id: id }); } catch {}
      try { this._ws.requestSnapshot?.(); } catch {}
    }
  }
  /** Drop an orphan from local state after the user dismissed /
   *  reattached it. The sidecar broadcasts its own updated list on
   *  action but keeping the optimistic removal makes the UI feel
   *  instant. */
  forgetOrphan(id) {
    const before = this.state.orphans.length;
    this.state.orphans = this.state.orphans.filter((o) => o.id !== id);
    if (this.state.orphans.length !== before) {
      this.dispatchEvent(new CustomEvent("orphans"));
      this._emit();
    }
  }

  /**
   * Wire the store to a FoyerWs instance. Returns a detach function.
   */
  attach(ws) {
    // Hold a ref so event handlers (see `session_patch` case in
    // `_onEnvelope`) can send commands back on the WS — specifically
    // to re-request a snapshot when the shim tells us state has
    // reloaded.
    this._ws = ws;
    const onStatus = (ev) => {
      this.state.status = ev.detail;
      this._emit();
    };
    const onEnvelope = (ev) => this._onEnvelope(ev.detail);
    ws.addEventListener("status", onStatus);
    ws.addEventListener("envelope", onEnvelope);
    return () => {
      ws.removeEventListener("status", onStatus);
      ws.removeEventListener("envelope", onEnvelope);
      if (this._ws === ws) this._ws = null;
    };
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body || typeof body.type !== "string") return;
    // Presence bookkeeping.
    const origin = env?.origin;
    if (origin && origin !== this.state.selfOrigin) {
      const prev = this.state.peers.get(origin);
      this.state.peers.set(origin, Date.now());
      if (!prev) this.dispatchEvent(new CustomEvent("peers"));
    }
    switch (body.type) {
      case "session_snapshot": {
        this.state.session = body.session;
        // Seed the controls map with all known parameter values.
        const c = new Map();
        const walk = (p) => {
          if (!p || typeof p !== "object") return;
          if (typeof p.id === "string" && "value" in p) c.set(p.id, p.value);
        };
        const s = body.session || {};
        const t = s.transport || {};
        for (const k of [
          "playing", "recording", "looping",
          "tempo", "time_signature_num", "time_signature_den", "position_beats",
        ]) walk(t[k]);
        for (const tr of s.tracks || []) {
          walk(tr.gain);
          walk(tr.pan);
          walk(tr.mute);
          walk(tr.solo);
          walk(tr.record_arm);
          for (const pi of tr.plugins || []) {
            for (const p of pi.params || []) walk(p);
          }
        }
        this.state.controls = c;
        this._emit();
        break;
      }
      case "control_update": {
        if (body.update?.id) {
          if (this._applyControl(body.update.id, body.update.value)) {
            this._emitControl(body.update.id);
          }
        }
        break;
      }
      case "meter_batch": {
        for (const u of body.values || []) {
          if (this._applyControl(u.id, u.value)) {
            this._emitControl(u.id);
          }
        }
        break;
      }
      case "session_patch": {
        // Coarse handling: request a fresh snapshot from the sidecar.
        // The details of per-op patching land in later polish — for now
        // any `session_patch` with any payload triggers a full reload.
        //
        // The shim emits `{op: "reload"}` after `on_session_loaded`
        // finishes populating its route cache, which is how the first
        // non-empty snapshot reaches a browser that connected before
        // routes were actually in Ardour's session. Without sending
        // request_snapshot here, the browser stays on whatever empty
        // snapshot arrived at subscribe-time — mixer renders "Waiting
        // for session…" forever.
        //
        // The CustomEvent is kept for any other listener that wants
        // to react to reloads without duplicating the request.
        if (this._ws && typeof this._ws.requestSnapshot === "function") {
          this._ws.requestSnapshot();
        }
        this.dispatchEvent(new CustomEvent("reload-requested"));
        break;
      }
      case "track_updated": {
        // Splice the updated track in place and re-emit so views with a
        // reactive controller on `change` repaint.
        const s = this.state.session;
        const updated = body.track;
        if (s && updated && Array.isArray(s.tracks)) {
          const i = s.tracks.findIndex((t) => t.id === updated.id);
          if (i >= 0) s.tracks[i] = updated;
        }
        this._emit();
        break;
      }
      case "session_dirty_changed": {
        if (this.state.session) {
          this.state.session.dirty = !!body.dirty;
        }
        // Also mirror the flag onto the matching SessionInfo in the
        // sessions array so the switcher chip's "•" indicator
        // repaints without waiting for the next SessionList.
        const sid = env.session_id;
        if (sid) {
          const info = this.state.sessions.find((s) => s.id === sid);
          if (info) info.dirty = !!body.dirty;
        }
        this._emit();
        break;
      }
      // ── multi-session lifecycle ──────────────────────────────
      case "session_list": {
        this.state.sessions = Array.isArray(body.sessions) ? body.sessions : [];
        // If the currently-viewed session is gone (closed remotely,
        // crashed, etc), fall through to the next available one.
        if (this.state.currentSessionId
            && !this.state.sessions.some((s) => s.id === this.state.currentSessionId)) {
          this.state.currentSessionId =
            this.state.sessions[this.state.sessions.length - 1]?.id || null;
        } else if (!this.state.currentSessionId && this.state.sessions.length > 0) {
          // Auto-focus the first (or most recently opened) session.
          this.state.currentSessionId =
            this.state.sessions[this.state.sessions.length - 1]?.id || null;
        }
        this.dispatchEvent(new CustomEvent("sessions"));
        this._emit();
        break;
      }
      case "session_opened": {
        const info = body.session;
        if (info && info.id) {
          const idx = this.state.sessions.findIndex((s) => s.id === info.id);
          if (idx >= 0) this.state.sessions[idx] = info;
          else this.state.sessions.push(info);
          // Auto-switch the browser to the freshly-opened session —
          // matches user intent for "I just clicked Open Project"
          // and keeps the background-leave case handled explicitly
          // via the switcher (which sets currentSessionId without
          // triggering a new Open).
          this.state.currentSessionId = info.id;
          // Lazily touch the browser-local recents list so the next
          // welcome screen visit sees this path at the top. Import
          // inline to avoid a hard dependency cycle at module load.
          if (info.path) {
            import("./recents.js").then((m) => {
              m.touch({
                path: info.path,
                name: info.name,
                backend_id: info.backend_id,
              });
            }).catch(() => {});
          }
          this.dispatchEvent(new CustomEvent("sessions"));
          this._emit();
        }
        break;
      }
      case "session_closed": {
        const id = body.session_id;
        this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
        if (this.state.currentSessionId === id) {
          this.state.currentSessionId =
            this.state.sessions[this.state.sessions.length - 1]?.id || null;
          // Drop the stale snapshot so the UI repaints to welcome
          // (or the next session's snapshot once it arrives).
          if (!this.state.currentSessionId) this.state.session = null;
        }
        this.dispatchEvent(new CustomEvent("sessions"));
        this._emit();
        break;
      }
      case "orphans_detected": {
        this.state.orphans = Array.isArray(body.orphans) ? body.orphans : [];
        this.dispatchEvent(new CustomEvent("orphans"));
        this._emit();
        break;
      }
      default:
        // unknown / not-yet-handled event types pass silently
        break;
    }
  }

  _emit() {
    this.dispatchEvent(new CustomEvent("change"));
  }
  _emitControl(id) {
    this.dispatchEvent(new CustomEvent("control", { detail: id }));
  }

  /**
   * Apply an incoming control value, honoring any active front-end lock.
   * Returns `true` if the store actually changed and listeners should be
   * notified. Right now only `transport.position` has a lock (installed
   * by `transport-return.js`); the pattern is generic enough to reuse.
   */
  _applyControl(id, value) {
    if (id === "transport.position") {
      const pinned =
        typeof this.transportPositionLock === "function"
          ? this.transportPositionLock()
          : null;
      if (pinned != null) {
        // Lock active — force the pinned target regardless of what
        // the backend thinks. We still emit so UI listeners redraw
        // to the pinned value (useful when the user just seeked).
        this.state.controls.set(id, pinned);
        return true;
      }
    }
    this.state.controls.set(id, value);
    return true;
  }
}

/**
 * Lit reactive controller that subscribes a host component to a single control
 * id. `host.requestUpdate()` fires on every update.
 */
export class ControlController {
  constructor(host, store, id) {
    this.host = host;
    this.store = store;
    this.id = id;
    host.addController(this);
  }
  hostConnected() {
    this._handler = (ev) => {
      if (ev.detail === this.id) this.host.requestUpdate();
    };
    this.store.addEventListener("control", this._handler);
    this._changeHandler = () => this.host.requestUpdate();
    this.store.addEventListener("change", this._changeHandler);
  }
  hostDisconnected() {
    this.store.removeEventListener("control", this._handler);
    this.store.removeEventListener("change", this._changeHandler);
  }
  get value() {
    return this.store.get(this.id);
  }
}
