// SPDX-License-Identifier: Apache-2.0
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
      // Set of track ids whose regions include at least one active
      // beat-sequencer layout (`foyer_sequencer.active !== false`).
      // Populated from `regions_list` / `region_updated` events so
      // anything that renders tracks (mixer strips, timeline lane
      // kind) can mark them with a SEQ chip without having to
      // re-walk the per-track region list itself.
      sequencerTrackIds: new Set(),
      // Latest known regions per track. Kept so UI surfaces that
      // don't own their own region state (mixer strip chips,
      // agent tools) can query without a dedicated subscription.
      regionsByTrack: new Map(),
      // track_id → peer_id, mirrors the server's routing table. The
      // host sets an entry by choosing a user in the track editor;
      // the named browser then shows a mic toolbar affordance. Used
      // by mixer + track editor to gate live-monitoring UI and by
      // the transport bar to decide whether to render the return-of-
      // mic button.
      trackBrowserSources: new Map(),
      // ── RBAC (populated from ClientGreeting) ─────────────────────
      // Filled on each handshake so components can gate UI without
      // re-implementing policy. `isTunnel` false means LAN → no
      // gating. `isAuthenticated` false on tunnel means the client
      // should show its login modal. `roleAllow` is an allowlist of
      // wire-tag patterns (same language as roles.yaml) so the
      // client can mirror the server's decisions. LAN defaults to
      // admin-equivalent (isAuthenticated=true, no gate).
      rbac: {
        isTunnel: false,
        isAuthenticated: true,
        roleId: null,
        roleAllow: [],
        recipient: null,
      },
    };
    // Transport-position reconciliation state.
    this._lastTransportSeq = 0;
    this._lastTransportPos = 0;
    this._lastTransportSeekAt = 0;
    this._transportDropStats = { stale_seq: 0, backward_jump: 0 };
    this._peerPruneInterval = null;
    if (typeof window !== "undefined") {
      this._peerPruneInterval = setInterval(() => this._prunePeers(), 3000);
    }
  }

  // ── RBAC helpers ───────────────────────────────────────────────────
  /**
   * True when the current connection's role allows a given command
   * tag. LAN connections always return true (no gating); tunnel
   * connections consult `rbac.roleAllow` using the same pattern rules
   * the server uses. Unauthenticated tunnel connections deny
   * everything so the UI encourages sign-in.
   *
   * Pattern rules (mirrored from crates/foyer-config/src/roles.rs):
   *   "*"           → any command
   *   "prefix.*"    → "prefix" or "prefix.foo"
   *   "prefix_*"    → starts with "prefix_"
   *   "exact_name"  → literal
   */
  isAllowed(cmdTag) {
    const rbac = this.state.rbac;
    if (!rbac.isTunnel) return true;           // LAN = trusted
    if (!rbac.isAuthenticated) return false;   // tunnel w/o token = deny all
    for (const pattern of rbac.roleAllow || []) {
      if (pattern === "*") return true;
      if (pattern.endsWith(".*")) {
        const prefix = pattern.slice(0, -2);
        if (cmdTag === prefix || cmdTag.startsWith(prefix + ".")) return true;
        continue;
      }
      if (pattern.endsWith("*")) {
        const prefix = pattern.slice(0, -1);
        if (cmdTag.startsWith(prefix)) return true;
        continue;
      }
      if (pattern === cmdTag) return true;
    }
    return false;
  }

  /** Current RBAC snapshot — reacts to "rbac" event. */
  rbac() {
    return this.state.rbac;
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

  /// Everyone currently connected, excluding this browser's own entry.
  /// The server is the authority — this is a direct mirror of the
  /// `peers` map it broadcasts, so tunnel guests show up alongside LAN
  /// connections with no timing games or heartbeat logic needed.
  activePeers() {
    const self = this.state.selfPeerId;
    return [...this.state.peers.values()].filter((p) => p.id !== self);
  }

  /// Legacy no-op; server-driven roster doesn't need pruning (clients
  /// drop entries on PeerLeft). Kept so the interval tick doesn't
  /// explode on old builds that still schedule it.
  _prunePeers() {
    // intentionally empty — peers are authoritative from the server
  }

  /** Current value for a control ID, or undefined if unknown. */
  get(id) {
    return this.state.controls.get(id);
  }

  /** Recompute `sequencerTrackIds` from the regions map. Called on
   *  every region mutation so both the mixer and the timeline can
   *  read a cheap Set.has() instead of re-walking per render. */
  _recomputeSequencerTracks() {
    const next = new Set();
    for (const [tid, list] of this.state.regionsByTrack) {
      for (const r of list || []) {
        const layout = r?.foyer_sequencer;
        if (layout && layout.active !== false) {
          next.add(tid);
          break;
        }
      }
    }
    this.state.sequencerTrackIds = next;
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
   *  sidecar's live backend — that's a SelectSession on the WS.
   *
   *  Always re-sends `select_session` + `request_snapshot`, even if
   *  the id already matches `currentSessionId`. The reducer for
   *  `session_list` auto-focuses the most recent open session by
   *  directly assigning `currentSessionId` (no WS command fires), so
   *  a subsequent user click on that same session would otherwise be
   *  swallowed — feels broken, and also leaves the server's
   *  `focus_session_id` lagging by one connect cycle. */
  setCurrentSession(id) {
    const changed = this.state.currentSessionId !== id;
    if (changed) {
      this.state.currentSessionId = id;
      // Drop the snapshot so views re-render their loading state
      // while the next SessionSnapshot arrives from the selected
      // session's pump.
      this.state.session = null;
      this.dispatchEvent(new CustomEvent("sessions"));
      this._emit();
    }
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
    const onSeekRequest = (ev) => {
      this._lastTransportSeekAt = Number(ev?.detail?.at_ms) || Date.now();
      const target = Number(ev?.detail?.value);
      if (Number.isFinite(target)) this._lastTransportPos = target;
    };
    ws.addEventListener("status", onStatus);
    ws.addEventListener("envelope", onEnvelope);
    ws.addEventListener("transport_seek_request", onSeekRequest);
    return () => {
      ws.removeEventListener("status", onStatus);
      ws.removeEventListener("envelope", onEnvelope);
      ws.removeEventListener("transport_seek_request", onSeekRequest);
      if (this._ws === ws) this._ws = null;
    };
  }

  _onEnvelope(env) {
    const body = env?.body;
    if (!body || typeof body.type !== "string") return;
    const activeSessionId = this.state.currentSessionId || null;
    const envelopeSessionId = env?.session_id || null;
    const isSessionScoped =
      body.type === "session_snapshot"
      || body.type === "control_update"
      || body.type === "meter_batch"
      || body.type === "session_patch"
      || body.type === "track_updated"
      || body.type === "session_dirty_changed"
      || body.type === "regions_list"
      || body.type === "region_updated"
      || body.type === "region_removed";
    if (
      isSessionScoped
      && activeSessionId
      && envelopeSessionId
      && envelopeSessionId !== activeSessionId
    ) {
      return;
    }
    // Presence: the server drives the `peers` map via
    // PeerJoined/PeerLeft/PeerList events — see the reducer cases
    // below. No origin-sniffing here.
    switch (body.type) {
      case "client_greeting": {
        // Mirror server-side RBAC state so components can gate UI
        // without re-parsing envelopes themselves. `isTunnel` drives
        // login-modal visibility; `roleAllow` drives per-control
        // hide/disable decisions via `isAllowed()`.
        this.state.rbac = {
          isTunnel: !!body.is_tunnel,
          isAuthenticated: body.is_authenticated !== false,
          roleId: body.role_id || null,
          roleAllow: Array.isArray(body.role_allow) ? body.role_allow : [],
          recipient: body.recipient || null,
        };
        // Our own connection id — used to filter our entry out of the
        // connected-peers list so the user doesn't see themselves.
        this.state.selfPeerId = body.peer_id || "";
        // Full greeting retained so the bootstrap + feature registry
        // can pull backend capability flags and the server-pinned
        // default UI variant without re-parsing the envelope.
        this.state.greeting = body;
        this.dispatchEvent(new CustomEvent("rbac"));
        this.dispatchEvent(new CustomEvent("peers"));
        this.dispatchEvent(new CustomEvent("greeting"));
        break;
      }
      case "peer_list": {
        // Replace the whole map — this lands before joins/leaves start
        // streaming, so it's a clean reset on reconnect.
        this.state.peers = new Map();
        for (const p of body.peers || []) {
          this.state.peers.set(p.id, p);
        }
        this.dispatchEvent(new CustomEvent("peers"));
        break;
      }
      case "peer_joined": {
        if (body.peer?.id) {
          this.state.peers.set(body.peer.id, body.peer);
          this.dispatchEvent(new CustomEvent("peers"));
        }
        break;
      }
      case "peer_left": {
        if (body.peer_id && this.state.peers.has(body.peer_id)) {
          this.state.peers.delete(body.peer_id);
          this.dispatchEvent(new CustomEvent("peers"));
        }
        break;
      }
      case "track_browser_source_changed": {
        const tid = body.track_id;
        if (!tid) break;
        if (body.peer_id) this.state.trackBrowserSources.set(tid, body.peer_id);
        else              this.state.trackBrowserSources.delete(tid);
        this.dispatchEvent(new CustomEvent("track-browser-sources"));
        break;
      }
      case "track_browser_sources_snapshot": {
        this.state.trackBrowserSources = new Map();
        for (const e of body.entries || []) {
          if (e?.track_id && e?.peer_id) this.state.trackBrowserSources.set(e.track_id, e.peer_id);
        }
        this.dispatchEvent(new CustomEvent("track-browser-sources"));
        break;
      }
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
        this._lastTransportSeq = Number(env?.seq || 0);
        this._lastTransportPos = Number(c.get("transport.position") || 0);
        this._emit();
        break;
      }
      case "control_update": {
        if (body.update?.id === "transport.position") {
          if (this._applyTransportPosition(body.update.value, Number(env?.seq || 0))) {
            this._emitControl("transport.position");
          }
        } else if (body.update?.id) {
          if (this._applyControl(body.update.id, body.update.value)) {
            this._emitControl(body.update.id);
          }
        }
        break;
      }
      case "meter_batch": {
        for (const u of body.values || []) {
          if (u?.id === "transport.position") {
            if (this._applyTransportPosition(u.value, Number(env?.seq || 0))) {
              this._emitControl("transport.position");
            }
            continue;
          }
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
      case "regions_list": {
        const list = Array.isArray(body.regions) ? body.regions : [];
        this.state.regionsByTrack.set(body.track_id, list);
        this._recomputeSequencerTracks();
        this._emit();
        break;
      }
      case "region_updated": {
        const r = body.region;
        if (!r) break;
        const list = this.state.regionsByTrack.get(r.track_id) || [];
        const idx = list.findIndex((x) => x.id === r.id);
        const copy = list.slice();
        if (idx >= 0) copy[idx] = r;
        else copy.push(r);
        this.state.regionsByTrack.set(r.track_id, copy);
        this._recomputeSequencerTracks();
        this._emit();
        break;
      }
      case "region_removed": {
        const tid = body.track_id;
        const list = this.state.regionsByTrack.get(tid);
        if (list) {
          this.state.regionsByTrack.set(
            tid,
            list.filter((r) => r.id !== body.region_id),
          );
          this._recomputeSequencerTracks();
          this._emit();
        }
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

  /**
   * Reconcile transport.position updates from backend ticks.
   * While rolling, ignore stale backward jumps unless we recently
   * observed an explicit seek request from the UI.
   */
  _applyTransportPosition(value, seq = 0) {
    const next = Number(value) || 0;
    if (seq && seq < this._lastTransportSeq) {
      this._noteTransportDrop("stale_seq");
      return false;
    }

    const now = Date.now();
    const playing = !!this.state.controls.get("transport.playing");
    const looping = !!this.state.controls.get("transport.looping");
    const seekRecent = now - this._lastTransportSeekAt < 1500;
    const prev = Number(
      this.state.controls.get("transport.position")
      ?? this._lastTransportPos
      ?? 0,
    );
    const backwardsBy = prev - next;
    const jitterThreshold = 2400; // ~50ms at 48kHz.

    if (playing && !looping && backwardsBy > jitterThreshold && !seekRecent) {
      this._noteTransportDrop("backward_jump");
      return false;
    }

    const changed = this._applyControl("transport.position", next);
    if (changed) {
      if (seq) this._lastTransportSeq = seq;
      this._lastTransportPos = next;
    }
    return changed;
  }

  _noteTransportDrop(reason) {
    const key = reason === "stale_seq" ? "stale_seq" : "backward_jump";
    this._transportDropStats[key] = (this._transportDropStats[key] || 0) + 1;
    if (!this._diagEnabled()) return;
    this.dispatchEvent(
      new CustomEvent("transport-diagnostics", {
        detail: { ...this._transportDropStats },
      }),
    );
  }

  _diagEnabled() {
    try {
      return localStorage.getItem("foyer.dev.transportDiag") === "1";
    } catch {
      return false;
    }
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
