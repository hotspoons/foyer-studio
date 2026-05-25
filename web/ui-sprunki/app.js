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
import "./components/chord-strip.js";
import "./components/sprunki-stage.js";
import "./components/patch-palette.js";
import "./components/sprunki-interior.js";
import "./components/transport-bar.js";
import "./components/preferences-modal.js";
import "./components/parental-gate-modal.js";
import "./components/asset-pack-modal.js";
import { DEFAULT_PATTERNS } from "./components/sound-catalog.js";
import { sprunkiStore } from "./state-store.js";
import { ensureSprunkiStage } from "./setup.js";
import { pushAllLayouts, pushSlotLayout } from "./sequencer-bridge.js";
import { loadSprunkiManifest, probeAssetBase, invalidateAssetBase } from "./sprunki-assets.js";
import { levelDb } from "./components/sprunki-stage.js";

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
    const ws = globalThis.__foyer?.ws;
    if (ws && this._wsListener) ws.removeEventListener("envelope", this._wsListener);
  }

  // ── WS subscription / asset pack flow ─────────────────────────
  _subscribeWs() {
    const ws = globalThis.__foyer?.ws;
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
      }
    };
    ws.addEventListener("envelope", this._wsListener);
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
    if (ws) ws.send({ type: "list_asset_packs" });
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
    await ensureSprunkiStage(f.store, f.ws, this._store);
    pushAllLayouts(f.ws, this._store.stage, this._harmony());
    const tempo = f.store.get?.("transport.tempo");
    if (!tempo || Number(tempo) <= 0) {
      f.ws.controlSet?.("transport.tempo", 120);
    }
    this._status = "ready";
    this.requestUpdate();
  }

  _fail(err) {
    console.error("[sprunki] boot failed:", err);
    this._status = "error";
    this._error = String(err?.message || err);
    this.requestUpdate();
  }

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
    if (kind === "assigned" || kind === "cleared" || kind === "spawned") {
      // Patch assignment changed: re-provision (to land the new
      // instrument plugin if needed) and re-push the layout.
      ensureSprunkiStage(f?.store, f?.ws, this._store)
        .then(() => pushAllLayouts(f?.ws, this._store.stage, this._harmony()))
        .catch((err) => console.warn("[sprunki] re-provision failed:", err));
    } else {
      // Default (removed, etc.) — just re-push.
      if (f?.ws) pushAllLayouts(f.ws, this._store.stage, this._harmony());
    }
    this._rev++;
    this.requestUpdate();
  };

  _onBoardChanged = (ev) => {
    const f = globalThis.__foyer;
    if (!f?.ws) { this._rev++; this.requestUpdate(); return; }
    const slotId = ev?.detail?.slotId;
    if (slotId) {
      const slot = this._store.slotById(slotId);
      if (slot) pushSlotLayout(f.ws, slot, this._harmony());
    } else {
      pushAllLayouts(f.ws, this._store.stage, this._harmony());
    }
    this._rev++;
    this.requestUpdate();
  };

  _onHarmonyChanged = () => {
    const f = globalThis.__foyer;
    if (f?.ws) pushAllLayouts(f.ws, this._store.stage, this._harmony());
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
    const { slotId, patchId } = ev.detail;
    this._store.assignPatch(slotId, patchId);
  };
  _onStageSpawn = (ev) => {
    const { x, y, patchId } = ev.detail;
    this._store.spawnSlot(x, y, patchId);
  };
  _onStageClear = (ev) => {
    this._store.clearSlot(ev.detail.slotId);
  };
  _onStageClickSlot = (ev) => {
    this._interiorSlotId = ev.detail.slotId;
  };
  /** Per-sprunki S / M / × ribbon. Solo + mute are pure DAW
   *  control_set on the slot's backend track — local visual
   *  state echoes from foyer-core's `controls` map on the next
   *  ControlUpdate. Delete = remove the slot from the stage
   *  entirely (different from clear-X which keeps the empty
   *  performer). */
  _onStageToggleSolo = (ev) => {
    const slot = this._store.slotById(ev.detail.slotId);
    const f = globalThis.__foyer;
    if (!slot?.track_id || !f?.ws?.controlSet) return;
    const cur = !!f.store?.state?.controls?.[`${slot.track_id}.solo`]?.value;
    f.ws.controlSet(`${slot.track_id}.solo`, !cur);
  };
  _onStageToggleMute = (ev) => {
    const slot = this._store.slotById(ev.detail.slotId);
    const f = globalThis.__foyer;
    if (!slot?.track_id || !f?.ws?.controlSet) return;
    const cur = !!f.store?.state?.controls?.[`${slot.track_id}.mute`]?.value;
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
    const f = globalThis.__foyer;
    const ctrl = f?.store?.state?.controls || {};
    const out = {};
    for (const slot of this._store.stage) {
      if (!slot.track_id) continue;
      out[slot.id] = {
        solo: !!ctrl[`${slot.track_id}.solo`]?.value,
        muted: !!ctrl[`${slot.track_id}.mute`]?.value,
      };
    }
    return out;
  }

  _onInteriorClose = () => {
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

  _onKeyChange = (ev) => { this._store.setKey(ev.detail); };
  _onProgressionChange = (ev) => { this._store.setProgression(ev.detail.progressionId); };
  _onChordChange = (ev) => {
    const { patternId, chord } = ev.detail;
    this._store.setChordFor(patternId, chord);
  };

  _selectPattern(id) {
    this._patternId = id;
    this._store.setActivePatternId(id);
  }
  _onClearPattern() {
    this._store.clearActivePattern();
  }

  // ── render ────────────────────────────────────────────────────
  _renderStatus() {
    if (this._status === "wait-ws") return "🔌 Connecting to Foyer…";
    if (this._status === "provisioning") return "🎛 Setting up your stage…";
    if (this._status === "error") return `⚠ ${this._error}`;
    return "";
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
    if (this._status !== "ready") {
      return html`<div class="sprunki-bootscreen">${this._renderStatus()}</div>`;
    }

    const stage = this._store.stage;
    const interiorSlot = this._interiorSlotId
      ? stage.find((s) => s.id === this._interiorSlotId) || null
      : null;

    return html`
      <div class="sprunki-header">
        <div class="sprunki-title">🎵 Sprunki Beats</div>
        <div class="sprunki-pattern-tabs">
          ${DEFAULT_PATTERNS.map((pat) => html`
            <button
              class="sprunki-pattern-tab ${this._patternId === pat.id ? 'active' : ''}"
              style="--tab-color: ${pat.color}"
              @click=${() => this._selectPattern(pat.id)}
            >${pat.name}</button>
          `)}
        </div>
        <div class="sprunki-toolbar">
          <button class="sprunki-icon-btn" title="Clear this section's loops" @click=${this._onClearPattern}>🧹</button>
          <button class="sprunki-icon-btn" title="Preferences" @click=${() => { this._prefsOpen = true; this.requestUpdate(); }}>⚙</button>
        </div>
      </div>
      <sprunki-chord-strip
        .musicKey=${this._store.key}
        .sectionChords=${this._store.sectionChords}
        .activePatternId=${this._patternId}
        .progressionId=${this._store.progressionId}
        @key-change=${this._onKeyChange}
        @progression-change=${this._onProgressionChange}
        @chord-change=${this._onChordChange}
      ></sprunki-chord-strip>
      <div class="sprunki-main">
        <sprunki-stage
          .slots=${stage}
          .assetsReady=${this._sprunkiAssetsReady}
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
      <div class="sprunki-footer">
        <sprunki-transport-bar
          .ids=${{}}
          .patternId=${this._patternId}
        ></sprunki-transport-bar>
      </div>
      ${interiorSlot ? html`
        <sprunki-interior
          .slot=${interiorSlot}
          .patternId=${this._patternId}
          .assetsReady=${this._sprunkiAssetsReady}
          @interior-close=${this._onInteriorClose}
          @interior-pattern-change=${this._onInteriorPatternChange}
          @interior-step-toggle=${this._onInteriorStepToggle}
        ></sprunki-interior>
      ` : ""}
      ${this._prefsOpen ? html`
        <sprunki-preferences-modal
          @close=${() => { this._prefsOpen = false; this.requestUpdate(); }}
          @request-parental-gate=${() => { this._parentalGateOpen = true; this.requestUpdate(); }}
        ></sprunki-preferences-modal>
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
