// Sprunki App — top-level shell for the patch-based variant.
//
// Boot order:
//   1. Wait for foyer-core's WS + store to be alive.
//   2. Asset-pack consent (sprunki SVG art) — sticky, the kid only
//      sees this once. Skip is fine; the variant works on emoji.
//   3. Ensure an Ardour session is loaded (`launch_project` if the
//      active backend is the launcher stub).
//   4. Provision N MIDI slot tracks via setup.js (`Sprunki Slot N`).
//      Idempotent — by-name dedupe means a reload reuses everything.
//   5. Push every slot's sequencer layout so the seeded loops play.
//   6. Render the stage + palette.
//
// The stage is the variant's central surface. The patch palette
// is the costume rack the kid drags from. Click any occupied
// sprunki → an interior overlay opens with the per-row step grids
// for that patch.

import { LitElement, html } from "lit";
import { appStyles } from "./styles.js";
import "./components/sprunki-stage.js";
import "./components/patch-palette.js";
import "./components/sprunki-interior.js";
import "./components/preferences-modal.js";
import "./components/parental-gate-modal.js";
import "./components/asset-pack-modal.js";
import "./components/arrangement-modal.js";
import "./components/style-picker.js";
import { BARS_PER_PATTERN, DEFAULT_BPM, DEFAULT_PATTERNS } from "./components/sound-catalog.js";
import { sprunkiStore } from "./state-store.js";
import { ensureSprunkiStage, provisionOneSlot } from "./setup.js";
import { refreshPluginCatalog } from "./plugin-catalog.js";
import { pushAllLayouts, pushSlotLayout } from "./sequencer-bridge.js";
import { loadSprunkiManifest, probeAssetBase, invalidateAssetBase } from "./sprunki-assets.js";
import { levelDb } from "./components/sprunki-stage.js";
import { FX_CATALOG, INGRESS_ONLY_FX, fxUrisFor } from "./fx-catalog.js";
import { getPatch } from "./patches.js";
import { pitchClassesForKey } from "./theory.js";
import { startAudioIngress, stopAudioIngress, ingressState } from "./audio-ingress.js";
import { getStyle } from "./style-catalog.js";

// Loop bar count — the sprunki experience is one 4-bar loop, no
// arrangement. Sections (Intro/Verse/Chorus/Drop) stay in the data
// model as `DEFAULT_PATTERNS` for compatibility but the kid only
// ever sees the active one ("intro").
const LOOP_BARS = BARS_PER_PATTERN;
const BAR_BEATS = 4;

// Toolbar glyphs — the ACTUAL OG sprunki / TurboWarp player
// chrome SVGs, lifted verbatim from
// /home/vscode/.local/share/foyer/asset-packs/sprunki/index.html
// (Rich called this out in the 2026-05-25 review pass — "When I
// said original, I meant original, not fucking emojis, we have
// the asset pack, use it"). Keep these as-is so the chrome reads
// identically to the OG game.
//
// The hamburger isn't shipped as a sprite by the OG project (its
// "Settings" sprite is a full 649×369 panel artwork, not a small
// menu glyph). We use the standard 3-bar pattern — same as the
// gray-circle hamburger visible in Rich's screenshots.
const GLYPHS = {
  flag: html`<svg viewBox="0 0 16.63 17.5" aria-hidden="true">
    <path fill="#4cbf56" stroke="#45993d" stroke-linecap="round" stroke-linejoin="round"
          d="M.75,2A6.44,6.44,0,0,1,8.44,2h0a6.44,6.44,0,0,0,7.69,0V12.4a6.44,6.44,0,0,1-7.69,0h0a6.44,6.44,0,0,0-7.69,0"/>
    <line stroke="#45993d" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
          x1=".75" y1="16.75" x2=".75" y2=".75"/>
  </svg>`,
  pause: html`<svg viewBox="0 0 4.2333332 4.2333335" aria-hidden="true">
    <g fill="#ffae00">
      <path d="M.389.19239126h1.2631972v3.8485508H.389zM2.5810001.19239126h1.2631972v3.8485508H2.5810001z"/>
    </g>
  </svg>`,
  stop: html`<svg viewBox="0 0 14 14" aria-hidden="true">
    <path fill="#ec5959" stroke="#b84848" stroke-linecap="round" stroke-linejoin="round"
          stroke-miterlimit="10"
          d="M4.3.5h5.4l3.8 3.8v5.4l-3.8 3.8H4.3L.5 9.7V4.3z"/>
  </svg>`,
  // 3-square chip strip — reads as "song arrangement" (three
  // blocks side by side, like a multi-part song timeline). Used
  // on the new persistent "Arrange…" toolbar button.
  arrange: html`<svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2.5" y="6" width="5" height="12" rx="1.2" fill="#9bbcff"/>
    <rect x="9.5" y="6" width="5" height="12" rx="1.2" fill="#ffd200"/>
    <rect x="16.5" y="6" width="5" height="12" rx="1.2" fill="#ff9bff"/>
  </svg>`,
  hamburger: html`<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" stroke="#fff" stroke-width="2.4"
          stroke-linecap="round" fill="none"/>
  </svg>`,
};

const ASSET_PACK_NAME = "sprunki";

export class SprunkiApp extends LitElement {
  static styles = appStyles;

  static properties = {
    _status: { type: String, state: true },
    _error: { type: String, state: true },
    _patternId: { type: String, state: true },
    _prefsOpen: { type: Boolean, state: true },
    _parentalGateOpen: { type: Boolean, state: true },
    _sprunkiPack: { type: Object, state: true },
    _sprunkiAssetsReady: { type: Boolean, state: true },
    /** Slot id currently zoomed-in for editing, or null. */
    _interiorSlotId: { type: String, state: true },
    _rev: { type: Number, state: true },
    /** Style currently applied (or null). Set when the kid picks one
     *  from the picker; the picker's trigger tints to this color. */
    _activeStyleId: { type: String, state: true },
  };

  constructor() {
    super();
    this._status = "wait-ws";
    this._error = "";
    this._store = sprunkiStore();
    this._patternId = this._store.activePatternId;
    this._prefsOpen = false;
    this._parentalGateOpen = false;
    this._sprunkiPack = null;
    this._sprunkiAssetsReady = false;
    this._interiorSlotId = null;
    this._rev = 0;
    this._activeStyleId = null;
    this._levels = {};   // slotId → dBFS
    this._storeListener = () => { this._rev++; this.requestUpdate(); };
  }

  connectedCallback() {
    super.connectedCallback();
    this._store.addEventListener("stage-changed", this._onStageChanged);
    this._store.addEventListener("board-changed", this._onBoardChanged);
    this._store.addEventListener("pattern-changed", this._storeListener);
    this._store.addEventListener("transport-changed", this._storeListener);
    this._store.addEventListener("tracks-invalidated", this._onTracksInvalidated);
    this._store.addEventListener("parental-changed", this._storeListener);
    this._store.addEventListener("scary-mode-changed", this._storeListener);
    this._store.addEventListener("harmony-changed", this._onHarmonyChanged);
    this._store.addEventListener("asset-source-changed", this._onAssetSourceChanged);
    this._store.addEventListener("arrangements-changed", this._onArrangementsChanged);
    this._waitForWs().then(() => this._afterWs()).catch((err) => this._fail(err));
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._store.removeEventListener("stage-changed", this._onStageChanged);
    this._store.removeEventListener("board-changed", this._onBoardChanged);
    this._store.removeEventListener("pattern-changed", this._storeListener);
    this._store.removeEventListener("transport-changed", this._storeListener);
    this._store.removeEventListener("tracks-invalidated", this._onTracksInvalidated);
    this._store.removeEventListener("parental-changed", this._storeListener);
    this._store.removeEventListener("scary-mode-changed", this._storeListener);
    this._store.removeEventListener("harmony-changed", this._onHarmonyChanged);
    this._store.removeEventListener("asset-source-changed", this._onAssetSourceChanged);
    this._store.removeEventListener("arrangements-changed", this._onArrangementsChanged);
    if (this._layoutPushTimer) {
      clearTimeout(this._layoutPushTimer);
      this._layoutPushTimer = null;
    }
    if (this._tempoTimer) {
      clearTimeout(this._tempoTimer);
      this._tempoTimer = null;
    }
    const f = globalThis.__foyer;
    if (f?.ws && this._wsListener) f.ws.removeEventListener("envelope", this._wsListener);
    if (f?.store && this._coreStoreListener) {
      f.store.removeEventListener?.("control", this._coreStoreListener);
    }
  }

  // ── WS subscription / asset pack flow ─────────────────────────
  _subscribeWs() {
    const f = globalThis.__foyer;
    const ws = f?.ws;
    if (!ws || this._wsListener) return;
    this._wsListener = (ev) => {
      const body = ev?.detail?.body;
      if (!body) return;
      if (body.type === "asset_pack_list") {
        const sprunki = (body.packs || []).find((p) => p.name === ASSET_PACK_NAME);
        if (sprunki) this._handleSprunkiPackUpdate(sprunki);
      } else if (body.type === "asset_pack_updated") {
        if (body.info?.name === ASSET_PACK_NAME) {
          this._handleSprunkiPackUpdate(body.info);
        }
      } else if (body.type === "meter_batch" && Array.isArray(body.values)) {
        this._absorbMeterBatch(body.values);
      } else if (body.type === "backend_lost") {
        // Ardour shim crashed or otherwise disconnected. Surface
        // a retry UI; foyer-server has already torn down the
        // active backend. Re-launching reuses the existing
        // `sprunki-scratch` session on disk so the kid's work
        // isn't lost. Crashes-on-track-add are not unheard of —
        // see "Hard crash" in docs/SPRUNKADOO_HANDOFF.md.
        console.warn("[sprunki] backend lost:", body.reason);
        this._status = "backend-lost";
        this._error = body.reason || "Audio engine disconnected";
        this.requestUpdate();
      }
    };
    ws.addEventListener("envelope", this._wsListener);
    // Re-render when transport.playing / transport.tempo flip so
    // the toolbar's flag-glyph "active" state + BPM readout stay
    // in sync with the backend.
    if (f.store && !this._coreStoreListener) {
      this._coreStoreListener = (ev) => {
        const id = ev?.detail;
        if (typeof id !== "string") return;
        // Transport drives a top-toolbar repaint.
        if (id === "transport.playing" || id === "transport.tempo") {
          this._rev++;
          this.requestUpdate();
          return;
        }
        // Per-slot solo / mute updates need a re-render so the
        // sequencer interior's solo chip lights up + the ribbon
        // matches the backend. Without this the kid clicks Solo,
        // the DAW honors it, but the chip stays grey because the
        // `.soloed` prop is read once at render time.
        if (id.endsWith(".solo") || id.endsWith(".mute")) {
          this._rev++;
          this.requestUpdate();
        }
      };
      f.store.addEventListener?.("control", this._coreStoreListener);
    }
  }

  /** Live per-slot dBFS readings, pushed imperatively into the
   *  stage + interior components. NOT a Lit property — meter rate
   *  is ~30 Hz and we don't want a re-render at that rate. */
  _absorbMeterBatch(values) {
    const stage = this._store.stage;
    const next = this._levels || {};
    for (const slot of stage) {
      if (!slot.track_id) continue;
      const meterId = `${slot.track_id}.meter`;
      const row = values.find((m) => (m.id || m[0]) === meterId);
      if (!row) continue;
      const db = typeof row.value === "number" ? row.value : row[1];
      if (typeof db === "number") next[slot.id] = db;
    }
    this._levels = next;
    const stageEl = this.renderRoot?.querySelector("sprunki-stage");
    if (stageEl?.updateLevels) stageEl.updateLevels(next);
    const interiorEl = this.renderRoot?.querySelector("sprunki-interior");
    if (interiorEl?.updateLevels) interiorEl.updateLevels(next);
  }

  _handleSprunkiPackUpdate(info) {
    this._sprunkiPack = info;
    // Only react to OG-pack lifecycle when OG is the active source.
    // In built-in mode the OG pack just sits on disk (or doesn't)
    // until the kid flips the toggle.
    if (this._store.assetSource === "og") {
      if (this._status === "asset-prompt" && info.state === "ready") {
        this._advanceToProvisioning();
      }
      if (info.state === "ready" && !this._sprunkiAssetsReady) {
        this._initSprunkiAssets().catch((e) => {
          console.warn("[sprunki] asset prep failed:", e);
        });
      } else if (info.state !== "ready" && this._sprunkiAssetsReady) {
        this._sprunkiAssetsReady = false;
        invalidateAssetBase();
      }
    }
    this.requestUpdate();
  }
  async _initSprunkiAssets() {
    await loadSprunkiManifest();
    const base = await probeAssetBase();
    if (base) {
      this._sprunkiAssetsReady = true;
      this.requestUpdate();
    }
  }

  // ── boot flow ─────────────────────────────────────────────────
  async _waitForWs() {
    for (let i = 0; i < 100; i++) {
      const f = globalThis.__foyer;
      if (f?.ws && f?.store?.state?.status === "open") return;
      await sleep(150);
    }
    throw new Error("Foyer WS never came up (after 15 s)");
  }

  async _afterWs() {
    this._subscribeWs();
    const ws = globalThis.__foyer?.ws;
    // Always ask the server for OG-pack status so we can switch into
    // OG mode later without an extra round-trip, even if the kid
    // boots with the built-in pack selected.
    if (ws) ws.send({ type: "list_asset_packs" });

    // Built-in source: skip the OG consent prompt entirely. The
    // bundled SVGs are already on disk under web/ui-sprunki/
    // builtin-assets — no download is needed.
    if (this._store.assetSource === "builtin") {
      this._advanceToProvisioning();
      return;
    }

    for (let i = 0; i < 40; i++) {
      if (this._sprunkiPack) break;
      await sleep(50);
    }
    if (!this._sprunkiPack
        || this._sprunkiPack.state === "ready"
        || this._store.sprunkiAssetConsentRecorded) {
      this._advanceToProvisioning();
      return;
    }
    this._status = "asset-prompt";
    this.requestUpdate();
  }

  // Kid (or parent) flipped the asset source toggle. Drop the
  // resolved asset base for the active source so the next resolve
  // re-probes, and bounce the assets-ready flag so we re-init from
  // the new manifest. If they switched to OG and it isn't on disk
  // yet, surface the existing download prompt.
  _onAssetSourceChanged = () => {
    this._sprunkiAssetsReady = false;
    invalidateAssetBase();
    this._initSprunkiAssets().catch((e) => {
      console.warn("[sprunki] asset re-init after source switch failed:", e);
    });
    if (this._store.assetSource === "og"
        && this._sprunkiPack
        && this._sprunkiPack.state !== "ready") {
      this._status = "asset-prompt";
    }
    this.requestUpdate();
  };

  _onAssetConsent = () => {
    const ws = globalThis.__foyer?.ws;
    if (!ws) return;
    ws.send({ type: "fetch_asset_pack", name: ASSET_PACK_NAME });
    this._sprunkiPack = { ...(this._sprunkiPack || {}), state: "downloading", progress: 0 };
    this.requestUpdate();
  };
  _onAssetSkip = () => {
    this._store.recordSprunkiAssetConsent();
    this._advanceToProvisioning();
  };
  _onAssetClose = () => { this._onAssetSkip(); };

  _advanceToProvisioning() {
    if (this._provisioning) return;   // idempotency guard
    this._provisioning = true;
    this._status = "provisioning";
    this.requestUpdate();
    // Kick off asset init in parallel with backend provisioning.
    // Built-in mode has no failure mode worth blocking on; OG mode
    // returns early if its base isn't resolved yet (the lifecycle
    // hook re-runs init once the pack is ready).
    this._initSprunkiAssets().catch((e) => {
      console.warn("[sprunki] initial asset prep failed:", e);
    });
    this._bootStage()
      .catch((err) => this._fail(err))
      .finally(() => { this._provisioning = false; });
  }

  async _bootStage() {
    await this._ensureSessionLoaded();
    await this._boot();
  }

  async _ensureSessionLoaded() {
    const f = globalThis.__foyer;
    if (f.store?.state?.greeting?.engine_is_dummy === false) return;
    const opened = new Promise((resolve) => {
      const ws = f.ws;
      const handler = (ev) => {
        const t = ev?.detail?.body?.type;
        if (t === "session_opened" || t === "backend_swapped" || t === "session_focus_changed") {
          ws.removeEventListener("envelope", handler);
          resolve(true);
        }
      };
      ws.addEventListener("envelope", handler);
      setTimeout(() => { ws.removeEventListener("envelope", handler); resolve(false); }, 90_000);
    });
    console.info("[sprunki] launching scratch Ardour session for audio backend");
    f.ws.send({
      type: "launch_project",
      backend_id: "ardour",
      project_path: "sprunki-scratch",
    });
    const ok = await opened;
    if (!ok) {
      console.warn("[sprunki] scratch session never reported open in 90 s — continuing");
    }
    await sleep(500);
  }

  async _boot() {
    this._status = "provisioning";
    this.requestUpdate();
    const f = globalThis.__foyer;
    const before = (f.store?.state?.session?.tracks || []).length;
    await ensureSprunkiStage(f.store, f.ws, this._store);
    pushAllLayouts(f.ws, this._store.stage, this._harmony());
    // Kick off the plugin catalog scan in the background — the
    // Advanced section's instrument picker reads from it. Don't
    // await; the kid can use the rest of the UI while LV2/VST
    // discovery finishes.
    refreshPluginCatalog(f.ws);
    const tempo = f.store.get?.("transport.tempo");
    if (!tempo || Number(tempo) <= 0) {
      f.ws.controlSet?.("transport.tempo", DEFAULT_BPM);
    }
    this._startAlwaysOnLoop();
    // Template-style persistence — when this boot CREATED new
    // tracks (cold start, no on-disk session), trigger a save so
    // the .ardour file lands with the 7 sprunki tracks. Every
    // subsequent boot finds them on disk + the by-name dedupe in
    // ensureSprunkiStage skips provisioning entirely. This is the
    // light-touch "templates" answer Rich asked for (2026-05-25):
    // the FIRST run pays the ~3 s provision cost; every run after
    // is near-instant because Ardour reopens the saved state.
    const after = (f.store?.state?.session?.tracks || []).length;
    if (after > before) {
      console.info(`[sprunki] saving session — provisioned ${after - before} new tracks`);
      // Coalesce with a short debounce so we save after the layout
      // pushes settle too — pushing layout doesn't mark the session
      // dirty on the shim, but the create_track + add_plugin path
      // does. The shim ignores save_session calls when nothing has
      // changed, so re-runs are safe.
      setTimeout(() => f.ws.send({ type: "save_session" }), 1500);
    }
    this._status = "ready";
    this.requestUpdate();
  }

  /** Sprunki is always playing. On boot we lock the loop range to a
   *  single 4-bar window (one pattern's worth) and kick the
   *  transport. There are no kid-facing play/stop controls; the
   *  settings panel keeps a debug-only pause for adults. */
  _startAlwaysOnLoop() {
    const f = globalThis.__foyer;
    if (!f?.ws) return;
    const bpm = Number(f.store.get?.("transport.tempo")) || DEFAULT_BPM;
    const sr = Number(f.store.get?.("audio.sample_rate")) || 48000;
    const beat = (60 / bpm) * sr;
    const oneBar = BAR_BEATS * beat;
    // Loop window follows the active timeline selection — either
    // a single part's bar window, or "all" (the whole song). The
    // backend re-emits every placed part via the layout's
    // arrangement[], so the loop just needs to cover the current
    // selection.
    const { startBar, endBar } = this._activeLoopBars();
    f.ws.send({
      type: "set_loop_range",
      start_samples: Math.round(startBar * oneBar),
      end_samples: Math.round(endBar * oneBar),
      enabled: true,
    });
    f.ws.controlSet?.("transport.position", Math.round(startBar * oneBar));
    f.ws.controlSet?.("transport.playing", true);
  }

  /** Re-pin just the loop range to the active selection without
   *  touching transport playing/position. Used when the kid taps
   *  a dot mid-playback — we update the range so the playhead
   *  will jump into the new window on the next loop wrap, but we
   *  don't rip the audio mid-bar. */
  _pinLoopToActiveSelection() {
    const f = globalThis.__foyer;
    if (!f?.ws) return;
    const bpm = Number(f.store.get?.("transport.tempo")) || DEFAULT_BPM;
    const sr = Number(f.store.get?.("audio.sample_rate")) || 48000;
    const beat = (60 / bpm) * sr;
    const oneBar = BAR_BEATS * beat;
    const { startBar, endBar } = this._activeLoopBars();
    f.ws.send({
      type: "set_loop_range",
      start_samples: Math.round(startBar * oneBar),
      end_samples: Math.round(endBar * oneBar),
      enabled: true,
    });
    // Snap the playhead to the new window's start so the kid
    // hears their pick immediately instead of waiting for the
    // current bar to finish.
    f.ws.controlSet?.("transport.position", Math.round(startBar * oneBar));
  }

  _fail(err) {
    console.error("[sprunki] boot failed:", err);
    this._status = "error";
    this._error = String(err?.message || err);
    this.requestUpdate();
  }

  /** Re-launch the Ardour session after a crash. Foyer's launcher
   *  backend respawns the process; our store-side `track_id` /
   *  `region_id` cache is invalidated by the backend_swapped
   *  event, which triggers `_onTracksInvalidated` and re-runs
   *  `ensureSprunkiStage`. */
  _onRetryBackend = async () => {
    this._status = "provisioning";
    this._error = "";
    this.requestUpdate();
    try {
      await this._ensureSessionLoaded();
      await this._boot();
    } catch (e) {
      this._fail(e);
    }
  };

  // ── harmony helpers ───────────────────────────────────────────
  _harmony() {
    return {
      key: this._store.key,
      sectionChords: this._store.sectionChords,
    };
  }

  // ── store-event handlers (re-push layouts on data changes) ────
  _onStageChanged = (ev) => {
    const f = globalThis.__foyer;
    const kind = ev?.detail?.kind;
    if (kind === "moved") {
      // Pure position update — no audible change, just bump the
      // re-render so the stage component sees fresh `slots`.
      this._rev++;
      this.requestUpdate();
      return;
    }
    if (kind === "style-applied") {
      // Bulk rewrite — every slot's patch + every slot's boards
      // just changed. We treat the apply as 7 INDEPENDENT slot
      // re-provisions in parallel, using the same `provisionOneSlot`
      // path the drag-from-palette flow uses. That path is well-
      // exercised in production: it handles patch swaps idempotently,
      // re-validates the track id against the live snapshot, and
      // swaps the instrument plugin when the patch family changes.
      //
      // Why not the heavier `ensureSprunkiStage` path: that one runs
      // a single Promise.all'd sweep behind a global mutex
      // (`_provisionInFlight`); when boot's call is still in flight
      // (slow Ardour open, cold session_snapshot) our style apply
      // chains behind it and the user sees an unexplained ~5 s lag
      // before anything audible changes. Per-slot is also resilient
      // to ONE slot failing without bringing the others down.
      //
      // Order of operations per slot:
      //   1. provisionOneSlot — ensures patch's instrument plugin
      //      is loaded on the slot's MIDI track.
      //   2. _applyPatchProgramToSlot — re-sends the GM program so
      //      gmsynth-on-gmsynth swaps (piano→organ) actually flip.
      //   3. pushSlotLayout — writes the new board into the region.
      //   4. reconcile ingress — Phantom (mic) / Performer (keys).
      const ws = f?.ws;
      const store = f?.store;
      if (!ws || !store) {
        this._rev++;
        this.requestUpdate();
        return;
      }
      const slotIds = this._store.stage.map((s) => s.id);
      console.info(
        `[sprunki] applying style ${ev.detail?.styleId} to ${slotIds.length} slots`,
      );
      Promise.all(
        slotIds.map((slotId) =>
          provisionOneSlot(store, ws, this._store, slotId)
            .then(() => {
              const slot = this._store.slotById(slotId);
              if (!slot) return;
              if (slot.patch_id && slot.track_id) {
                this._applyPatchProgramToSlot(slot);
                pushSlotLayout(ws, slot, this._harmony());
              } else if (!slot.patch_id) {
                // Cleared slot (cast was shorter than stage). Clear
                // the region so the old beat doesn't keep playing.
                pushSlotLayout(ws, slot, this._harmony());
              }
            })
            .then(() => this._reconcileIngressForSlot(slotId))
            .catch((err) =>
              console.warn(`[sprunki] style apply failed for ${slotId}:`, err),
            ),
        ),
      ).then(() => {
        console.info("[sprunki] style apply complete");
        this._rev++;
        this.requestUpdate();
      });
      this._rev++;
      this.requestUpdate();
      return;
    }
    if (kind === "assigned" || kind === "cleared" || kind === "spawned") {
      // SURGICAL per-slot provision. Touching only the slot that
      // changed avoids:
      //   • clobbering other slots' GM-program overrides via the
      //     applyPatchProgram re-fire path in ensurePatchInstrument
      //   • the parallel-Promise.all race that re-validated other
      //     slots' cached region_ids against an in-flight snapshot
      //     and sometimes landed them on empty fresh regions
      //     (whole-cast loop went silent until the kid touched the
      //     sequencer)
      // Cold boot still goes through the full ensureSprunkiStage in
      // _boot(); incremental edits use this.
      const slotId = ev.detail?.slotId;
      provisionOneSlot(f?.store, f?.ws, this._store, slotId)
        .then(() => {
          const slot = this._store.slotById(slotId);
          if (!slot) return;
          // Apply the EFFECTIVE program for this slot — per-COSTUME
          // override if set in Advanced, else the patch's default.
          // ensurePatchInstrument intentionally skips program-apply
          // when the plugin is already loaded (so spurious re-provisions
          // don't reset things), so we do it here. Fixes the
          // Sun → Tree (both gmsynth) swap where program stayed
          // at Piano.
          if (kind !== "cleared" && slot.patch_id && slot.track_id && f?.ws) {
            this._applyPatchProgramToSlot(slot);
          }
          // Push ONLY the affected slot's layout. Other slots are
          // untouched so their notes stay where they were.
          pushSlotLayout(f?.ws, slot, this._harmony());
        })
        .then(() => this._reconcileIngressForSlot(slotId))
        .catch((err) => console.warn("[sprunki] per-slot provision failed:", err));
    } else {
      // Default (removed, etc.) — just re-push.
      if (f?.ws) pushAllLayouts(f.ws, this._store.stage, this._harmony());
    }
    this._rev++;
    this.requestUpdate();
  };

  _onBoardChanged = (ev) => {
    // Debounce + coalesce. A click-drag paint stroke fires up to 16
    // board-changed events in < 200 ms. Pushing a full
    // SequencerLayout for every one of those makes the shim wipe +
    // rebuild the region's MIDI 16 times, which queues stale events
    // in the playback buffer and floods Ardour's DummyMidiBuffer
    // with "it's too late for this event" warnings (10k+ per
    // session was observed). The kid doesn't hear the new cell
    // until the next loop pass anyway, so debouncing 120 ms is
    // imperceptible.
    const slotId = ev?.detail?.slotId;
    this._pendingSlotIds ??= new Set();
    if (slotId) this._pendingSlotIds.add(slotId);
    else this._pendingPushAll = true;
    this._scheduleLayoutPush();
    this._rev++;
    this.requestUpdate();
  };

  _scheduleLayoutPush() {
    if (this._layoutPushTimer) return;
    this._layoutPushTimer = setTimeout(() => {
      this._layoutPushTimer = null;
      const f = globalThis.__foyer;
      if (!f?.ws) {
        this._pendingSlotIds = null;
        this._pendingPushAll = false;
        return;
      }
      if (this._pendingPushAll) {
        pushAllLayouts(f.ws, this._store.stage, this._harmony());
      } else if (this._pendingSlotIds?.size) {
        for (const sid of this._pendingSlotIds) {
          const slot = this._store.slotById(sid);
          if (slot) pushSlotLayout(f.ws, slot, this._harmony());
        }
      }
      this._pendingSlotIds = null;
      this._pendingPushAll = false;
    }, 120);
  }

  /** Apply a new BPM. Debounced — the slider can fire 100+ times
   *  during a drag, and each tempo change makes the shim reschedule
   *  every MIDI event in the loop. Without coalescing this thrashes
   *  the audio engine (Rich's "the audio gets super choppy"
   *  symptom). We also re-pin the loop range since tempo changes
   *  alter samples-per-bar. */
  _applyTempoDebounced(bpm) {
    this._pendingTempo = Math.max(40, Math.min(300, Math.round(bpm)));
    if (this._tempoTimer) return;
    this._tempoTimer = setTimeout(() => {
      this._tempoTimer = null;
      const f = globalThis.__foyer;
      if (!f?.ws || this._pendingTempo == null) return;
      const bpm = this._pendingTempo;
      this._pendingTempo = null;
      f.ws.controlSet?.("transport.tempo", bpm);
      const sr = Number(f.store?.get?.("audio.sample_rate")) || 48000;
      const beat = (60 / bpm) * sr;
      const oneBar = BAR_BEATS * beat;
      const { startBar, endBar } = this._activeLoopBars();
      f.ws.send({
        type: "set_loop_range",
        start_samples: Math.round(startBar * oneBar),
        end_samples: Math.round(endBar * oneBar),
        enabled: true,
      });
    }, 100);
  }

  _onHarmonyChanged = () => {
    // Same coalescing as board-changed — a chord pill cycle or a
    // progression-switch produces a flurry of events but only the
    // final state needs to reach the shim.
    this._pendingPushAll = true;
    this._scheduleLayoutPush();
    this._rev++;
    this.requestUpdate();
  };

  _onTracksInvalidated = () => {
    // Backend swap → re-provision + re-push.
    if (this._provisioning) return;
    this._provisioning = true;
    this._status = "provisioning";
    this.requestUpdate();
    const f = globalThis.__foyer;
    ensureSprunkiStage(f?.store, f?.ws, this._store)
      .then(() => pushAllLayouts(f?.ws, this._store.stage, this._harmony()))
      .then(() => { this._status = "ready"; this.requestUpdate(); })
      .catch((err) => this._fail(err))
      .finally(() => { this._provisioning = false; });
  };

  // ── stage / palette / interior wiring ─────────────────────────
  _onStageMove = (ev) => {
    const { slotId, x, y } = ev.detail;
    this._store.moveSlot(slotId, x, y);
    // Y-axis = level. Translate the new Y into a dBFS gain and
    // ship it as a control_set on the slot's backend track. The
    // sprunki visual scale comes from the same Y locally, so the
    // kid's gesture lights up both surfaces (visual + audio) at
    // once. Throttling: control_set is already cheap and the
    // server coalesces identical values, so per-pointermove is OK.
    const slot = this._store.slotById(slotId);
    const f = globalThis.__foyer;
    if (slot?.track_id && f?.ws?.controlSet) {
      f.ws.controlSet(`${slot.track_id}.gain`, levelDb(y));
    }
  };
  _onStageAssignPatch = (ev) => {
    // Pure forwarder — ingress reconcile happens in _onStageChanged
    // (fires for both drag-from-palette AND probe-direct assigns).
    this._store.assignPatch(ev.detail.slotId, ev.detail.patchId);
  };

  _onStageSpawn = (ev) => {
    const { x, y, patchId } = ev.detail;
    this._store.spawnSlot(x, y, patchId);
  };
  _onStageClear = (ev) => {
    const slotId = ev.detail.slotId;
    // If the interior is open for this slot, close it immediately
    // — otherwise the kid sees a blurry empty backdrop and has to
    // hit ESC to escape, and clicks on the now-empty sprunki
    // re-open it (because _interiorSlotId is still set).
    if (this._interiorSlotId === slotId) this._interiorSlotId = null;
    this._store.clearSlot(slotId);
    // Reconcile is fired from _onStageChanged on kind=cleared
  };

  // ── Ingress reconcile (mic + MIDI keyboard) ───────────────────
  //
  // Patches can declare `accepts_audio_ingress` (Phantom — sends
  // mic audio onto a dedicated AUDIO sidecar track since the
  // slot's MIDI track can't process audio inputs in Ardour) or
  // `accepts_midi_ingress` (Mr Fun Computer aka Performer — arms
  // Web MIDI so the kid's keyboard plays through the slot's
  // instrument, auto-snapped to the active key's scale).
  //
  // This handler runs once per assignPatch/clear/spawn/removed.
  // For audio: creates the Sprunkadoo Mic AUDIO track if it
  // doesn't exist, wires ingress into it, gates further tracks
  // on whether ANY slot still holds an audio-ingress patch.
  // For MIDI: arms / disarms `webMidi` per-track.
  async _reconcileIngressForSlot(slotId) {
    if (!slotId) return;
    const slot = this._store.slotById(slotId);
    const patch = slot?.patch_id ? getPatch(slot.patch_id) : null;

    // ── audio path ────────────────────────────────────────────────
    const wantsAudio = !!patch?.accepts_audio_ingress;
    const anyAudioOnStage = this._store.stage
      .some((s) => s.patch_id && getPatch(s.patch_id)?.accepts_audio_ingress);
    if (wantsAudio) {
      const trackId = await this._ensureMicTrack();
      if (trackId) await startAudioIngress({ trackId });
    } else if (!anyAudioOnStage) {
      // Last audio-ingress patch left the cast — release the
      // mic so the browser indicator goes off.
      if (this._micTrackId) {
        await stopAudioIngress({ trackId: this._micTrackId });
      }
    }

    // ── MIDI path ─────────────────────────────────────────────────
    const f = globalThis.__foyer;
    const wantsMidi = !!patch?.accepts_midi_ingress;
    if (wantsMidi && slot?.track_id) {
      const wm = await this._webMidi();
      if (wm) {
        wm.armTrack(slot.track_id);
        this._installAutoSnapTap(wm);
        if (!wm._foyerSprunkiAccessRequested) {
          wm._foyerSprunkiAccessRequested = true;
          try { await wm.requestAccess?.(); } catch {}
        }
      }
    } else {
      // Disarm if this slot was the armed one (or if no slot
      // currently holds a MIDI-ingress patch).
      const wm = f?.webMidi || globalThis.__foyer?.webMidi;
      const anyMidiOnStage = this._store.stage
        .some((s) => s.patch_id && getPatch(s.patch_id)?.accepts_midi_ingress);
      if (wm && !anyMidiOnStage) wm.disarm?.();
    }
  }

  async _webMidi() {
    const f = globalThis.__foyer;
    if (f?.webMidi) return f.webMidi;
    try {
      const m = await import("foyer-core/midi/web-midi.js");
      return m.getWebMidiService?.();
    } catch (e) {
      console.warn("[sprunki] web-midi service unavailable:", e?.message || e);
      return null;
    }
  }

  /** Idempotent install: rewrites the WebMidiService's send tap
   *  so every outgoing note-on/off gets snapped to the current
   *  key + chord. The tap mutates the Uint8Array in place; the
   *  service sends our mutated bytes to the WS. Safe across
   *  multiple Performer placements (the tap reads live state
   *  every time it runs). */
  _installAutoSnapTap(wm) {
    if (this._autoSnapInstalled) return;
    this._autoSnapInstalled = true;
    const self = this;
    wm.setTap?.((_deviceId, bytes, armedTrackId) => {
      if (!armedTrackId) return;
      const status = bytes[0] & 0xf0;
      // Note-On / Note-Off only.
      if (status !== 0x90 && status !== 0x80) return;
      // Find the slot whose track this is, so we can read its
      // patch's row-level snap hints. (If it's not a Sprunkadoo
      // slot the tap leaves the note alone.)
      const slot = self._store.stage.find((s) => s.track_id === armedTrackId);
      if (!slot) return;
      const patch = slot.patch_id ? getPatch(slot.patch_id) : null;
      if (!patch?.accepts_midi_ingress) return;
      const harmony = self._harmony();
      const scale = pitchClassesForKey(harmony.key);
      if (!scale.size) return;
      // Snap pitch class to the nearest member of the scale. We
      // shift the note (NOT just discard it) so a wrong-key
      // press still produces a satisfying sound. Distance is
      // computed mod 12 with a 6-step cap; ties favor the lower
      // pitch (less startling than jumping up).
      const note = bytes[1];
      const pc = note % 12;
      if (scale.has(pc)) return;
      let best = pc;
      let bestDist = 13;
      for (const sp of scale) {
        const d = Math.min((pc - sp + 12) % 12, (sp - pc + 12) % 12);
        if (d < bestDist) {
          bestDist = d;
          best = sp;
        }
      }
      // Pick whichever direction is closer.
      const upDist = (best - pc + 12) % 12;
      const downDist = (pc - best + 12) % 12;
      const delta = upDist <= downDist ? upDist : -downDist;
      const snapped = Math.max(0, Math.min(127, note + delta));
      bytes[1] = snapped;
    });
  }

  /** Lazy-create the dedicated AUDIO track that receives mic
   *  ingress for any audio-ingress patches on stage. Sprunkadoo
   *  slot tracks are MIDI (so the sequencer can drive instruments)
   *  — MIDI tracks don't process audio inputs, so mic audio
   *  routed to one would land nowhere. Instead we keep a single
   *  shared audio sidecar named "Sprunkadoo Mic"; all Phantoms +
   *  any future audio-ingress patches push through it. The FX
   *  rail in the Phantom interior targets this track's plugin
   *  chain (autotune / vocoder land here, not on the MIDI slot). */
  async _ensureMicTrack() {
    const f = globalThis.__foyer;
    if (!f?.ws) return null;
    if (this._micTrackId) {
      // Confirm it still exists in the snapshot; the user might
      // have deleted it from a foyer-full session in between.
      const tracks = f.store?.state?.session?.tracks || [];
      if (tracks.some((t) => t.id === this._micTrackId)) return this._micTrackId;
      this._micTrackId = null;
    }
    // Look by name first.
    const tracks = f.store?.state?.session?.tracks || [];
    const existing = tracks.find((t) => t?.name === "Sprunkadoo Mic" && t?.kind === "audio");
    if (existing) {
      this._micTrackId = existing.id;
      return existing.id;
    }
    // Create + wait for it.
    f.ws.send({
      type: "create_track",
      name: "Sprunkadoo Mic",
      kind: "audio",
      color: "#0d0d0d",
    });
    const trackId = await new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const ts = f.store?.state?.session?.tracks || [];
        const fresh = ts.find((t) => t?.name === "Sprunkadoo Mic" && t?.kind === "audio");
        if (fresh) return resolve(fresh.id);
        if (Date.now() - start > 8000) return resolve(null);
        setTimeout(tick, 80);
      };
      tick();
    });
    if (trackId) this._micTrackId = trackId;
    return trackId;
  }
  _onStageClickSlot = (ev) => {
    // Clicking ANY sprunki body clears solo across the cast first —
    // OG-style "only one soloed character at a time" — then opens
    // the interior. Picking up where a kid expects: tap on a friend
    // to focus them; the prior solo is no longer holding the mix.
    this._clearAllSolo();
    this._interiorSlotId = ev.detail.slotId;
  };
  /** Per-sprunki S / M / × ribbon. Solo + mute are pure DAW
   *  control_set on the slot's backend track — local visual
   *  state echoes from foyer-core's `controls` map on the next
   *  ControlUpdate. Solo is RADIO: enabling on one slot clears
   *  every other slot's solo first. Delete = remove the slot
   *  from the stage entirely (different from clear-X which
   *  keeps the empty performer). */
  _onStageToggleSolo = (ev) => {
    const slot = this._store.slotById(ev.detail.slotId);
    const f = globalThis.__foyer;
    if (!slot?.track_id || !f?.ws?.controlSet) return;
    const cur = !!this._getControl(`${slot.track_id}.solo`);
    if (cur) {
      // Toggling off the already-soloed slot.
      f.ws.controlSet(`${slot.track_id}.solo`, false);
      return;
    }
    // Turning ON: clear every other slot's solo first so the cast
    // can never have more than one soloed at a time.
    for (const other of this._store.stage) {
      if (!other.track_id || other.id === slot.id) continue;
      const otherCur = !!this._getControl(`${other.track_id}.solo`);
      if (otherCur) f.ws.controlSet(`${other.track_id}.solo`, false);
    }
    f.ws.controlSet(`${slot.track_id}.solo`, true);
  };
  /** foyer-core stores `controls` as a Map<id, value>; the raw value
   *  IS the value (boolean / number), not `{ value }`. This helper
   *  is the ONLY place that knows that, so the rest of the file
   *  reads from a consistent surface. Returns undefined when the
   *  control hasn't been seen yet. */
  _getControl(id) {
    const f = globalThis.__foyer;
    const c = f?.store?.state?.controls;
    if (!c) return undefined;
    if (typeof c.get === "function") return c.get(id);
    return c[id];
  }
  /** Drop solo on EVERY track in the live session — not just stage
   *  slots. The kid can solo the Mic sidecar or any other track via
   *  the DAW directly, and from Sprunkadoo's POV a click on a
   *  sprunki should always return the mix to full. Walks the
   *  foyer-core controls map (which mirrors the backend) AND the
   *  session tracks list, so we catch every `<track>.solo` entry
   *  regardless of whether the track maps to a stage slot. */
  _clearAllSolo() {
    const f = globalThis.__foyer;
    if (!f?.ws?.controlSet) return;
    const trackIds = new Set();
    for (const t of (f.store?.state?.session?.tracks || [])) {
      if (t?.id) trackIds.add(t.id);
    }
    // Defensive: also walk the controls map in case the snapshot
    // is lagging a fresh track creation but the control already
    // exists. Pattern: "<trackId>.solo". controls is a Map, so we
    // iterate entries — keys aren't enumerable as obj props.
    const controls = f.store?.state?.controls;
    const iterate = controls && typeof controls.forEach === "function"
      ? (fn) => controls.forEach((v, k) => fn(k, v))
      : controls ? (fn) => Object.entries(controls).forEach(([k, v]) => fn(k, v)) : () => {};
    iterate((key, value) => {
      if (!key.endsWith(".solo")) return;
      if (!value) return;
      trackIds.add(key.slice(0, -".solo".length));
    });
    for (const trackId of trackIds) {
      if (this._getControl(`${trackId}.solo`)) {
        f.ws.controlSet(`${trackId}.solo`, false);
      }
    }
  }
  _onStageToggleMute = (ev) => {
    const slot = this._store.slotById(ev.detail.slotId);
    const f = globalThis.__foyer;
    if (!slot?.track_id || !f?.ws?.controlSet) return;
    const cur = !!this._getControl(`${slot.track_id}.mute`);
    f.ws.controlSet(`${slot.track_id}.mute`, !cur);
  };
  _onStageRemoveSlot = (ev) => {
    this._store.removeSlot(ev.detail.slotId);
  };

  /** Mirror foyer-core's `controls` map down to the stage so the
   *  S / M buttons render their active state. Computed from
   *  `slot.track_id → controls[track.X.mute|solo]`. Recomputed
   *  on every Lit render — cheap, the stage has ≤ 7 slots. */
  _slotControlsMap() {
    const out = {};
    for (const slot of this._store.stage) {
      if (!slot.track_id) continue;
      out[slot.id] = {
        solo: !!this._getControl(`${slot.track_id}.solo`),
        muted: !!this._getControl(`${slot.track_id}.mute`),
      };
    }
    return out;
  }

  _onInteriorClose = () => {
    // Solo is a sequencer-editing convenience — the kid solos a
    // sprunki to hear its part in isolation while authoring, then
    // closes the editor expecting the full mix back. Clear all
    // solo flags on close so a stale solo doesn't quietly mute the
    // rest of the cast after the editor is gone.
    this._clearAllSolo();
    this._interiorSlotId = null;
  };
  _onInteriorPatternChange = (ev) => {
    this._patternId = ev.detail.id;
    this._store.setActivePatternId(ev.detail.id);
  };
  _onInteriorStepToggle = (ev) => {
    const { slotId, rowId, step } = ev.detail;
    this._store.toggleCell(slotId, rowId, step);
  };
  _onInteriorToggleSolo = (ev) => {
    // Re-uses the stage's solo handler so the radio-style "only
    // one slot soloed at a time" behaviour is identical.
    this._onStageToggleSolo(ev);
  };
  _onInteriorResetPart = (ev) => {
    const { slotId } = ev.detail;
    const slot = this._store.slotById(slotId);
    if (!slot?.patch_id) return;
    this._store.resetPartToDefault(slotId, this._patternId);
  };
  /** Volume fader in the sequencer interior. Reuses the stage's
   *  Y-as-gain mapping — moves the slot's logical y (which drives
   *  both the on-stage character size and the interior silhouette
   *  scale) and pushes the corresponding dBFS gain to the track. */
  _onInteriorVolumeChange = (ev) => {
    const { slotId, y } = ev.detail;
    const slot = this._store.slotById(slotId);
    if (!slot) return;
    this._store.moveSlot(slotId, slot.x, y);
    const f = globalThis.__foyer;
    if (slot.track_id && f?.ws?.controlSet) {
      f.ws.controlSet(`${slot.track_id}.gain`, levelDb(y));
    }
  };
  _isSoloed(slot) {
    if (!slot?.track_id) return false;
    return !!this._getControl(`${slot.track_id}.solo`);
  }
  /** Reset is only meaningful for the FIRST part in the palette
   *  (`arr.0`) — that's the one whose default we know (the patch's
   *  default board). Later parts were authored from scratch; there
   *  is no "original" to restore. */
  _isFirstPart(partId) {
    const parts = this._store.arrangements || [];
    return parts.length > 0 && parts[0]?.id === partId;
  }

  // ── per-costume FX wiring ─────────────────────────────────────
  /** Resolve the track id that should actually carry FX for this
   *  slot. Audio-ingress patches (Phantom) route through the
   *  shared "Sprunkadoo Mic" sidecar track — that's where the
   *  mic audio actually lives, so autotune / vocoder / reverb
   *  belong on it, NOT on the slot's MIDI track. Every other
   *  patch keeps its FX on its own MIDI track. */
  _fxTrackIdForSlot(slot) {
    if (!slot) return null;
    const patch = slot.patch_id ? getPatch(slot.patch_id) : null;
    if (patch?.accepts_audio_ingress) return this._micTrackId || null;
    return slot.track_id || null;
  }

  /** Compute the set of enabled FX ids for a slot, by intersecting
   *  the slot's effective FX track plugin chain against the FX
   *  catalog. Backend is the source of truth — we don't keep this
   *  in our own state. */
  _enabledFxFor(slot) {
    const trackId = this._fxTrackIdForSlot(slot);
    if (!trackId) return new Set();
    const f = globalThis.__foyer;
    const tracks = f?.store?.state?.session?.tracks || [];
    const track = tracks.find((t) => t?.id === trackId);
    const plugins = track?.plugins || [];
    const out = new Set();
    for (const fx of [...FX_CATALOG, ...INGRESS_ONLY_FX]) {
      const uris = fxUrisFor(fx.id);
      if (plugins.some((p) => uris.includes(p?.uri))) out.add(fx.id);
    }
    return out;
  }

  /** Add or remove the FX plugin on the slot's effective FX track.
   *  Phantom + ingress-only FX target the Sprunkadoo Mic sidecar
   *  track; all other costumes target the slot's own MIDI track. */
  _onInteriorToggleFx = async (ev) => {
    const { slotId, fxId, on } = ev.detail;
    const slot = this._store.slotById(slotId);
    if (!slot) return;
    const f = globalThis.__foyer;
    if (!f?.ws) return;
    const fx = [...FX_CATALOG, ...INGRESS_ONLY_FX].find((x) => x.id === fxId);
    if (!fx) return;

    // Ingress-only FX (autotune / vocoder): ensure the mic
    // sidecar track exists + ingress is rolling before adding the
    // plugin — without an active mic stream the plugin has
    // nothing to process. If the kid denies permission we back
    // the toggle out.
    if (fx.ingress && on) {
      const micId = await this._ensureMicTrack();
      const ok = micId ? await startAudioIngress({ trackId: micId }) : false;
      if (!ok) {
        console.warn("[sprunki] mic permission denied; rolling back FX toggle");
        this.requestUpdate();
        return;
      }
    }
    // Effective track: mic-track for audio-ingress slots, else
    // the slot's own track. Recomputed AFTER _ensureMicTrack
    // because the first ingress FX placement might be what made
    // the mic track exist in the first place.
    const trackId = this._fxTrackIdForSlot(slot);
    if (!trackId) return;
    if (fx.ingress && !on) {
      // Stop ingress only when the last ingress-only FX leaves
      // the chain. Plugin removal happens below.
      const stillNeeded = this._anyIngressOnlyFxStillOn(trackId, fxId);
      if (!stillNeeded) await stopAudioIngress({ trackId });
    }

    const uris = fxUrisFor(fxId);
    const primary = uris[0];
    if (!primary) return;
    if (on) {
      f.ws.send({ type: "add_plugin", track_id: trackId, plugin_uri: primary });
    } else {
      // Find the live plugin id on the effective FX track that
      // matches any of the candidate URIs (we may have landed
      // a fallback).
      const tracks = f?.store?.state?.session?.tracks || [];
      const track = tracks.find((t) => t?.id === trackId);
      const target = (track?.plugins || []).find((p) => uris.includes(p?.uri));
      if (target?.id) {
        f.ws.send({ type: "remove_plugin", track_id: trackId, plugin_id: target.id });
      }
    }
  };

  /** True if any ingress-only FX other than `excludeFxId` is still
   *  in the chain on `trackId`. Drives the "stop ingress when the
   *  last consumer leaves" check — we don't want the browser mic
   *  indicator hanging on after the kid turns off the last
   *  ingress effect. */
  _anyIngressOnlyFxStillOn(trackId, excludeFxId) {
    const f = globalThis.__foyer;
    const tracks = f?.store?.state?.session?.tracks || [];
    const track = tracks.find((t) => t?.id === trackId);
    const plugins = track?.plugins || [];
    return INGRESS_ONLY_FX
      .filter((fx) => fx.id !== excludeFxId)
      .some((fx) => {
        const uris = fxUrisFor(fx.id);
        return plugins.some((p) => uris.includes(p?.uri));
      });
  }

  // ── per-slot instrument override ──────────────────────────────
  /** Swap the GM program on a slot's track. Settings panel uses
   *  this to let parents/older kids pick a different sound under
   *  the same costume — e.g. "I want Mr Sun to play a marimba, not
   *  a piano." Routed through set_track_midi_patch which the shim
   *  picks up as a program-change on the patch's gm_channel. */
  _onSlotInstrumentChange = (ev) => {
    // Legacy per-slot picker, retained for any caller still wiring
    // through it. Per-costume overrides (the Advanced section)
    // route through _onPatchOverrideChange.
    const { slotId, gmProgram, gmChannel } = ev.detail;
    const slot = this._store.slotById(slotId);
    if (!slot?.track_id) return;
    const f = globalThis.__foyer;
    if (!f?.ws) return;
    f.ws.send({
      type: "set_track_midi_patch",
      track_id: slot.track_id,
      channel: gmChannel ?? 0,
      bank: 0,
      program: gmProgram | 0,
    });
  };
  /** Per-costume override fired from the Advanced section. Accepts
   *  either the legacy `{ gmProgram, gmChannel }` shape OR the new
   *  `{ patch }` partial-merge shape (instrument_uri / preset_id /
   *  params). Re-provisions every slot wearing the costume so a
   *  plugin swap actually swaps the plugin chain. */
  _onPatchOverrideChange = (ev) => {
    const { patchId, patch, gmProgram, gmChannel } = ev.detail;
    if (patch !== undefined) {
      // New shape: partial patch (or null to clear entirely).
      this._store.patchOverridePatch(patchId, patch);
    } else {
      // Legacy gmProgram-only call site.
      this._store.setPatchOverride(patchId, gmProgram, gmChannel);
    }
    // Re-apply across every slot wearing this costume. If the
    // override changed the instrument_uri, the slot needs a real
    // re-provision (add new plugin, drop old). Otherwise the
    // program / preset / params can land via the lighter path.
    const touchedPluginUri = patch && (
      Object.prototype.hasOwnProperty.call(patch, "instrument_uri")
    );
    for (const slot of this._store.stage) {
      if (slot.patch_id !== patchId) continue;
      if (touchedPluginUri) {
        // Run the full provision flow so the new plugin lands +
        // the old one is removed.
        const f = globalThis.__foyer;
        provisionOneSlot(f?.store, f?.ws, this._store, slot.id)
          .then(() => this._applyPatchProgramToSlot(slot))
          .catch((err) => console.warn("[sprunki] override re-provision failed:", err));
      } else {
        this._applyPatchProgramToSlot(slot);
      }
    }
  };
  /** Push the EFFECTIVE program (override || patch default) for a
   *  single slot. No-op when the slot has no track or the patch is
   *  programless. ALSO strips any in-region patch_change events
   *  that would re-override the program on every loop wrap — the
   *  Ardour shim seeds a patch_change at tick 0 of every new
   *  region, and on a patch swap that stale event resets the synth
   *  back to the previous patch's program once per loop. Reported
   *  2026-05-26: "the square lead just reset to grand piano after
   *  one loop." */
  _applyPatchProgramToSlot(slot) {
    const f = globalThis.__foyer;
    if (!f?.ws || !slot?.track_id || !slot.patch_id) return;
    const patch = getPatch(slot.patch_id);
    if (!patch) return;
    const eff = this._store.effectivePatchProgram(patch);
    if (!eff || typeof eff.gm_program !== "number") return;
    f.ws.send({
      type: "set_track_midi_patch",
      track_id: slot.track_id,
      channel: eff.gm_channel,
      bank: 0,
      program: eff.gm_program,
    });
    // Wipe in-region patch_changes on this slot's region so the
    // track-level automation lane governs the program. Without this
    // the seeded tick-0 patch_change fires on every loop wrap and
    // resets the program to whatever it was at region-creation time.
    if (slot.region_id) {
      this._wipeRegionPatchChanges(slot.track_id, slot.region_id);
      // Schedule a follow-up sweep — the shim seeds patch_changes
      // on region creation and the snapshot can lag our first read.
      // Also catches any patch_change Ardour writes in response to
      // the set_track_midi_patch above. Mark this region as "wipe
      // it whenever you see a patch_change here" via a watch so we
      // self-heal even if both immediate sweeps miss.
      this._watchRegionForStalePatchChanges(slot.track_id, slot.region_id);
    }
  }
  _wipeRegionPatchChanges(trackId, regionId) {
    const f = globalThis.__foyer;
    if (!f?.ws || !regionId) return;
    const region = this._findRegion(trackId, regionId);
    const stale = region?.patch_changes || [];
    for (const pc of stale) {
      if (pc?.id) {
        f.ws.send({ type: "delete_patch_change", region_id: regionId, patch_change_id: pc.id });
      }
    }
  }
  /** Mark a region as "no in-region patch_changes allowed" for the
   *  next 5 seconds. The session listener checks this set on every
   *  snapshot update and re-fires delete_patch_change for any PC
   *  that materializes in this window. Handles the case where the
   *  shim's create_region seed lands in the snapshot AFTER our
   *  immediate sweep, or Ardour synthesizes a PC in response to a
   *  set_track_midi_patch call. */
  _watchRegionForStalePatchChanges(trackId, regionId) {
    this._wipeRegions ??= new Map();
    this._wipeRegions.set(regionId, { trackId, until: Date.now() + 5000 });
    // Lazy-attach the snapshot listener once.
    if (!this._wipeWatchAttached) {
      this._wipeWatchAttached = true;
      const f = globalThis.__foyer;
      f?.store?.addEventListener?.("change", () => this._sweepWatchedRegions());
    }
    // Also run a couple of explicit timed sweeps so we don't rely
    // solely on snapshot events firing.
    setTimeout(() => this._sweepWatchedRegions(), 250);
    setTimeout(() => this._sweepWatchedRegions(), 1000);
  }
  _sweepWatchedRegions() {
    if (!this._wipeRegions) return;
    const now = Date.now();
    for (const [regionId, entry] of [...this._wipeRegions.entries()]) {
      if (now > entry.until) {
        this._wipeRegions.delete(regionId);
        continue;
      }
      this._wipeRegionPatchChanges(entry.trackId, regionId);
    }
  }
  _findRegion(trackId, regionId) {
    const f = globalThis.__foyer;
    const byTrack = f?.store?.state?.regionsByTrack?.get?.(trackId);
    if (Array.isArray(byTrack)) {
      const r = byTrack.find((rr) => rr?.id === regionId);
      if (r) return r;
    }
    const tracks = f?.store?.state?.session?.tracks || [];
    const t = tracks.find((tr) => tr?.id === trackId);
    return (t?.regions || []).find((rr) => rr?.id === regionId) || null;
  }
  /** Re-apply the effective program for every stage slot holding
   *  this costume. Used when a per-costume override changes — all
   *  slots playing that patch flip to the new program at once. */
  _applyPatchProgramToAllSlotsWith(patchId) {
    for (const slot of this._store.stage) {
      if (slot.patch_id === patchId) this._applyPatchProgramToSlot(slot);
    }
  }
  /** Patch swap from the Advanced section. Clears the slot when
   *  patchId is null; assigns otherwise. Uses the same store calls
   *  the on-stage drag does so the patch lifecycle (board seed,
   *  ingress reconcile, layout push) all run as if the kid had
   *  dragged it from the palette. */
  _onSlotPatchChange = (ev) => {
    const { slotId, patchId } = ev.detail;
    if (!patchId) {
      this._store.clearSlot(slotId);
      return;
    }
    this._store.assignPatch(slotId, patchId);
  };

  _onKeyChange = (ev) => { this._store.setKey(ev.detail); };
  _onProgressionChange = (ev) => { this._store.setProgression(ev.detail.progressionId); };
  _onChordChange = (ev) => {
    const { patternId, chord } = ev.detail;
    this._store.setChordFor(patternId, chord);
  };
  /** Any arrangement edit changes the layout's patterns[] +
   *  arrangement[] (or the audible total length), so:
   *   1. Re-pin the loop range to the new total song length.
   *   2. Re-push every slot's SequencerLayout — the bridge
   *      builds patterns from the chip list, so add / remove /
   *      resize / recolor all need a fresh push.
   *   3. requestUpdate — repaint dots + chip strip.
   *  "active-changed" is a UI-only switch (the layout already
   *  contains every chip's pattern; we just refocus the
   *  editor), so we still requestUpdate but skip the layout
   *  push. */
  _onArrangementsChanged = (ev) => {
    const kind = ev?.detail?.kind;
    const f = globalThis.__foyer;
    // Anything that changes the audible song needs a fresh layout
    // push + loop re-pin. Adding/removing/resizing/reordering a
    // PART changes the patterns table; mutating the TIMELINE
    // changes the arrangement[] schedule; both reach the backend
    // through the same set_sequencer_layout call.
    const audibleChange =
      kind === "added" || kind === "removed" ||
      kind === "resized" || kind === "reordered" ||
      kind === "timeline-added" || kind === "timeline-removed" ||
      kind === "timeline-set" || kind === "timeline-moved";
    if (audibleChange) {
      this._pinLoopToActiveSelection();
      if (f?.ws) {
        this._pendingPushAll = true;
        this._scheduleLayoutPush();
      }
    }
    // The kid's selection moved (clicked a different stage dot or
    // tapped "play all"). Audio doesn't change in patterns/arrangement
    // shape — only the loop range. Re-pin without re-pushing layouts.
    if (kind === "active-position-changed") {
      this._pinLoopToActiveSelection();
    }
    this._rev++;
    this.requestUpdate();
  };

  // Style picker — popover in the toolbar emits `style-picked`. The
  // store's applyStyle is edit-respecting: every slot whose boards
  // still match the patch default gets the style cast; customized
  // slots survive. BPM + chord progression apply globally regardless.
  // No confirm modal — the destructive case is gone.
  _onStylePicked = (ev) => {
    const styleId = ev.detail?.styleId;
    const style = getStyle(styleId);
    if (!style) return;
    const summary = this._store.applyStyle(style);
    if (!summary) return;
    this._activeStyleId = style.id;
    if (typeof style.bpm === "number" && style.bpm > 0) {
      this._applyTempoDebounced(style.bpm);
    }
    console.info(
      `[sprunki] style "${style.label}" — changed ${summary.changed}/${summary.total} slot(s), ` +
      `kept ${summary.skipped} user-edited slot(s)`,
    );
  };

  _selectPattern(id) {
    this._patternId = id;
    this._store.setActivePatternId(id);
  }
  _onClearPattern() {
    this._store.clearActivePattern();
  }

  // ── top-toolbar handlers ──────────────────────────────────────────
  _onFlagStart = () => {
    this._startAlwaysOnLoop();
  };
  _onPause = () => {
    const f = globalThis.__foyer;
    f?.ws?.controlSet?.("transport.playing", false);
  };
  _onStopReset = () => {
    const f = globalThis.__foyer;
    if (!f?.ws) return;
    f.ws.controlSet?.("transport.playing", false);
    f.ws.controlSet?.("transport.position", 0);
  };

  /** Horizontal BPM slider — pointer drag changes tempo across
   *  the full 40..300 range. Sliding either axis works (kids often
   *  go vertical with horizontal sliders by mistake). The change
   *  is debounced through `_applyTempoDebounced` so a rapid drag
   *  doesn't thrash the audio engine with hundreds of tempo
   *  recalculations. The slider track is keyed to viewport width;
   *  we measure on pointerdown and use that as the per-px scale. */
  _onBpmPointerDown = (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    const el = e.currentTarget;
    const track = el.querySelector(".bpm-track");
    const rect = track.getBoundingClientRect();
    el.setPointerCapture?.(e.pointerId);
    el.classList.add("dragging");
    const apply = (clientX) => {
      const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const bpm = Math.round(40 + t * 260);
      this._applyTempoDebounced(bpm);
      this._rev++;
      this.requestUpdate();
    };
    apply(e.clientX);
    const move = (ev) => apply(ev.clientX);
    const up = (ev) => {
      el.releasePointerCapture?.(ev.pointerId);
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // ── render ────────────────────────────────────────────────────
  _renderStatus() {
    if (this._status === "wait-ws") return "Connecting to Foyer…";
    if (this._status === "provisioning") return "Setting up your stage…";
    if (this._status === "error") return this._error;
    return "";
  }

  /** Total length of the song in bars — sum of every TIMELINE
   *  entry's length, looking up each entry's part by id. */
  _totalSongBars() {
    const parts = this._store.arrangements || [];
    const timeline = this._store.timeline || [];
    if (!parts.length || !timeline.length) return LOOP_BARS;
    const byId = new Map(parts.map((p) => [p.id, p]));
    return timeline.reduce((sum, partId) => {
      const part = byId.get(partId);
      return sum + (part?.length_bars || 0);
    }, 0) || LOOP_BARS;
  }

  /** Bar range [startBar, endBar) currently selected for looping.
   *  When the active timeline position is "all", returns the
   *  whole song; otherwise returns just the bar window owned by
   *  that timeline entry. */
  _activeLoopBars() {
    const parts = this._store.arrangements || [];
    const timeline = this._store.timeline || [];
    const pos = this._store.activeTimelinePosition;
    const byId = new Map(parts.map((p) => [p.id, p]));
    const cursor = (untilIdx) => {
      let bars = 0;
      for (let i = 0; i < untilIdx && i < timeline.length; i++) {
        bars += (byId.get(timeline[i])?.length_bars || 0);
      }
      return bars;
    };
    const total = this._totalSongBars();
    if (pos === "all" || !Number.isInteger(pos)) {
      return { startBar: 0, endBar: total };
    }
    const startBar = cursor(pos);
    const myLen = (byId.get(timeline[pos])?.length_bars || 0);
    return { startBar, endBar: startBar + (myLen || 0) };
  }

  /** Color-dot picker. One dot per TIMELINE entry (so a part that
   *  appears multiple times shows multiple dots), followed by a
   *  visible divider and the play-all button. Tap a dot to loop
   *  just that part's bar window; tap the play-all to loop the
   *  whole song.
   *
   *  Hidden entirely when the timeline has only one entry — the
   *  kid sees the default single-loop UI clutter-free until they
   *  build a multi-part song. */
  _renderArrangementDots() {
    const parts = this._store.arrangements;
    const timeline = this._store.timeline;
    if (!parts || !timeline || timeline.length <= 1) return "";
    const activePos = this._store.activeTimelinePosition;
    const byId = new Map(parts.map((p) => [p.id, p]));
    return html`
      <div class="arrangement-dots" role="tablist" aria-label="Pick part">
        ${timeline.map((partId, idx) => {
          const part = byId.get(partId);
          if (!part) return "";
          const isActive = activePos === idx;
          return html`
            <button
              class="arrangement-dot ${isActive ? "active" : ""}"
              style="--dc: ${part.color}"
              title=${`Loop this part (${part.length_bars} bar${part.length_bars === 1 ? "" : "s"})`}
              aria-selected=${isActive ? "true" : "false"}
              @click=${() => this._store.setActiveTimelinePosition(idx)}
            ></button>
          `;
        })}
        <span class="arrangement-divider" aria-hidden="true"></span>
        <button
          class="arrangement-all ${activePos === "all" ? "active" : ""}"
          title="Play the whole arrangement"
          aria-selected=${activePos === "all" ? "true" : "false"}
          @click=${() => this._store.setActiveTimelinePosition("all")}
        >▶</button>
      </div>
    `;
  }

  render() {
    if (this._status === "asset-prompt") {
      return html`
        <div class="sprunki-bootscreen"></div>
        <sprunki-asset-pack-modal
          .pack=${this._sprunkiPack}
          @consent=${this._onAssetConsent}
          @skip=${this._onAssetSkip}
          @close=${this._onAssetClose}
        ></sprunki-asset-pack-modal>
      `;
    }
    if (this._status === "backend-lost") {
      return html`
        <div class="sprunki-bootscreen sprunki-error-screen">
          <div class="sprunki-error-card">
            <div class="sprunki-error-title">The audio engine took a tumble</div>
            <div class="sprunki-error-detail">${this._error}</div>
            <button class="sprunki-error-retry" @click=${this._onRetryBackend}>
              Try again
            </button>
          </div>
        </div>
      `;
    }
    if (this._status !== "ready") {
      return html`<div class="sprunki-bootscreen">${this._renderStatus()}</div>`;
    }

    const stage = this._store.stage;
    const interiorSlot = this._interiorSlotId
      ? stage.find((s) => s.id === this._interiorSlotId) || null
      : null;

    const bpm = Math.round(Number(globalThis.__foyer?.store?.get?.("transport.tempo")) || DEFAULT_BPM);
    const playing = !!globalThis.__foyer?.store?.get?.("transport.playing");

    return html`
      <div class="sprunki-toolbar">
        <button
          class="toolbar-glyph flag ${playing ? 'active' : ''}"
          title="Start"
          @click=${this._onFlagStart}
        >${GLYPHS.flag}</button>
        <button
          class="toolbar-glyph pause"
          title="Pause"
          @click=${this._onPause}
        >${GLYPHS.pause}</button>
        <button
          class="toolbar-glyph stop"
          title="Stop &amp; reset"
          @click=${this._onStopReset}
        >${GLYPHS.stop}</button>

        <div class="bpm-pill"
             title="Drag to change tempo (40–300 BPM)"
             @pointerdown=${this._onBpmPointerDown}>
          <div class="bpm-track">
            <div class="bpm-thumb" style="left: ${((bpm - 40) / 260 * 100).toFixed(1)}%;"></div>
          </div>
          <div class="bpm-value">${bpm}</div>
        </div>

        <sprunkadoo-style-picker
          .activeStyleId=${this._activeStyleId}
          @style-picked=${this._onStylePicked}
        ></sprunkadoo-style-picker>

        <button
          class="toolbar-glyph arrange"
          title="Arrange — build a longer song"
          @click=${() => { this._arrangerOpen = true; this.requestUpdate(); }}
        >${GLYPHS.arrange}</button>

        ${this._renderArrangementDots()}

        <button
          class="toolbar-glyph hamburger"
          title="Settings"
          @click=${() => { this._prefsOpen = true; this.requestUpdate(); }}
        >${GLYPHS.hamburger}</button>
      </div>
      <div class="sprunki-main">
        <sprunki-stage
          .slots=${stage}
          .activeArrangementId=${this._store.activeArrangementId}
          .assetsReady=${this._sprunkiAssetsReady}
          .scaryMode=${this._store.scaryMode}
          .slotControls=${this._slotControlsMap()}
          @stage-move=${this._onStageMove}
          @stage-assign-patch=${this._onStageAssignPatch}
          @stage-spawn=${this._onStageSpawn}
          @stage-clear=${this._onStageClear}
          @stage-click-slot=${this._onStageClickSlot}
          @stage-toggle-solo=${this._onStageToggleSolo}
          @stage-toggle-mute=${this._onStageToggleMute}
          @stage-remove-slot=${this._onStageRemoveSlot}
        ></sprunki-stage>
      </div>
      <sprunki-patch-palette
        .assetsReady=${this._sprunkiAssetsReady}
        .usedPatchIds=${new Set(stage.map((s) => s.patch_id).filter(Boolean))}
      ></sprunki-patch-palette>
      ${interiorSlot ? html`
        <sprunki-interior
          .slot=${interiorSlot}
          .patternId=${this._patternId}
          .assetsReady=${this._sprunkiAssetsReady}
          .enabledFx=${this._enabledFxFor(interiorSlot)}
          .soloed=${this._isSoloed(interiorSlot)}
          .canReset=${this._isFirstPart(this._patternId)}
          @interior-close=${this._onInteriorClose}
          @interior-pattern-change=${this._onInteriorPatternChange}
          @interior-step-toggle=${this._onInteriorStepToggle}
          @interior-toggle-fx=${this._onInteriorToggleFx}
          @interior-toggle-solo=${this._onInteriorToggleSolo}
          @interior-reset-part=${this._onInteriorResetPart}
          @interior-volume-change=${this._onInteriorVolumeChange}
        ></sprunki-interior>
      ` : ""}
      ${this._prefsOpen ? html`
        <sprunki-preferences-modal
          .sprunkiPack=${this._sprunkiPack}
          @close=${() => { this._prefsOpen = false; this.requestUpdate(); }}
          @request-parental-gate=${() => { this._parentalGateOpen = true; this.requestUpdate(); }}
          @key-change=${this._onKeyChange}
          @progression-change=${this._onProgressionChange}
          @chord-change=${this._onChordChange}
          @slot-instrument-change=${this._onSlotInstrumentChange}
          @slot-patch-change=${this._onSlotPatchChange}
          @patch-override-change=${this._onPatchOverrideChange}
        ></sprunki-preferences-modal>
      ` : ""}
      ${this._arrangerOpen ? html`
        <sprunkadoo-arrangement-modal
          @close=${() => { this._arrangerOpen = false; this.requestUpdate(); }}
        ></sprunkadoo-arrangement-modal>
      ` : ""}
      ${this._parentalGateOpen ? html`
        <sprunki-parental-gate-modal
          @close=${() => { this._parentalGateOpen = false; this.requestUpdate(); }}
          @unlocked=${() => { this._parentalGateOpen = false; this.requestUpdate(); }}
        ></sprunki-parental-gate-modal>
      ` : ""}
    `;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

customElements.define("sprunki-app", SprunkiApp);
