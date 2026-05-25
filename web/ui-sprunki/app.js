// Sprunki App — top-level shell.
//
// Responsibilities (boot order):
//   1. Wait for foyer-core's WS + store to be alive.
//   2. Provision the 5 category MIDI tracks + regions + instruments
//      (ensureSprunkiBoard). Cached in localStorage so the second
//      launch skips the round-trip.
//   3. Ship the saved boards as sequencer layouts so existing work
//      is restored on the backend side too.
//   4. Render the player UI.
//
// All player-authored state (boards, pattern selection, transport
// prefs, instrument prefs) lives in `sprunkiStore` and survives a
// page reload. The backend track/region ids are cached but
// invalidated automatically when the active backend swaps.

import { LitElement, html } from "lit";
import { appStyles } from "./styles.js";
import "./components/character-board.js";
import "./components/transport-bar.js";
import "./components/preferences-modal.js";
import "./components/parental-gate-modal.js";
import "./components/asset-pack-modal.js";
import { DEFAULT_PATTERNS, DEFAULT_RESOLUTION, getCharacter, CATEGORIES } from "./components/sound-catalog.js";
import { sprunkiStore } from "./state-store.js";
import { ensureSprunkiBoard } from "./setup.js";
import { pushAllLayouts, pushCategoryLayout } from "./sequencer-bridge.js";
import { loadSprunkiManifest, probeAssetBase, invalidateAssetBase } from "./sprunki-assets.js";

const ASSET_PACK_NAME = "sprunki";

export class SprunkiApp extends LitElement {
  static styles = appStyles;

  static properties = {
    _status: { type: String, state: true },    // "wait-ws" | "asset-prompt" | "provisioning" | "ready" | "error"
    _error: { type: String, state: true },
    _patternId: { type: String, state: true },
    _prefsOpen: { type: Boolean, state: true },
    _parentalGateOpen: { type: Boolean, state: true },
    /** Latest `AssetPackInfo` for the sprunki pack — drives the
     *  consent / progress modal and decides whether to boot the
     *  game without it (skip path) or wait. */
    _sprunkiPack: { type: Object, state: true },
    /** True once the OG sprunki SVG art has been downloaded AND we
     *  have probed which `/asset-packs/sprunki/...` prefix the
     *  server is exposing. Flipping this swaps the character board
     *  from emoji placeholders to real SVG art. */
    _sprunkiAssetsReady: { type: Boolean, state: true },
    // Bumped on every store-change so Lit re-renders the board. Boards
    // themselves live on sprunkiStore, not as Lit props.
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
    this._rev = 0;
    this._ids = {};
    this._storeListener = () => { this._rev++; this.requestUpdate(); };
  }

  connectedCallback() {
    super.connectedCallback();
    this._store.addEventListener("board-changed", this._onBoardChanged);
    this._store.addEventListener("pattern-changed", this._storeListener);
    this._store.addEventListener("transport-changed", this._storeListener);
    this._store.addEventListener("prefs-changed", this._onPrefsChanged);
    this._store.addEventListener("tracks-invalidated", this._onTracksInvalidated);
    this._store.addEventListener("parental-changed", this._storeListener);
    this._store.addEventListener("scary-mode-changed", this._storeListener);
    this._waitForWs().then(() => this._afterWs()).catch((err) => this._fail(err));
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._store.removeEventListener("board-changed", this._onBoardChanged);
    this._store.removeEventListener("pattern-changed", this._storeListener);
    this._store.removeEventListener("transport-changed", this._storeListener);
    this._store.removeEventListener("prefs-changed", this._onPrefsChanged);
    this._store.removeEventListener("tracks-invalidated", this._onTracksInvalidated);
    this._store.removeEventListener("parental-changed", this._storeListener);
    this._store.removeEventListener("scary-mode-changed", this._storeListener);
    const ws = globalThis.__foyer?.ws;
    if (ws && this._wsListener) ws.removeEventListener("envelope", this._wsListener);
  }

  /** Subscribe to AssetPackList / AssetPackUpdated events and route
   *  the sprunki pack updates through `_handleSprunkiPackUpdate`. */
  _subscribeAssetPackEvents() {
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
      }
    };
    ws.addEventListener("envelope", this._wsListener);
  }

  _handleSprunkiPackUpdate(info) {
    this._sprunkiPack = info;
    // If we were paused on the consent prompt and the user
    // hit "Skip", we don't get a transition — the modal records
    // consent and the gate falls through to provisioning anyway.
    // For the live download path: when state flips to "ready"
    // AND we're still in the asset-prompt state, advance to
    // provisioning.
    if (this._status === "asset-prompt" && info.state === "ready") {
      this._advanceToProvisioning();
    }
    // Asset-pack lifecycle ↔ SVG art availability: when the pack
    // flips to ready, load the manifest + probe the served prefix
    // so the character board can swap from emoji to real artwork.
    // When the pack flips back (deleted / errored), drop the flag
    // so the next probe re-runs.
    if (info.state === "ready" && !this._sprunkiAssetsReady) {
      this._initSprunkiAssets().catch((e) => {
        console.warn("[sprunki] asset prep failed (board stays on emoji):", e);
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
    } else {
      console.warn("[sprunki] manifest loaded but couldn't find an asset-pack base URL");
    }
  }

  _advanceToProvisioning() {
    this._status = "provisioning";
    this.requestUpdate();
    this._bootStage().catch((err) => this._fail(err));
  }

  /** Two-step boot: ensure an Ardour session is loaded (auto-spawn
   *  a scratch one if needed), then run the existing track/region/
   *  layout provisioning. The scratch session swap is what makes
   *  the active backend flip from launcher-stub to HostBackend, so
   *  this needs to land BEFORE `_boot()` — the stub can't render
   *  audio. The session id is stable across reloads (we always
   *  reuse the same jail-relative path), so foyer-cli's
   *  bootstrap-if-missing helper only fires on the very first
   *  launch. */
  async _bootStage() {
    await this._ensureSessionLoaded();
    await this._boot();
  }

  async _ensureSessionLoaded() {
    const f = globalThis.__foyer;
    // Fast path: a heavyweight (Ardour) backend is already up. The
    // greeting tells us this directly — `engine_is_dummy === false`
    // means the active backend produces real audio. (The launcher
    // stub answers true.)
    if (f.store?.state?.greeting?.engine_is_dummy === false) return;

    // Listen for `session_opened` or `backend_swapped` events —
    // those are the authoritative signals the server emits when
    // the active backend changes. Previously we relied on a
    // track-id heuristic, but Ardour's track IDs ALSO start with
    // `track.` (e.g. `track.179`), so the heuristic spuriously
    // matched the stub and the wait short-circuited every time.
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
      // Bound the wait so we don't hang the picker forever. Ardour
      // cold-start with a full LV2 scan can be 30-45 s in a fresh
      // container; we wait up to 90 s before giving up.
      setTimeout(() => {
        ws.removeEventListener("envelope", handler);
        resolve(false);
      }, 90_000);
    });

    console.info("[sprunki] launching scratch Ardour session for audio backend");
    f.ws.send({
      type: "launch_project",
      backend_id: "ardour",
      project_path: "sprunki-scratch",
    });

    const ok = await opened;
    if (!ok) {
      // Soft failure — fall through to provisioning even if Ardour
      // didn't come up. The launcher-stub backend supports
      // create_region (we added that earlier), so tracks/regions
      // still provision and the user can author beats — they just
      // won't hear sound until Ardour comes online.
      console.warn("[sprunki] scratch session never reported open in 90 s — continuing with launcher stub");
      return;
    }
    // Give the snapshot a beat to land after the swap so subsequent
    // create_track calls hit the new backend, not the stub.
    await sleep(500);
  }

  async _afterWs() {
    this._subscribeAssetPackEvents();
    // The greeting-time `AssetPackList` fires before we got a
    // chance to subscribe (foyer-core already drained the
    // envelope by the time our listener attached). Re-request to
    // get a fresh blob into our listener's hands. Server-side
    // this is a cheap snapshot read with no side effects.
    const ws = globalThis.__foyer?.ws;
    if (ws) ws.send({ type: "list_asset_packs" });
    // Wait up to 2 s for the response to land. On a warm WS this
    // is a single tick; the extra budget covers the occasional
    // dev-container packet jitter.
    for (let i = 0; i < 40; i++) {
      if (this._sprunkiPack) break;
      await sleep(50);
    }
    if (!this._sprunkiPack
        || this._sprunkiPack.state === "ready"
        || this._store.sprunkiAssetConsentRecorded) {
      // Either the assets are already on disk, or the user
      // previously chose Skip — either way, proceed to
      // provisioning. The game still works without the sprunki
      // visuals; later UI passes layer them in when present.
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
    // Optimistic local update so the modal swaps to the progress
    // view immediately, instead of waiting for the first
    // server-side AssetPackUpdated event.
    this._sprunkiPack = { ...(this._sprunkiPack || {}), state: "downloading", progress: 0 };
    this.requestUpdate();
  };

  _onAssetSkip = () => {
    this._store.recordSprunkiAssetConsent();
    this._advanceToProvisioning();
  };

  _onAssetClose = () => {
    // Stuck-on-error close: treat as skip so the user can still
    // use the game without sprunki visuals.
    this._onAssetSkip();
  };

  _onBoardChanged = (ev) => {
    // Ship only the changed category's layout if we know which one,
    // otherwise (pattern clear) ship them all.
    const charId = ev.detail?.charId;
    const ws = globalThis.__foyer?.ws;
    if (ws && Object.keys(this._ids).length > 0) {
      if (charId) {
        const cat = getCharacter(charId)?.category;
        if (cat) {
          pushCategoryLayout(ws, this._ids, this._store.snapshot().boards, cat);
        } else {
          pushAllLayouts(ws, this._ids, this._store.snapshot().boards);
        }
      } else {
        pushAllLayouts(ws, this._ids, this._store.snapshot().boards);
      }
    }
    this._rev++;
    this.requestUpdate();
  };

  _onPrefsChanged = (ev) => {
    // Instrument or program changed for a category. Re-apply by
    // sending an `update_plugin_param` + `set_track_patch_change`
    // pair through the bridge. (For now we just nudge the GM
    // program via a fresh track — until the bridge supports
    // mid-flight plugin swaps the cleanest UX is to invalidate
    // tracks and re-provision.)
    const cat = ev.detail?.categoryId;
    if (!cat) return;
    this._reapplyPrefs(cat);
  };

  _onTracksInvalidated = () => {
    // Backend swap or explicit reset wiped our cached track ids.
    // Re-provision from scratch — the player's boards survive
    // because they live in localStorage independently.
    this._ids = {};
    this._status = "provisioning";
    this.requestUpdate();
    this._boot().catch((err) => this._fail(err));
  };

  async _waitForWs() {
    for (let i = 0; i < 100; i++) {
      const f = globalThis.__foyer;
      if (f?.ws && f?.store?.state?.status === "open") return;
      await sleep(150);
    }
    throw new Error("Foyer WS never came up (after 15 s)");
  }

  async _boot() {
    try {
      this._status = "provisioning";
      this.requestUpdate();
      const f = globalThis.__foyer;
      this._ids = await ensureSprunkiBoard(f.store, f.ws, this._store);
      // Ship the saved boards as the initial layouts so notes
      // round-trip into the regions before the user touches a cell.
      pushAllLayouts(f.ws, this._ids, this._store.snapshot().boards);
      // Seed transport tempo if missing.
      const tempo = f.store.get?.("transport.tempo");
      if (!tempo || Number(tempo) <= 0) {
        f.ws.controlSet?.("transport.tempo", 120);
      }
      this._status = "ready";
      this.requestUpdate();
    } catch (e) {
      this._fail(e);
    }
  }

  _fail(err) {
    console.error("[sprunki] boot failed:", err);
    this._status = "error";
    this._error = String(err?.message || err);
    this.requestUpdate();
  }

  async _reapplyPrefs(categoryId) {
    // For now: invalidate the cached track for this category and
    // re-provision. Cheaper alternative would be patching the live
    // track in place, but that needs UpdateTrack + a plugin-param
    // path the bridge doesn't expose cleanly. Re-provisioning is
    // visible to the user (new track appears in Ardour) and is the
    // simpler shipping point.
    this._store.setTracks(categoryId, { track_id: null, region_id: null });
    this._ids = {};
    this._status = "provisioning";
    this.requestUpdate();
    try {
      const f = globalThis.__foyer;
      this._ids = await ensureSprunkiBoard(f.store, f.ws, this._store);
      pushAllLayouts(f.ws, this._ids, this._store.snapshot().boards);
      this._status = "ready";
      this.requestUpdate();
    } catch (e) {
      this._fail(e);
    }
  }

  _selectPattern(id) {
    this._patternId = id;
    this._store.setActivePatternId(id);
  }

  _onStepToggle(e) {
    const { charId, stepIndex } = e.detail;
    this._store.toggleCell(this._patternId, charId, stepIndex);
  }
  _onClearPattern() {
    this._store.clearPattern(this._patternId);
    // Push all so every category drops the cleared pattern's cells.
    const f = globalThis.__foyer;
    if (f?.ws) pushAllLayouts(f.ws, this._ids, this._store.snapshot().boards);
  }

  _currentBoard() {
    return this._store.snapshot().boards[this._patternId] || {};
  }

  _renderStatus() {
    if (this._status === "wait-ws") return "🔌 Connecting to Foyer…";
    if (this._status === "provisioning") return "🎛 Setting up your stage…";
    if (this._status === "error") return `⚠ ${this._error}`;
    return "";
  }

  render() {
    // Asset-pack consent or active download takes precedence over
    // every other view — the kid sees nothing else until either
    // assets are local or the parent picked Skip.
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
      return html`
        <div class="sprunki-bootscreen">${this._renderStatus()}</div>
      `;
    }
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
          <button class="sprunki-icon-btn" title="Clear this pattern" @click=${this._onClearPattern}>🧹</button>
          <button class="sprunki-icon-btn" title="Preferences" @click=${() => { this._prefsOpen = true; this.requestUpdate(); }}>⚙</button>
        </div>
      </div>
      <div class="sprunki-main">
        <sprunki-character-board
          .board=${this._currentBoard()}
          .resolution=${DEFAULT_RESOLUTION}
          .assetsReady=${this._sprunkiAssetsReady}
          @step-toggle=${this._onStepToggle}
        ></sprunki-character-board>
      </div>
      <div class="sprunki-footer">
        <sprunki-transport-bar
          .ids=${this._ids}
          .patternId=${this._patternId}
        ></sprunki-transport-bar>
      </div>
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
