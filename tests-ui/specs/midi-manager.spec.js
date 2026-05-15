// MIDI manager (track-editor sidebar / piano-roll inspector). Covers
// the layout rules from Rich's screenshot-driven feedback:
//
//   • "Instrument parameters" only appears when an instrument is
//     loaded AND it exposes discrete/enum params. No-instrument tracks
//     and synths that take program changes (most of them) shouldn't
//     surface an empty "none exposed" fold.
//   • "Patches & banks" only appears when an instrument is loaded.
//     Without one there's no MIDI destination to send program-change
//     events to.
//   • MIDI channel fold lives at the BOTTOM of the form so it doesn't
//     drown the higher-frequency surfaces.
//   • Active preset gets a visual highlight when
//     `instrument.current_preset` matches a row.
//   • Patch-picker uses the shared `<foyer-patch-picker>` component
//     (single MIDNAM-driven form, no chip grid).
//
// We bypass the real backend wiring and mount `<foyer-midi-manager>`
// directly with synthetic data on the store — same pattern as
// `midi-editor.spec.js`.

import { test, expect } from "@playwright/test";
import { primeSessionsList, DEEP_FIND } from "./_boot.js";

async function boot(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  // Bring up a session so the variant mounts past the welcome screen
  // and `__foyer.layout` is wired. Same dance as audio-pool-drop.spec.
  // primeSessionsList first so the welcome gate flips even before
  // the backend echoes a SessionList — the variant boots the moment
  // sessions.length > 0.
  await primeSessionsList(page);
  await page.evaluate(() => {
    window.__foyer.ws.send({ type: "launch_project", backend_id: "stub" });
  });
  await page.waitForFunction(() => typeof window.__foyer?.layout?.setTree === "function");
  await page.evaluate(async () => {
    await import("/ui-full/components/midi-manager.js");
  });
}

/** Install a fake session that the manager pulls track data from
 *  via `window.__foyer.store.state.session`. Returns the track id. */
async function seedSession(page, { instrument = null, programParams = [] } = {}) {
  return page.evaluate(({ instrument, programParams }) => {
    const state = window.__foyer.store.state;
    const trackId = "track.midi.test";
    const plugins = instrument
      ? [{
          id: instrument.id || "plug.inst",
          name: instrument.name || "TestSynth",
          uri: instrument.uri || "lv2:test-synth",
          bypassed: false,
          missing: false,
          current_preset: instrument.current_preset || null,
          params: [
            ...programParams.map((p, i) => ({
              id: `param.${trackId}.${i}`,
              name: p.name || `Param ${i}`,
              kind: p.kind || "enum",
            })),
          ],
        }]
      : [];
    state.session = {
      ...(state.session || {}),
      sample_rate: 48000,
      tracks: [
        {
          id: trackId,
          name: "TestMIDI",
          kind: "midi",
          plugins,
          gain: { id: `${trackId}.gain`, value: 0 },
          mute: { id: `${trackId}.mute`, value: false },
          solo: { id: `${trackId}.solo`, value: false },
          pan: { id: `${trackId}.pan`, value: 0 },
          playback_channel_mode: "force",
          playback_channel_mask: 0x0001,
          capture_channel_mode: "force",
          capture_channel_mask: 0x0001,
          midi_patches: [],
        },
      ],
    };
    window.__foyer.store.dispatchEvent(new Event("change"));
    return trackId;
  }, { instrument, programParams });
}

async function mountManager(page, trackId) {
  return page.evaluateHandle((trackId) => {
    document.querySelectorAll("foyer-midi-manager").forEach((e) => e.remove());
    const el = document.createElement("foyer-midi-manager");
    el.trackId = trackId;
    el.trackName = "TestMIDI";
    document.body.appendChild(el);
    return el;
  }, trackId);
}

test.describe("foyer-midi-manager", () => {
  test("no instrument → hides 'Patches & banks' and 'Instrument parameters'", async ({ page }) => {
    await boot(page);
    const trackId = await seedSession(page, { instrument: null });
    const handle = await mountManager(page, trackId);
    await handle.evaluate((el) => el.updateComplete);

    const probe = await handle.evaluate((el) => {
      const text = el.shadowRoot.textContent || "";
      return {
        hasInstrumentSection: /Instrument/.test(text),
        hasParametersFold: /Instrument parameters/.test(text),
        hasPatchesFold: /Patches & banks|Patches &amp; banks/.test(text),
        hasChannelFold: /MIDI channel/.test(text),
      };
    });
    expect(probe.hasInstrumentSection).toBe(true);
    expect(probe.hasParametersFold).toBe(false);
    expect(probe.hasPatchesFold).toBe(false);
    // Channel fold always renders (now at bottom).
    expect(probe.hasChannelFold).toBe(true);
  });

  test("instrument without program-like params → hides 'Instrument parameters' fold", async ({ page }) => {
    await boot(page);
    const trackId = await seedSession(page, {
      instrument: { name: "Synth", uri: "lv2:foo" },
      programParams: [],   // no discrete/enum params
    });
    const handle = await mountManager(page, trackId);
    await handle.evaluate((el) => el.updateComplete);

    const probe = await handle.evaluate((el) => {
      const text = el.shadowRoot.textContent || "";
      return {
        hasParametersFold: /Instrument parameters/.test(text),
        hasPatchesFold: /Patches & banks|Patches &amp; banks/.test(text),
      };
    });
    expect(probe.hasParametersFold).toBe(false);
    // Patches still surface — sending PC events through the synth is
    // the correct fallback when it doesn't expose a param-side
    // program selector.
    expect(probe.hasPatchesFold).toBe(true);
  });

  test("instrument with enum params → 'Instrument parameters' fold visible", async ({ page }) => {
    await boot(page);
    const trackId = await seedSession(page, {
      instrument: { name: "Synth" },
      programParams: [
        { name: "Bank", kind: "enum" },
        { name: "Program", kind: "discrete" },
      ],
    });
    const handle = await mountManager(page, trackId);
    await handle.evaluate((el) => el.updateComplete);

    const probe = await handle.evaluate((el) => {
      const text = el.shadowRoot.textContent || "";
      return {
        hasParametersFold: /Instrument parameters/.test(text),
        hasParamCount: /2 parameter/.test(text),
      };
    });
    expect(probe.hasParametersFold).toBe(true);
    expect(probe.hasParamCount).toBe(true);
  });

  test("MIDI channel fold renders after the patches/parameters folds", async ({ page }) => {
    await boot(page);
    const trackId = await seedSession(page, {
      instrument: { name: "Synth" },
      programParams: [{ name: "Bank", kind: "enum" }],
    });
    const handle = await mountManager(page, trackId);
    await handle.evaluate((el) => el.updateComplete);

    const order = await handle.evaluate((el) => {
      const folds = [...el.shadowRoot.querySelectorAll(".fold .label")]
        .map((e) => e.textContent.trim());
      return folds;
    });
    // Channel should be the LAST fold rendered in the .body.
    expect(order.length).toBeGreaterThan(0);
    expect(order[order.length - 1]).toMatch(/MIDI channel/i);
  });

  test("active preset gets the .active highlight when current_preset matches", async ({ page }) => {
    await boot(page);
    const trackId = await seedSession(page, {
      instrument: {
        name: "Synth",
        current_preset: "preset.b",
      },
    });
    const handle = await mountManager(page, trackId);
    // Inject a preset list manually (no backend round-trip in this test).
    await handle.evaluate((el) => {
      el._presets = [
        { id: "preset.a", name: "Preset A", is_factory: true },
        { id: "preset.b", name: "Preset B", is_factory: true },
        { id: "preset.c", name: "Preset C", is_factory: true },
      ];
      el._presetsForPluginId = "plug.inst";
      el.requestUpdate();
    });
    await handle.evaluate((el) => el.updateComplete);

    const probe = await handle.evaluate((el) => {
      const buttons = [...el.shadowRoot.querySelectorAll(".preset-grid .preset")];
      return buttons.map((b) => ({
        title: b.title,
        active: b.classList.contains("active"),
        label: b.textContent.trim(),
      }));
    });
    expect(probe.length).toBe(3);
    expect(probe.find((p) => p.title === "preset.b")?.active).toBe(true);
    expect(probe.find((p) => p.title === "preset.a")?.active).toBe(false);
    expect(probe.find((p) => p.title === "preset.c")?.active).toBe(false);
  });
});
