// Web MIDI bridge — covers the parts that don't need real hardware:
//
//   * `ws.sendMidiInput()` packs the bytes into the right wire envelope
//     (and rejects malformed lengths).
//   * Per-device config persists across reloads.
//   * Device-config transforms (channel-remap, transpose, velocity
//     curve) hit the WS in the right shape when the service sees a
//     simulated MIDI input event. We monkey-patch
//     `navigator.requestMIDIAccess` before page boot so the singleton
//     has a synthetic device list to operate on.
//
// What this spec deliberately does NOT cover: the Ardour shim end of
// the bridge — that's standalone-shim territory (just shim build);
// the WS-server-side handler is exercised by the wire-format check
// (the stub backend's `send_midi_input` bumps a counter we don't
// expose, but we DO see that the WS accepts and the server does NOT
// emit an error envelope).

import { test, expect } from "@playwright/test";

const STORAGE_KEY = "foyer.web-midi.devices.v1";

// Synthetic Web MIDI shim. Installed via Playwright's `addInitScript`
// so it lands BEFORE any module reads `navigator.requestMIDIAccess`
// (the service captures the function reference at construction).
function installFakeWebMidi() {
  class FakeMIDIInput extends EventTarget {
    constructor(id, name, manufacturer = "Foyer Test") {
      super();
      this.id = id;
      this.name = name;
      this.manufacturer = manufacturer;
      this.type = "input";
      this.state = "connected";
      this.connection = "open";
    }
    open() { this.connection = "open"; return Promise.resolve(this); }
    close() { this.connection = "closed"; return Promise.resolve(this); }
    fire(data) {
      const ev = new Event("midimessage");
      ev.data = data instanceof Uint8Array ? data : new Uint8Array(data);
      this.dispatchEvent(ev);
    }
  }
  class FakeMIDIAccess extends EventTarget {
    constructor() {
      super();
      this.inputs = new Map();
      this.outputs = new Map();
      const a = new FakeMIDIInput("dev-a", "Foyer Test Keyboard");
      const b = new FakeMIDIInput("dev-b", "Foyer Test Pad");
      this.inputs.set(a.id, a);
      this.inputs.set(b.id, b);
    }
  }
  // Capture instance so the spec can drive it from inside `evaluate`.
  let access = null;
  navigator.requestMIDIAccess = () => {
    if (!access) access = new FakeMIDIAccess();
    return Promise.resolve(access);
  };
  // Expose on window so test-side helpers can fire MIDI messages.
  window.__fakeMidi = {
    fire(deviceId, data) {
      if (!access) return false;
      const input = access.inputs.get(deviceId);
      if (!input) return false;
      input.fire(data);
      return true;
    },
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFakeWebMidi);
});

test("ws.sendMidiInput packs envelope correctly and validates length", async ({ page }) => {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");

  const observed = await page.evaluate(async () => {
    const ws = window.__foyer.ws;
    // Hook the underlying socket's send so we can inspect frames.
    const out = [];
    const origSend = ws._ws.send.bind(ws._ws);
    ws._ws.send = (text) => {
      try { out.push(JSON.parse(text)); } catch { out.push(String(text)); }
      return origSend(text);
    };
    const okNoteOn  = ws.sendMidiInput(new Uint8Array([0x90, 60, 100]));
    const okFromArr = ws.sendMidiInput([0x80, 60, 0]);
    const rejected0 = ws.sendMidiInput(new Uint8Array([]));
    const rejected4 = ws.sendMidiInput(new Uint8Array([0xf0, 1, 2, 3]));
    return {
      okNoteOn, okFromArr, rejected0, rejected4,
      sent: out.filter((m) => m && m.body && m.body.type === "midi_input"),
    };
  });

  expect(observed.okNoteOn).toBe(true);
  expect(observed.okFromArr).toBe(true);
  expect(observed.rejected0).toBe(false);
  expect(observed.rejected4).toBe(false);
  expect(observed.sent).toHaveLength(2);
  expect(observed.sent[0].body).toEqual({ type: "midi_input", data: [0x90, 60, 100] });
  expect(observed.sent[1].body).toEqual({ type: "midi_input", data: [0x80, 60, 0] });
});

test("device list + per-device config persists across reload", async ({ page }) => {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");

  // Clear any prior persistence so the test starts from defaults.
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);

  // Grant access (uses the fake from `addInitScript`) and inspect the
  // device list. Two synthetic inputs should appear.
  const beforeChange = await page.evaluate(async () => {
    await window.__foyer.webMidi.requestAccess();
    return window.__foyer.webMidi.listDevices().map((d) => ({
      id: d.id, name: d.name, enabled: d.config.enabled,
      transpose: d.config.transpose, channelMode: d.config.channelMode,
    }));
  });
  // The synthetic on-screen keyboard always appears first; the two
  // fakes from the addInitScript come after it.
  const realDevices = beforeChange.filter((d) => d.id !== "virtual:keyboard");
  expect(realDevices).toHaveLength(2);
  expect(realDevices.map((d) => d.id).sort()).toEqual(["dev-a", "dev-b"]);
  expect(realDevices.every((d) => d.enabled === true && d.transpose === 0)).toBe(true);
  expect(beforeChange[0].id).toBe("virtual:keyboard");

  // Mutate per-device config — same surface the panel uses.
  await page.evaluate(() => {
    window.__foyer.webMidi.setDeviceConfig("dev-a", {
      enabled: false,
      channelMode: "force",
      forceChannel: 9,
      transpose: 12,
      velocityCurve: "soft",
    });
  });
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}"), STORAGE_KEY);
  expect(stored["dev-a"]).toMatchObject({
    enabled: false,
    channelMode: "force",
    forceChannel: 9,
    transpose: 12,
    velocityCurve: "soft",
  });

  // Reload. Device list should rehydrate the saved config.
  await page.reload();
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  const afterReload = await page.evaluate(async () => {
    await window.__foyer.webMidi.requestAccess();
    return window.__foyer.webMidi.listDevices()
      .find((d) => d.id === "dev-a").config;
  });
  expect(afterReload).toMatchObject({
    enabled: false,
    channelMode: "force",
    forceChannel: 9,
    transpose: 12,
    velocityCurve: "soft",
  });
});

test("device transforms (channel remap, transpose, velocity) shape outbound bytes", async ({ page }) => {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);

  await page.evaluate(async () => {
    await window.__foyer.webMidi.requestAccess();
    // Force channel 9, transpose +12, soft velocity curve.
    window.__foyer.webMidi.setDeviceConfig("dev-a", {
      enabled: true,
      channelMode: "force",
      forceChannel: 9,
      transpose: 12,
      velocityCurve: "soft",
    });
    // Disable dev-b to confirm the per-device gate.
    window.__foyer.webMidi.setDeviceConfig("dev-b", { enabled: false });
  });

  const observed = await page.evaluate(async () => {
    const out = [];
    window.__foyer.webMidi.setTap((deviceId, bytes) => {
      out.push({ deviceId, bytes: Array.from(bytes) });
    });
    // dev-a: NoteOn ch1 (status 0x90), pitch 60, velocity 100 →
    //   forced channel 9 → status 0x99
    //   transpose +12 → pitch 72
    //   soft curve on velocity 100 → round(sqrt(100/127)*127) = 113
    window.__fakeMidi.fire("dev-a", [0x90, 60, 100]);
    // dev-a: NoteOn pitch 0 transpose -25 (out of range) — only one
    // shape per spec; keep it focused. Test the drop case here:
    // configure dev-a to transpose -120 → out of range → dropped.
    window.__foyer.webMidi.setDeviceConfig("dev-a", { transpose: -1 });
    window.__fakeMidi.fire("dev-a", [0x90, 0, 100]);
    // dev-b is disabled → no event should make it to the tap.
    window.__fakeMidi.fire("dev-b", [0x90, 60, 100]);
    return out;
  });

  expect(observed).toHaveLength(1);
  expect(observed[0].deviceId).toBe("dev-a");
  expect(observed[0].bytes[0]).toBe(0x99);    // channel forced to 9 (zero-indexed)
  expect(observed[0].bytes[1]).toBe(72);      // transposed +12
  // Soft curve on 100 → round(sqrt(100/127) * 127) = 113.
  expect(observed[0].bytes[2]).toBe(113);
});

test("on-screen keyboard inject() routes through device-config transforms", async ({ page }) => {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);

  // Configure the synthetic device with a force-channel + transpose
  // so the test verifies the inject path actually walks the same
  // pipeline as `_onMessage` does for real hardware.
  await page.evaluate(() => {
    window.__foyer.webMidi.setDeviceConfig("virtual:keyboard", {
      enabled: true,
      channelMode: "force",
      forceChannel: 4,
      transpose: -12,
      velocityCurve: "linear",
    });
  });

  const observed = await page.evaluate(async () => {
    const out = [];
    window.__foyer.webMidi.setTap((deviceId, bytes) => {
      out.push({ deviceId, bytes: Array.from(bytes) });
    });
    // C5 (72) → -12 transpose → C4 (60); status 0x90 (ch 1) →
    // forced ch 5 → 0x94.
    const accepted = window.__foyer.webMidi.inject("virtual:keyboard", [0x90, 72, 96]);
    const rejected = window.__foyer.webMidi.inject("virtual:keyboard", [0xf0, 1, 2, 3]);
    const unknown  = window.__foyer.webMidi.inject("nope", [0x90, 60, 100]);
    return { out, accepted, rejected, unknown };
  });

  expect(observed.accepted).toBe(true);
  expect(observed.rejected).toBe(false);
  expect(observed.unknown).toBe(false);
  expect(observed.out).toHaveLength(1);
  expect(observed.out[0].deviceId).toBe("virtual:keyboard");
  expect(observed.out[0].bytes).toEqual([0x94, 60, 96]);
});

test("soft keyboard window opens from the session menu and emits notes", async ({ page }) => {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  // The window-kind factory for "soft-keyboard" lives in
  // right-dock.js, which is a side-effect import from the ui-full
  // variant's app.js. Without waiting for that, `spawnWindowKind`
  // returns false because the FACTORIES map is still empty.
  await page.waitForFunction(
    () => typeof window.__foyer?.layout?.setTree === "function",
  );
  // The window-kind factory for "soft-keyboard" lives in
  // right-dock.js, which is imported by app.js as a side-effect.
  // Wait for the right-dock element to appear inside foyer-app's
  // shadow root so we know that import has run.
  await page.waitForFunction(
    () => !!document.querySelector("foyer-app")?.shadowRoot?.querySelector("foyer-right-dock"),
  );
  // Reset config so transforms don't surprise us.
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);

  // Spawn the keyboard via the same window-kind the menu uses.
  const tap = await page.evaluate(async () => {
    const win = await import("/ui-core/widgets/window.js");
    return typeof win.spawnWindowKind === "function" ? win.spawnWindowKind("soft-keyboard") : null;
  });
  expect(tap).toBe(true);

  // The window mounts via `appendChild` synchronously, but
  // custom-element upgrades land on the next microtask. Poll until
  // the element's _noteOn API is reachable.
  await page.waitForFunction(() => {
    const el = document.querySelector("foyer-soft-keyboard");
    return !!(el && typeof el._noteOn === "function");
  });

  const observed = await page.evaluate(async () => {
    const out = [];
    window.__foyer.webMidi.setTap((deviceId, bytes) => {
      out.push({ deviceId, bytes: Array.from(bytes) });
    });
    const kb = document.querySelector("foyer-soft-keyboard");
    kb._noteOn(48, 110);
    kb._noteOff(48);
    return { out };
  });

  expect(observed.out).toHaveLength(2);
  expect(observed.out[0]).toEqual({ deviceId: "virtual:keyboard", bytes: [0x90, 48, 110] });
  expect(observed.out[1]).toEqual({ deviceId: "virtual:keyboard", bytes: [0x80, 48, 0] });
});

test("armed track id rides outbound midi_input envelopes", async ({ page }) => {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);

  const observed = await page.evaluate(async () => {
    const ws = window.__foyer.ws;
    const sent = [];
    const orig = ws._ws.send.bind(ws._ws);
    ws._ws.send = (text) => {
      try {
        const env = JSON.parse(text);
        if (env?.body?.type === "midi_input") sent.push(env.body);
      } catch {}
      return orig(text);
    };
    // No arm yet → no track_id on the wire.
    window.__foyer.webMidi.inject("virtual:keyboard", [0x90, 60, 100]);
    // Arm a track.
    window.__foyer.webMidi.armTrack("track.42");
    window.__foyer.webMidi.inject("virtual:keyboard", [0x90, 64, 100]);
    // Disarm; the next event should be untargeted again.
    window.__foyer.webMidi.disarm();
    window.__foyer.webMidi.inject("virtual:keyboard", [0x80, 60, 0]);
    return sent;
  });

  expect(observed).toHaveLength(3);
  expect(observed[0].track_id).toBeUndefined();
  expect(observed[1].track_id).toBe("track.42");
  expect(observed[2].track_id).toBeUndefined();
});

test("local monitor only feeds the synth when armed AND the toggle is on", async ({ page }) => {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
  // Reset the local-monitor pref between specs — workers: 1 means
  // localStorage carries state across tests in a single run.
  await page.evaluate(() => localStorage.removeItem("foyer.web-midi.local-monitor.v1"));

  const observed = await page.evaluate(async () => {
    const wm = window.__foyer.webMidi;
    const synthFeeds = [];
    wm.setSynthTap((deviceId, bytes) => {
      synthFeeds.push({ deviceId, bytes: Array.from(bytes) });
    });
    // Pref off + no arm → no feed.
    wm.inject("virtual:keyboard", [0x90, 60, 100]);
    const a = synthFeeds.length;
    // Pref on but no arm → no feed (the arm gate is independent).
    await wm.setLocalMonitor(true);
    wm.inject("virtual:keyboard", [0x90, 60, 100]);
    const b = synthFeeds.length;
    // Pref on + arm → feed.
    wm.armTrack("track.lead-1");
    wm.inject("virtual:keyboard", [0x90, 60, 100]);
    wm.inject("virtual:keyboard", [0x80, 60, 0]);
    const c = synthFeeds.length;
    // Pref off (after toggling) → no more feeds even though armed.
    await wm.setLocalMonitor(false);
    wm.inject("virtual:keyboard", [0x90, 64, 100]);
    const d = synthFeeds.length;
    return { a, b, c, d, lastBytes: synthFeeds[c - 1]?.bytes };
  });

  expect(observed.a).toBe(0);     // pref off
  expect(observed.b).toBe(0);     // pref on but disarmed
  expect(observed.c).toBe(2);     // armed + on → both events fed
  expect(observed.d).toBe(2);     // pref off → counter unchanged
  expect(observed.lastBytes).toEqual([0x80, 60, 0]);
});

test("toggleTrackMidi claims source-user, arms, and reverses cleanly", async ({ page }) => {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);

  const observed = await page.evaluate(async () => {
    const ws = window.__foyer.ws;
    const sent = [];
    const orig = ws._ws.send.bind(ws._ws);
    ws._ws.send = (text) => {
      try {
        const env = JSON.parse(text);
        if (env?.body) sent.push(env.body);
      } catch {}
      return orig(text);
    };
    const mod = await import("/core/midi/track-midi.js");
    // Arm.
    const armResult = await mod.toggleTrackMidi({
      trackId: "track.midi-9",
      ws,
      store: window.__foyer.store,
    });
    const armedAfter = window.__foyer.webMidi.armedTrackId;
    // Toggle off.
    const disarmResult = await mod.toggleTrackMidi({
      trackId: "track.midi-9",
      ws,
      store: window.__foyer.store,
    });
    const armedAfterOff = window.__foyer.webMidi.armedTrackId;
    return {
      armResult, disarmResult, armedAfter, armedAfterOff,
      claims: sent.filter((b) => b.type === "set_track_browser_source"),
    };
  });

  expect(observed.armResult).toBe(true);
  expect(observed.armedAfter).toBe("track.midi-9");
  expect(observed.disarmResult).toBe(false);
  expect(observed.armedAfterOff).toBe(null);
  // Two claim envelopes — first claims (peer_id=self), second releases (peer_id="").
  expect(observed.claims).toHaveLength(2);
  expect(observed.claims[0].peer_id).not.toBe("");
  expect(observed.claims[1].peer_id).toBe("");
});
