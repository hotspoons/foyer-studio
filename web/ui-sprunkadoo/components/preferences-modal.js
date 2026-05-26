// Sprunki preferences modal — slimmed for the patch-based model.
//
// As of the 2026-05-25 push the main game surface is 100% glyphs
// (per Rich's spec: "no text drawn to the screen for the main
// game"), so all the text-y controls land here: key / mode /
// progression / per-section chord pills, plus the scary-mode
// toggle and the reset. BPM stays in the top toolbar as a
// horizontal slider — it's the only persistent affordance that
// happens to be numeric.

import { LitElement, html, css } from "lit";
import { sprunkiStore, resetSprunkiStore } from "../state-store.js";
import { getPatch, PATCHES } from "../patches.js";
import "./chord-strip.js";

// Full GM Level 1 instrument bank, grouped by family. Each entry is
// `{ id, label }`; the dropdown groups them under <optgroup>s so a
// grown-up can scan the families instead of scrolling 128 flat rows.
// Mapping matches Ardour's internal expectations + FluidSynth's
// program changes on channel 0.
const GM_FAMILIES = [
  { label: "Piano", programs: [
    [0, "Acoustic Grand"], [1, "Bright Acoustic"], [2, "Electric Grand"],
    [3, "Honky-tonk"], [4, "Electric Piano 1"], [5, "Electric Piano 2"],
    [6, "Harpsichord"], [7, "Clavi"],
  ]},
  { label: "Chromatic Perc", programs: [
    [8, "Celesta"], [9, "Glockenspiel"], [10, "Music Box"], [11, "Vibraphone"],
    [12, "Marimba"], [13, "Xylophone"], [14, "Tubular Bells"], [15, "Dulcimer"],
  ]},
  { label: "Organ", programs: [
    [16, "Drawbar Organ"], [17, "Percussive Organ"], [18, "Rock Organ"],
    [19, "Church Organ"], [20, "Reed Organ"], [21, "Accordion"],
    [22, "Harmonica"], [23, "Tango Accordion"],
  ]},
  { label: "Guitar", programs: [
    [24, "Nylon Guitar"], [25, "Steel Guitar"], [26, "Jazz Guitar"],
    [27, "Clean Guitar"], [28, "Muted Guitar"], [29, "Overdriven Guitar"],
    [30, "Distortion Guitar"], [31, "Guitar Harmonics"],
  ]},
  { label: "Bass", programs: [
    [32, "Acoustic Bass"], [33, "Fingered Bass"], [34, "Picked Bass"],
    [35, "Fretless Bass"], [36, "Slap Bass 1"], [37, "Slap Bass 2"],
    [38, "Synth Bass 1"], [39, "Synth Bass 2"],
  ]},
  { label: "Strings", programs: [
    [40, "Violin"], [41, "Viola"], [42, "Cello"], [43, "Contrabass"],
    [44, "Tremolo Strings"], [45, "Pizzicato"], [46, "Harp"], [47, "Timpani"],
  ]},
  { label: "Ensemble", programs: [
    [48, "Strings 1"], [49, "Strings 2"], [50, "Syn Strings 1"], [51, "Syn Strings 2"],
    [52, "Choir Aahs"], [53, "Voice Oohs"], [54, "Synth Voice"], [55, "Orchestra Hit"],
  ]},
  { label: "Brass", programs: [
    [56, "Trumpet"], [57, "Trombone"], [58, "Tuba"], [59, "Muted Trumpet"],
    [60, "French Horn"], [61, "Brass Section"], [62, "Syn Brass 1"], [63, "Syn Brass 2"],
  ]},
  { label: "Reed", programs: [
    [64, "Soprano Sax"], [65, "Alto Sax"], [66, "Tenor Sax"], [67, "Baritone Sax"],
    [68, "Oboe"], [69, "English Horn"], [70, "Bassoon"], [71, "Clarinet"],
  ]},
  { label: "Pipe", programs: [
    [72, "Piccolo"], [73, "Flute"], [74, "Recorder"], [75, "Pan Flute"],
    [76, "Blown Bottle"], [77, "Shakuhachi"], [78, "Whistle"], [79, "Ocarina"],
  ]},
  { label: "Synth Lead", programs: [
    [80, "Lead Square"], [81, "Lead Saw"], [82, "Calliope"], [83, "Chiff"],
    [84, "Charang"], [85, "Voice Lead"], [86, "Fifths"], [87, "Bass+Lead"],
  ]},
  { label: "Synth Pad", programs: [
    [88, "New Age"], [89, "Warm Pad"], [90, "Polysynth"], [91, "Choir Pad"],
    [92, "Bowed Pad"], [93, "Metallic"], [94, "Halo"], [95, "Sweep"],
  ]},
  { label: "Synth FX", programs: [
    [96, "Rain"], [97, "Soundtrack"], [98, "Crystal"], [99, "Atmosphere"],
    [100, "Brightness"], [101, "Goblins"], [102, "Echoes"], [103, "Sci-Fi"],
  ]},
  { label: "Ethnic", programs: [
    [104, "Sitar"], [105, "Banjo"], [106, "Shamisen"], [107, "Koto"],
    [108, "Kalimba"], [109, "Bagpipe"], [110, "Fiddle"], [111, "Shanai"],
  ]},
  { label: "Percussive", programs: [
    [112, "Tinkle Bell"], [113, "Agogo"], [114, "Steel Drums"], [115, "Woodblock"],
    [116, "Taiko"], [117, "Melodic Tom"], [118, "Synth Drum"], [119, "Reverse Cymbal"],
  ]},
  { label: "Sound FX", programs: [
    [120, "Guitar Fret"], [121, "Breath"], [122, "Seashore"], [123, "Bird Tweet"],
    [124, "Telephone"], [125, "Helicopter"], [126, "Applause"], [127, "Gunshot"],
  ]},
];

/** GM Level 1 drum kits — selectable via PROGRAM CHANGE on channel 9.
 *  Most soundfonts (including FluidGM) follow these IDs. Kit 0 is
 *  the canonical Standard kit; the others swap in heavier / lighter
 *  versions. The kid picks one of these and the slot's drum sprunki
 *  plays back through that kit. */
const GM_DRUM_KITS = [
  { id: 0,  label: "Standard Kit" },
  { id: 8,  label: "Room Kit" },
  { id: 16, label: "Power Kit" },
  { id: 24, label: "Electronic Kit" },
  { id: 25, label: "TR-808 Kit" },
  { id: 32, label: "Jazz Kit" },
  { id: 40, label: "Brush Kit" },
  { id: 48, label: "Orchestra Kit" },
  { id: 56, label: "SFX Kit" },
];

export class SprunkiPreferencesModal extends LitElement {
  static properties = {
    /** Live `AssetPackInfo` for the OG sprunki pack, forwarded by
     *  the app shell so we can show "downloading…" / "ready" /
     *  "available" hints inline with the source toggle. */
    sprunkiPack: { type: Object },
    _rev: { type: Number, state: true },
    _showAdvanced: { type: Boolean, state: true },
    /** When true, the in-panel "Clear all?" confirm overlay is shown.
     *  Replaces the native confirm() so the kid sees the same red-X
     *  visual language as every other Sprunkadoo modal. */
    _confirmingClear: { type: Boolean, state: true },
  };
  static styles = css`
    :host {
      position: fixed; inset: 0;
      display: grid; place-items: center;
      background: rgba(8, 10, 16, 0.78);
      z-index: 9999;
      font-family: system-ui, sans-serif;
      color: #e5e8ee;
    }
    .panel {
      width: min(640px, 94vw);
      max-height: 90vh;
      overflow-y: auto;
      background: #161b22;
      border: 1px solid #2a3140;
      border-radius: 10px;
      padding: 18px 22px;
      box-shadow: 0 30px 80px rgba(0,0,0,0.5);
    }
    h2 { margin: 0 0 12px 0; font-size: 17px; }
    .section {
      padding: 12px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .section-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.55);
      margin-bottom: 8px;
    }
    .section sprunki-chord-strip {
      display: block;
      margin: 4px -22px;
    }
    .row {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .row:last-child { border-bottom: 0; }
    .row-label { flex: 1; }
    button {
      background: #2a2e44; border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px; color: #eee; padding: 6px 14px;
      cursor: pointer; font-size: 13px;
    }
    button:hover { background: #353a55; }
    button.danger { background: #4a1d1d; border-color: #7a2a2a; }
    button.danger:hover { background: #6b2a2a; }
    /* High-contrast red close button. Earlier this blended with
       the hamburger glyph in the toolbar behind the modal — the
       red fill + thick white border make it pop against ANY
       background (toolbar, stage, palette tiles). Top-right
       inside the panel so the kid can find it without thinking. */
    .close {
      position: absolute; top: 10px; right: 10px;
      width: 34px; height: 34px; border-radius: 999px;
      background: #e54d3a;
      color: #fff;
      font: 800 20px/1 system-ui, sans-serif;
      border: 2px solid rgba(255, 255, 255, 0.85);
      cursor: pointer;
      box-shadow: 0 3px 10px rgba(0, 0, 0, 0.5);
      display: flex; align-items: center; justify-content: center;
      padding: 0;
      transition: transform 100ms ease, background 100ms ease;
    }
    .close:hover { background: #c33a28; transform: scale(1.08); }
    .close:active { transform: scale(0.94); }
    .small { font-size: 11px; color: rgba(255,255,255,0.55); }
    /* Advanced section — per-slot instrument overrides. Each
       placed sprunki gets a row with its costume name + a select
       listing GM programs. Greyed out for empty slots. */
    /* Advanced expando — restyled 2026-05-26. The old version was
       a plain row with a tiny "▾" glyph; reads as a stuck section
       header. New shape: chip-pill with a clear chevron + slight
       hover lift so the affordance is obvious. */
    .advanced-toggle {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      margin: 12px 0 4px;
      cursor: pointer;
      color: rgba(255,255,255,0.78);
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      transition: background 120ms ease, transform 110ms ease,
                  border-color 120ms ease, color 120ms ease;
    }
    .advanced-toggle:hover {
      background: rgba(255,255,255,0.10);
      border-color: rgba(255,255,255,0.18);
      color: #fff;
      transform: translateY(-1px);
    }
    .advanced-toggle.open {
      background: rgba(108, 92, 255, 0.18);
      border-color: rgba(108, 92, 255, 0.45);
      color: #fff;
    }
    .advanced-chevron {
      width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      transition: transform 160ms ease, background 120ms ease;
    }
    .advanced-toggle:hover .advanced-chevron { background: rgba(255,255,255,0.18); }
    .advanced-toggle.open .advanced-chevron {
      transform: rotate(180deg);
      background: rgba(108, 92, 255, 0.35);
    }
    .advanced-chevron svg { width: 12px; height: 12px; }

    /* Per-COSTUME override row: costume label, GM/kit picker, reset
       button. Reset disables when the costume is already at default. */
    .advanced-intro { margin-bottom: 10px; }
    .patch-group-label {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: rgba(255,255,255,0.45);
      margin: 14px 0 4px;
    }
    .patch-row {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) minmax(180px, 1.4fr) auto;
      gap: 10px;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .patch-row:last-child { border-bottom: 0; }
    .patch-row-label {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .patch-row-label .swatch {
      width: 14px; height: 14px;
      border-radius: 4px;
      flex: 0 0 14px;
    }
    .patch-row-label .patch-name {
      font-size: 13px; font-weight: 600; color: #e5e8ee;
    }
    .patch-row-label small {
      font-size: 11px;
      color: rgba(255,255,255,0.55);
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .patch-row-label .badge {
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.10em;
      padding: 2px 6px;
      border-radius: 999px;
      background: rgba(108, 92, 255, 0.32);
      color: #d8d5ff;
    }
    .reset-btn {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.78);
      padding: 6px 12px;
      border-radius: 7px;
      font: 600 12px system-ui, sans-serif;
      cursor: pointer;
      transition: background 120ms ease, color 120ms ease;
    }
    .reset-btn:hover:not(:disabled) {
      background: rgba(255,255,255,0.12);
      color: #fff;
    }
    .reset-btn:disabled { opacity: 0.35; cursor: not-allowed; }
    .slot-row-label {
      font-size: 12px; font-weight: 600; color: #e5e8ee;
    }
    .slot-row-label small { display: block; font-weight: 400; font-size: 10px; color: rgba(255,255,255,0.45); }
    .slot-row select {
      background: #1c2230; color: #e5e8ee;
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 6px; padding: 4px 8px; font: inherit;
      min-width: 160px; max-width: 100%;
    }
    .slot-row .swatch {
      width: 16px; height: 16px; border-radius: 4px; background: var(--cc, #888);
    }
    /* Asset-source picker — two side-by-side pill buttons. The
       active one gets a colored fill, the inactive stays muted. */
    .pack-picker {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 6px;
    }
    .pack-picker button {
      padding: 10px 12px;
      text-align: left;
      line-height: 1.25;
      border-radius: 8px;
    }
    .pack-picker button.active {
      background: #36487a;
      border-color: #6a86c8;
      color: #fff;
    }
    .pack-picker button .pack-title {
      display: block;
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 2px;
    }
    .pack-picker button .pack-sub {
      display: block;
      font-size: 11px;
      color: rgba(255,255,255,0.55);
    }
    .pack-picker button.active .pack-sub { color: rgba(255,255,255,0.85); }

    /* In-panel destructive confirm overlay. Same red-X language as
       the rest of the modals; lives INSIDE the prefs panel so it
       can't get lost behind another modal. */
    .confirm-veil {
      position: absolute;
      inset: 0;
      background: rgba(8, 10, 16, 0.78);
      display: grid; place-items: center;
      border-radius: 10px;
      z-index: 10;
    }
    .confirm-panel {
      background: #1c1f2c;
      border: 1px solid #3a2828;
      border-radius: 12px;
      padding: 22px 26px;
      max-width: 380px;
      width: calc(100% - 40px);
      box-shadow: 0 14px 40px rgba(0,0,0,0.55);
    }
    .confirm-title {
      font-size: 16px;
      font-weight: 800;
      color: #fff;
      margin-bottom: 8px;
    }
    .confirm-body {
      font-size: 13px;
      color: rgba(255,255,255,0.72);
      line-height: 1.45;
      margin-bottom: 16px;
    }
    .confirm-actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }
    .confirm-cancel {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      color: #e5e8ee;
      padding: 8px 16px;
      border-radius: 8px;
      font: 600 13px system-ui, sans-serif;
      cursor: pointer;
    }
    .confirm-cancel:hover { background: rgba(255,255,255,0.14); }
    .confirm-go {
      background: #e54d3a;
      border: 1px solid rgba(255,255,255,0.85);
      color: #fff;
      padding: 8px 16px;
      border-radius: 8px;
      font: 700 13px system-ui, sans-serif;
      cursor: pointer;
      box-shadow: 0 3px 10px rgba(229, 77, 58, 0.35);
    }
    .confirm-go:hover { background: #c33a28; }

    /* Panel needs position:relative for the overlay to inset
       correctly within it. */
    .panel { position: relative; }
  `;
  constructor() {
    super();
    this._store = sprunkiStore();
    this._rev = 0;
    this._showAdvanced = false;
    this._confirmingClear = false;
    this._listener = () => { this._rev++; this.requestUpdate(); };
    this._onHostClick = (e) => this._onBackdropClick(e);
    this._onKey = (e) => { if (e.key === "Escape") this._close(); };
  }
  connectedCallback() {
    super.connectedCallback();
    this._store.addEventListener("scary-mode-changed", this._listener);
    this._store.addEventListener("parental-changed", this._listener);
    this._store.addEventListener("asset-source-changed", this._listener);
    this._store.addEventListener("patch-override-changed", this._listener);
    // Click on the dimmed backdrop (= the host element itself,
    // not the inner panel) dismisses. ESC also dismisses.
    this.addEventListener("click", this._onHostClick);
    document.addEventListener("keydown", this._onKey);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._store.removeEventListener("scary-mode-changed", this._listener);
    this._store.removeEventListener("parental-changed", this._listener);
    this._store.removeEventListener("asset-source-changed", this._listener);
    this._store.removeEventListener("patch-override-changed", this._listener);
    this.removeEventListener("click", this._onHostClick);
    document.removeEventListener("keydown", this._onKey);
  }

  _close() {
    this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
  }
  _onToggleScary() {
    if (this._store.scaryMode) {
      this._store.setScaryMode(false);
      return;
    }
    if (!this._store.parentalUnlocked) {
      this.dispatchEvent(new CustomEvent("request-parental-gate", {
        bubbles: true, composed: true,
      }));
      return;
    }
    this._store.setScaryMode(true);
  }
  _onClearAll() {
    // Inline confirm — the kid's UI never sees a native dialog.
    this._confirmingClear = true;
  }
  async _confirmClearAll() {
    // Silence every region on the backend BEFORE we blow the store
    // away. Without this, after reload the regions still hold the
    // last-pushed notes and continue playing — the symptom Rich
    // hit 2026-05-26: "resetting the UI doesn't flow empty state
    // to the back end."
    const f = globalThis.__foyer;
    if (f?.ws) {
      for (const slot of this._store.stage) {
        if (!slot.region_id) continue;
        f.ws.send({ type: "clear_sequencer_layout", region_id: slot.region_id });
        f.ws.send({ type: "replace_region_notes", region_id: slot.region_id, notes: [] });
      }
      // Stop the transport so the kid doesn't hear the playhead
      // crawl across the silence on the way to the reload.
      f.ws.controlSet?.("transport.playing", false);
    }
    // Tiny breath so the WS queue can drain before the reload yanks it.
    await new Promise((r) => setTimeout(r, 120));
    resetSprunkiStore();
    location.reload();
  }
  _cancelClearAll() {
    this._confirmingClear = false;
  }

  /** Drop Sprunkadoo and boot into the full Foyer Studio UI. Guarded
   *  behind the parental gate (same math-quiz the scary-mode toggle
   *  uses) so a kid can't accidentally land themselves in the
   *  multi-track-DAW screen mid-play. The variant pref is written
   *  to foyer-core's ui-variant storage, then a reload re-runs
   *  `pickUiVariant` and the full UI mounts. */
  async _onSwitchToFoyer() {
    if (!this._store.parentalUnlocked) {
      this.dispatchEvent(new CustomEvent("request-parental-gate", {
        bubbles: true, composed: true,
        detail: { reason: "switch-to-foyer" },
      }));
      return;
    }
    if (!confirm("Switch out of Sprunkadoo into the full Foyer Studio UI? Your stage stays saved — coming back to Sprunkadoo via ?ui=sprunkadoo will reload it.")) {
      return;
    }
    try {
      const { setUserVariantPreference } = await import("foyer-core/registry/ui-variants.js");
      setUserVariantPreference("full");
    } catch (e) {
      console.warn("[sprunki-prefs] couldn't persist variant pref:", e);
    }
    // Rewrite the URL so the next reload's `?ui=` override doesn't
    // pin us back here, then hard-reload to remount.
    const url = new URL(location.href);
    url.searchParams.delete("ui");
    location.replace(url.toString());
  }

  _onPickAssetSource(source) {
    if (source === this._store.assetSource) return;
    this._store.setAssetSource(source);
  }
  _sprunkiOgStatusSub() {
    const p = this.sprunkiPack;
    if (!p) return ".";
    if (p.state === "ready") return " — installed.";
    if (p.state === "downloading") {
      const pct = typeof p.progress === "number" ? `${p.progress}%` : "";
      return ` — downloading ${pct}`;
    }
    if (p.state === "extracting") return " — extracting…";
    if (p.state === "failed") return " — download failed.";
    return " when first picked.";
  }

  /** Per-COSTUME override picker. The app handler saves the
   *  override on the patch (not the slot) and re-applies the
   *  effective program to every slot currently holding the
   *  costume. */
  _onPickPatchProgram(patchId, gmProgram, gmChannel) {
    this.dispatchEvent(new CustomEvent("patch-override-change", {
      detail: { patchId, gmProgram, gmChannel },
      bubbles: true, composed: true,
    }));
  }

  /** Fires `open-arranger` — the parent app handles mounting
   *  the (yet-to-be-built) arrangement modal. For now this
   *  alerts so the kid sees the affordance exists; the modal
   *  itself ships next pass. Plan is in
   *  docs/SPRUNKADOO_VISION.md → "Arrangement editor". */
  _onOpenArranger() {
    this.dispatchEvent(new CustomEvent("open-arranger", {
      bubbles: true, composed: true,
    }));
  }

  _renderAdvanced() {
    // Per-COSTUME overrides — one row per patch in the catalog,
    // independent of which slots currently hold the costume. The
    // kid sets "Sun → Music Box" once and every slot wearing Sun
    // plays Music Box. Survives sessions.
    const drums = PATCHES.filter((p) => p.mode === "drum");
    const pitched = PATCHES.filter((p) => p.mode !== "drum");
    return html`
      <div class="section">
        <div class="section-label">Advanced — per-costume sound override</div>
        <div class="small advanced-intro">
          Pick a different GM instrument (or drum kit) for each
          costume. Applies to every sprunki on stage wearing that
          costume.
        </div>
        <div class="patch-group-label">Drums</div>
        ${drums.map((p) => this._renderPatchRow(p))}
        <div class="patch-group-label">Pitched</div>
        ${pitched.map((p) => this._renderPatchRow(p))}
      </div>
    `;
  }

  _renderPatchRow(patch) {
    const isDrums = (patch.gm_channel ?? 0) === 9;
    const override = this._store.patchOverride(patch.id);
    const effectiveProg = override?.gm_program ?? patch.gm_program ?? 0;
    const channel = override?.gm_channel ?? patch.gm_channel ?? 0;
    const isCustomized = !!override;
    return html`
      <div class="patch-row" style="--cc:${patch.color || "#666"};">
        <div class="patch-row-label">
          <span class="swatch" style="background:${patch.color || "#444"};"></span>
          <span class="patch-name">${patch.label}</span>
          <small>
            ${isDrums ? `kit ${effectiveProg}` : `GM ${effectiveProg}`}
            ${isCustomized ? html`<span class="badge">CUSTOM</span>` : ""}
          </small>
        </div>
        ${isDrums
          ? this._renderDrumKitPicker(patch.id, effectiveProg)
          : this._renderGmPicker(patch.id, effectiveProg, channel)}
        <button
          class="reset-btn"
          title=${isCustomized ? "Restore the default sound for this costume" : "Already default"}
          ?disabled=${!isCustomized}
          @click=${() => this._onPickPatchProgram(patch.id, null, null)}
        >Reset</button>
      </div>
    `;
  }

  _renderGmPicker(patchId, effectiveProg, channel) {
    return html`
      <select
        class="prog-picker"
        @change=${(e) => this._onPickPatchProgram(patchId, Number(e.currentTarget.value), channel ?? 0)}
      >
        ${GM_FAMILIES.map((fam) => html`
          <optgroup label=${fam.label}>
            ${fam.programs.map(([id, label]) => html`
              <option value=${id} ?selected=${id === effectiveProg}>
                ${String(id).padStart(3, "0")} · ${label}
              </option>
            `)}
          </optgroup>
        `)}
      </select>
    `;
  }
  _renderDrumKitPicker(patchId, effectiveProg) {
    return html`
      <select
        class="prog-picker"
        @change=${(e) => this._onPickPatchProgram(patchId, Number(e.currentTarget.value), 9)}
      >
        ${GM_DRUM_KITS.map((k) => html`
          <option value=${k.id} ?selected=${k.id === effectiveProg}>
            ${k.label}
          </option>
        `)}
      </select>
    `;
  }

  _onBackdropClick(e) {
    // The host element fills the viewport behind the panel; the
    // panel itself stops propagation. So a click that bubbles up
    // here landed OUTSIDE the panel → dismiss. Mirrors the
    // standard "click off a modal to close" gesture.
    if (e.target === this) this._close();
  }

  render() {
    const scary = this._store.scaryMode;
    return html`
      <div
        class="panel"
        @click=${(e) => e.stopPropagation()}
      >
        <button class="close" title="Close (Esc)" aria-label="Close settings" @click=${this._close}>
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor"
               stroke-width="3" fill="none" stroke-linecap="round">
            <line x1="6" y1="6" x2="18" y2="18"/>
            <line x1="18" y1="6" x2="6" y2="18"/>
          </svg>
        </button>
        <h2>Settings</h2>

        <div class="section">
          <div class="section-label">Harmony</div>
          <sprunki-chord-strip
            .musicKey=${this._store.key}
            .sectionChords=${this._store.sectionChords}
            .activePatternId=${this._store.activePatternId}
            .progressionId=${this._store.progressionId}
          ></sprunki-chord-strip>
          <div class="small">
            Key, mode, and progression all affect every tonal sprunki on stage.
            Drum sprunkis ignore harmony.
          </div>
        </div>

        <div class="section">
          <div class="section-label">Character art</div>
          <div class="pack-picker">
            <button
              class=${this._store.assetSource === "builtin" ? "active" : ""}
              @click=${() => this._onPickAssetSource("builtin")}
            >
              <span class="pack-title">Foyer Originals</span>
              <span class="pack-sub">Built-in cast. No download.</span>
            </button>
            <button
              class=${this._store.assetSource === "og" ? "active" : ""}
              @click=${() => this._onPickAssetSource("og")}
            >
              <span class="pack-title">OG Sprunki</span>
              <span class="pack-sub">Downloads from archive.org${this._sprunkiOgStatusSub()}</span>
            </button>
          </div>
          <div class="small">
            Same characters either way — only the art changes. Switch
            anytime; the stage refreshes in place.
          </div>
        </div>

        <div class="row">
          <div class="row-label">
            Scary mode
            <div class="small">Surfaces horror / "evil" sprunki content (parents only)</div>
          </div>
          <button @click=${this._onToggleScary}>${scary ? "Disable" : "Enable…"}</button>
        </div>

        <div
          class="advanced-toggle ${this._showAdvanced ? "open" : ""}"
          role="button"
          aria-expanded=${this._showAdvanced ? "true" : "false"}
          @click=${() => { this._showAdvanced = !this._showAdvanced; }}
        >
          <div>
            <strong>Advanced</strong>
            <div class="small">Per-sprunki instrument overrides</div>
          </div>
          <span class="advanced-chevron" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </span>
        </div>
        ${this._showAdvanced ? this._renderAdvanced() : ""}

        <div class="row">
          <div class="row-label">
            Switch to Foyer Studio
            <div class="small">
              Drops out of Sprunkadoo into the full multi-track Foyer
              DAW. Grown-ups only — gated behind the parent check.
            </div>
          </div>
          <button @click=${this._onSwitchToFoyer}>Switch…</button>
        </div>

        <div class="row">
          <div class="row-label">
            Reset everything
            <div class="small">Wipes the stage, all section loops, and saved preferences</div>
          </div>
          <button class="danger" @click=${this._onClearAll}>Clear all</button>
        </div>
        ${this._confirmingClear ? this._renderClearConfirm() : ""}
      </div>
    `;
  }

  /** In-panel "Are you sure?" overlay for the destructive Clear-all
   *  action. Replaces the native confirm(); same red-X visual
   *  language as every other Sprunkadoo dialog. */
  _renderClearConfirm() {
    return html`
      <div class="confirm-veil" @click=${(e) => e.stopPropagation()}>
        <div class="confirm-panel">
          <div class="confirm-title">Reset everything?</div>
          <div class="confirm-body">
            Wipes the stage, every authored part, and saved preferences.
            This can't be undone.
          </div>
          <div class="confirm-actions">
            <button class="confirm-cancel" @click=${this._cancelClearAll}>Cancel</button>
            <button class="confirm-go" @click=${() => this._confirmClearAll()}>Yes, reset</button>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("sprunki-preferences-modal", SprunkiPreferencesModal);
