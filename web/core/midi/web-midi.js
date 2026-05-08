// SPDX-License-Identifier: Apache-2.0
//
// Web MIDI bridge — turns browser-attached MIDI input devices into
// a stream of `Command::MidiInput` envelopes on the foyer-core WS.
//
// Design notes:
//
//   * Per-device preferences (enabled, channel remap, transpose,
//     velocity curve) are localStorage-only — they describe the
//     hardware physically plugged into THIS browser, so cross-client
//     visibility is not a concern (the `backend = source of truth for
//     shared session state` rule in CLAUDE.md applies to settings
//     that other clients should see; a USB controller plugged into
//     the laptop is the opposite of that). Backend channel routing
//     (which Ardour track receives the bytes) lives in the JACK
//     graph the user sets up against the shim's "Foyer Web MIDI"
//     port — that IS shared state, but the shim handles its own
//     persistence via Ardour's session XML.
//
//   * Permission is opt-in. `navigator.requestMIDIAccess()` triggers
//     a browser permission prompt; firing it on page load would
//     ambush every user with a prompt for a feature most don't use.
//     The UI surfaces an explicit "Enable MIDI" button which calls
//     `requestAccess()`. We don't auto-call even when permission is
//     already granted (Chrome silently re-grants without a prompt;
//     Firefox may still prompt) — the user's first signal that they
//     want MIDI is opening the panel.
//
//   * No outbox queueing. Live MIDI is real-time; a delayed note-on
//     after a reconnect sounds worse than the dropped event. The WS
//     `sendMidiInput()` helper drops on a closed socket.
//
//   * Sysex is NOT requested. Web MIDI requires `{ sysex: true }` to
//     receive sysex; we don't ask, and the schema-side handler also
//     rejects >3 byte payloads. Forward-compat work for sysex would
//     need both layers loosened in lockstep + an RBAC review.

const STORAGE_KEY = "foyer.web-midi.devices.v1";

/**
 * Stable id for the always-present on-screen keyboard. Lives at the
 * same level as a real `MIDIInput` in `listDevices()` so per-device
 * config (channel remap, transpose, velocity curve) applies the same
 * way — without this an on-screen keyboard would either bypass the
 * transforms entirely (surprising) or duplicate them in its own
 * component (drift waiting to happen).
 */
export const VIRTUAL_KEYBOARD_ID = "virtual:keyboard";

/**
 * @typedef {object} DeviceConfig
 * @property {boolean} enabled            Forward events from this device.
 * @property {"passthrough" | "force"} channelMode
 *   `passthrough` = ship the device's own channel (status low nibble
 *   unchanged). `force` = rewrite to `forceChannel` before send.
 * @property {number} forceChannel        0..15 (UI displays 1..16).
 * @property {number} transpose           Semitones, -24..+24.
 * @property {"linear" | "soft" | "hard"} velocityCurve
 *   `soft` favors low velocities (square root); `hard` punches them
 *   up (square); `linear` is identity. Applied to NoteOn velocity
 *   only.
 */

/** @returns {DeviceConfig} */
function defaultConfig() {
  return {
    enabled: true,
    channelMode: "passthrough",
    forceChannel: 0,
    transpose: 0,
    velocityCurve: "linear",
  };
}

function loadAllConfigs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveAllConfigs(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota / private mode — pref doesn't persist; not fatal.
  }
}

function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo;
  return Math.max(lo, Math.min(hi, value));
}

function applyVelocityCurve(curve, vel) {
  const v = clamp(vel, 0, 127);
  if (curve === "soft") return Math.round(Math.sqrt(v / 127) * 127);
  if (curve === "hard") return Math.round((v * v) / 127);
  return v;
}

/**
 * MIDI status nibbles that carry a channel in their low 4 bits.
 * 0x80–0xEF: NoteOff/On, Aftertouch, CC, ProgramChange, ChannelPressure,
 * PitchBend. 0xF0+ are system messages and have no channel.
 */
function isChannelVoice(status) {
  return status >= 0x80 && status < 0xf0;
}

/** Trim sysex / system real-time / system common to keep dispatch tight. */
function isSupportedMessage(data) {
  if (!data || data.length === 0 || data.length > 3) return false;
  const status = data[0];
  // System messages we don't ship today: sysex (0xf0), MTC quarter
  // frame (0xf1), song position (0xf2), song select (0xf3),
  // tune request (0xf6), end-sysex (0xf7), real-time clock (0xf8),
  // start (0xfa), continue (0xfb), stop (0xfc), active sensing
  // (0xfe), reset (0xff). The shim's port write would accept them
  // but until we have a use case for any of them on the wire,
  // dropping at the source keeps WS chatter low.
  if (status >= 0xf0) return false;
  return isChannelVoice(status);
}

/**
 * Singleton service. Construct via `getWebMidiService()` so all
 * panels / overlays see the same device list and config.
 */
class WebMidiService extends EventTarget {
  constructor() {
    super();
    /** @type {MIDIAccess | null} */
    this._access = null;
    this._granted = false;
    this._unsupported = typeof navigator === "undefined" || !navigator.requestMIDIAccess;
    /** @type {Map<string, MIDIInput>} */
    this._inputs = new Map();
    /** @type {Map<string, (e: MIDIMessageEvent) => void>} */
    this._handlers = new Map();
    /**
     * Synthetic devices that don't correspond to a real `MIDIInput`
     * but should still appear in `listDevices()` and pass through the
     * same transform pipeline. Keyed by stable id (e.g.
     * `VIRTUAL_KEYBOARD_ID`); the value is the descriptor surfaced to
     * the UI. Always populated regardless of permission grant — the
     * on-screen keyboard works even when the browser denies real
     * MIDI access (Safari, locked-down WebViews) so users always have
     * SOME way to test the bridge end-to-end.
     */
    this._virtualDevices = new Map();
    this._virtualDevices.set(VIRTUAL_KEYBOARD_ID, {
      id: VIRTUAL_KEYBOARD_ID,
      name: "On-screen Keyboard",
      manufacturer: "Foyer",
      state: "connected",
      connection: "open",
    });
    this._configs = loadAllConfigs();
    /** @type {import("../ws.js").FoyerWs | null} */
    this._ws = null;
    /** Forward-event callbacks keyed by handler ref (for tests). */
    this._tap = null;
    /**
     * Track id currently armed for direct injection. When set, every
     * outbound `midi_input` envelope rides a `track_id` field so the
     * shim writes the bytes straight into that track's MIDI chain
     * (mirroring how the audio ingress path lands samples in a
     * specific track when that user is the source-user). Single-track
     * arming is the MVP — matches audio's "one track owned by me"
     * model and keeps the picker simple. Set via `armTrack(id)`,
     * cleared via `disarmTrack(id)` / `disarm()`.
     */
    this._armedTrackId = null;
  }

  /** Wire to a FoyerWs instance. Idempotent — safe to re-attach on variant remount. */
  attach(ws) {
    this._ws = ws;
  }

  /** True when the browser has no Web MIDI API (Safari < 18, locked-down WebViews). */
  get unsupported() {
    return this._unsupported;
  }

  /** True after `requestAccess()` has resolved with a real MIDIAccess. */
  get granted() {
    return this._granted;
  }

  /**
   * Snapshot of currently visible inputs with their effective configs.
   * Stable shape so UI bindings can treat it as a render input.
   * Synthetic devices (on-screen keyboard) appear alongside real
   * inputs with `virtual: true` set so the panel can label them
   * (and skip irrelevant chrome like a "connected" pill that's
   * tautological for an in-process source).
   */
  listDevices() {
    const out = [];
    for (const [id, descriptor] of this._virtualDevices) {
      out.push({
        id,
        name: descriptor.name,
        manufacturer: descriptor.manufacturer || "",
        state: descriptor.state,
        connection: descriptor.connection,
        virtual: true,
        config: { ...this._effectiveConfig(id) },
      });
    }
    for (const [id, input] of this._inputs) {
      out.push({
        id,
        name: input.name || "MIDI device",
        manufacturer: input.manufacturer || "",
        state: input.state,         // "connected" | "disconnected"
        connection: input.connection, // "open" | "closed" | "pending"
        virtual: false,
        config: { ...this._effectiveConfig(id) },
      });
    }
    // Virtual keyboard pinned first so it's always discoverable;
    // otherwise alphabetical by name.
    out.sort((a, b) => {
      if (a.virtual !== b.virtual) return a.virtual ? -1 : 1;
      return (a.name || "").localeCompare(b.name || "");
    });
    return out;
  }

  /** Pull the stored config for a device (or default if never set). */
  _effectiveConfig(deviceId) {
    return { ...defaultConfig(), ...(this._configs[deviceId] || {}) };
  }

  /** Update + persist a partial config; emits `change`. */
  setDeviceConfig(deviceId, patch) {
    const cur = this._effectiveConfig(deviceId);
    const next = { ...cur, ...(patch || {}) };
    next.enabled = !!next.enabled;
    next.channelMode = next.channelMode === "force" ? "force" : "passthrough";
    next.forceChannel = clamp(Math.round(next.forceChannel), 0, 15);
    next.transpose = clamp(Math.round(next.transpose), -24, 24);
    if (!["linear", "soft", "hard"].includes(next.velocityCurve)) {
      next.velocityCurve = "linear";
    }
    this._configs[deviceId] = next;
    saveAllConfigs(this._configs);
    this._emitChange();
  }

  /**
   * Trigger the browser's permission prompt and start observing inputs.
   * Resolves to `true` on grant. Calling again after grant is a no-op.
   * Errors (user denial, no API) resolve `false` so callers can show a
   * "Web MIDI not available" hint without try/catching.
   */
  async requestAccess() {
    if (this._unsupported) return false;
    if (this._granted && this._access) return true;
    let access;
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      console.warn("[web-midi] requestMIDIAccess rejected", e);
      return false;
    }
    this._access = access;
    this._granted = true;
    access.addEventListener("statechange", (ev) => this._onStateChange(ev));
    for (const [id, input] of access.inputs) this._adoptInput(id, input);
    this._emitChange();
    return true;
  }

  /** Detach event listeners + drop access (used by tests). */
  reset() {
    for (const [id, input] of this._inputs) {
      const h = this._handlers.get(id);
      if (h) input.removeEventListener("midimessage", h);
    }
    this._inputs.clear();
    this._handlers.clear();
    this._access = null;
    this._granted = false;
    this._emitChange();
  }

  /** Test seam: tap every outbound packet right before it hits the WS. */
  setTap(fn) {
    this._tap = typeof fn === "function" ? fn : null;
  }

  /** Track id currently armed for direct injection (or null). */
  get armedTrackId() {
    return this._armedTrackId;
  }

  /**
   * Pin a MIDI track as the destination for every incoming MIDI byte
   * from this client's devices. Replaces any previous armed track —
   * arming a second track implicitly disarms the first, since one
   * keyboard playing two synths through this UI surface isn't a
   * coherent gesture (the user would have to pick which note went
   * where). The server enforces the source-user check independently;
   * this is just a UX-side router.
   */
  armTrack(trackId) {
    if (!trackId) return;
    if (this._armedTrackId === trackId) return;
    this._armedTrackId = trackId;
    this._emitChange();
  }

  /** Inverse of `armTrack`. No-op if a different track is armed. */
  disarmTrack(trackId) {
    if (trackId && this._armedTrackId !== trackId) return;
    if (this._armedTrackId === null) return;
    this._armedTrackId = null;
    this._emitChange();
  }

  /** Drop any armed-track state. Used on logout / variant teardown. */
  disarm() {
    if (this._armedTrackId === null) return;
    this._armedTrackId = null;
    this._emitChange();
  }

  /**
   * Feed bytes into the service as if they had arrived from a
   * `MIDIInput`. Used by the on-screen keyboard (and tests) so the
   * synthetic source is gated by the same enable / channel / transpose
   * / velocity-curve config a real device gets. `data` is a 1–3 byte
   * channel-voice message; the device does not need to be a virtual
   * one (you can simulate a real device by passing its id).
   * Returns `true` if the message was forwarded (or shaped + dropped
   * by transpose-out-of-range, which still counts as "consumed");
   * `false` if the deviceId is unknown or the message is malformed.
   */
  inject(deviceId, data) {
    if (!deviceId) return false;
    if (!this._virtualDevices.has(deviceId) && !this._inputs.has(deviceId)) return false;
    if (!isSupportedMessage(data)) return false;
    this._onMessage(deviceId, { data });
    return true;
  }

  _emitChange() {
    this.dispatchEvent(new CustomEvent("change"));
  }

  _onStateChange(ev) {
    const port = ev.port;
    if (!port || port.type !== "input") return;
    if (port.state === "connected") {
      this._adoptInput(port.id, port);
    } else {
      const handler = this._handlers.get(port.id);
      if (handler && this._inputs.get(port.id)) {
        try { this._inputs.get(port.id).removeEventListener("midimessage", handler); } catch {}
      }
      this._inputs.delete(port.id);
      this._handlers.delete(port.id);
    }
    this._emitChange();
  }

  _adoptInput(id, input) {
    if (this._inputs.has(id)) return;
    const handler = (ev) => this._onMessage(id, ev);
    this._inputs.set(id, input);
    this._handlers.set(id, handler);
    input.addEventListener("midimessage", handler);
    // `open()` is implicit when an event listener is attached, but
    // calling it explicitly makes the connection state observable
    // sooner so the UI can show "open" rather than "pending".
    if (typeof input.open === "function") {
      input.open().catch(() => {});
    }
  }

  _onMessage(deviceId, ev) {
    const data = ev.data;
    if (!isSupportedMessage(data)) return;
    const cfg = this._effectiveConfig(deviceId);
    if (!cfg.enabled) return;
    const out = this._transform(data, cfg);
    if (!out) return;
    if (this._tap) {
      try { this._tap(deviceId, out, this._armedTrackId); } catch {}
    }
    if (this._ws) this._ws.sendMidiInput(out, this._armedTrackId || undefined);
  }

  /**
   * Apply per-device transforms. Returns a Uint8Array of 1–3 bytes
   * or `null` to drop. Channel rewriting is done by overwriting the
   * status byte's low nibble; transpose adjusts NoteOn/NoteOff data1
   * and clamps to 0..127 (out-of-range notes are dropped, matching
   * how a hardware splitter would behave); velocity curve only
   * affects NoteOn velocity (NoteOff velocity is conventionally
   * ignored by most synths, leaving it linear avoids a surprising
   * effect on release loudness).
   */
  _transform(data, cfg) {
    const bytes = new Uint8Array(data);
    const status = bytes[0];
    if (cfg.channelMode === "force" && isChannelVoice(status)) {
      bytes[0] = (status & 0xf0) | (cfg.forceChannel & 0x0f);
    }
    const kind = status & 0xf0;
    if (kind === 0x90 || kind === 0x80) {
      const noteRaw = bytes[1];
      const note = noteRaw + cfg.transpose;
      if (note < 0 || note > 127) return null;
      bytes[1] = note;
      if (kind === 0x90 && bytes.length >= 3) {
        bytes[2] = applyVelocityCurve(cfg.velocityCurve, bytes[2]);
      }
    }
    return bytes;
  }
}

let _instance = null;

/** Lazily-constructed singleton. Construction is cheap; no permission yet. */
export function getWebMidiService() {
  if (!_instance) _instance = new WebMidiService();
  return _instance;
}

// Test-only: reset the singleton between specs that exercise the
// permission flow. Not exported as a public API surface.
export function __resetWebMidiServiceForTests() {
  if (_instance) _instance.reset();
  _instance = null;
}
