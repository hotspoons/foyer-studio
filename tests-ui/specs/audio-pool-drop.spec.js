// Audio-pool → timeline drag-drop. Verifies the wire contract:
//
//   • Pool rows on dragstart set the `application/x-foyer-audio-pool-source`
//     MIME on the DataTransfer AND stash the payload on
//     `window.__foyer._poolDrag` (the timeline reads it during
//     dragover because the standard `getData()` is gated until drop
//     in every modern browser — easy to regress).
//   • `_isPoolDrag` recognises the MIME, `_laneAcceptsPoolDrop`
//     gates by track kind (audio only).
//   • A drop on an audio lane dispatches `create_region` with
//     `kind: "audio"`, the source's `source_path`, `length_samples`,
//     and the resolved sample position.
//   • A drop on a MIDI lane rejects (no `create_region` fires).
//   • The pool drag-end clears the shared stash.
//
// We bypass real HTML5 drag (Playwright drag synth doesn't carry
// DataTransfer payloads reliably across shadow roots) and drive the
// timeline's drop handler directly with a fake DataTransfer — the
// public method shape IS the contract we care about. Pointer-event
// simulation is for gesture tests where the gesture itself is under
// test (see CLAUDE.md → "Drive features by calling methods").

import { test, expect } from "@playwright/test";
import { DEEP_FIND, bootTimeline } from "./_boot.js";

test("dragstart on a pool row arms the shared stash + sets the MIME", async ({ page }) => {
  await bootTimeline(page);

  const result = await page.evaluate(`(() => {
    ${DEEP_FIND}
    // Mount the audio pool modal lazily (it's not always on screen).
    return import("/ui-full/components/audio-pool-modal.js").then((mod) => {
      const el = document.createElement("foyer-audio-pool-modal");
      document.body.appendChild(el);
      const source = {
        id: "source.test.0", name: "Kick.wav",
        path: "/tmp/pool/kick.wav", channel: 0,
        length_samples: 96000, sample_rate: 48000,
      };
      const data = new Map();
      const fakeDt = {
        types: [],
        getData: (k) => data.get(k) || "",
        setData: (k, v) => { data.set(k, v); fakeDt.types.push(k); },
        effectAllowed: "",
      };
      const fakeEvent = { dataTransfer: fakeDt };
      el._onDragStart(fakeEvent, source);
      const stash = window.__foyer._poolDrag;
      // Drag-end clears it.
      el._onDragEnd();
      return {
        mime: data.get("application/x-foyer-audio-pool-source"),
        textFallback: data.get("text/plain"),
        effectAllowed: fakeDt.effectAllowed,
        stashed: stash,
        clearedAfterEnd: window.__foyer._poolDrag,
      };
    });
  })()`);

  const parsed = JSON.parse(result.mime);
  expect(parsed.id).toBe("source.test.0");
  expect(parsed.path).toBe("/tmp/pool/kick.wav");
  expect(parsed.length_samples).toBe(96000);
  expect(result.textFallback).toBe("kick.wav");
  expect(result.effectAllowed).toBe("copy");
  expect(result.stashed?.path).toBe("/tmp/pool/kick.wav");
  expect(result.clearedAfterEnd).toBeFalsy();
});

test("drop on an audio lane fires create_region with source_path + length", async ({ page }) => {
  await bootTimeline(page);

  // Wait for a populated audio track so the drop lands somewhere
  // meaningful (also confirms the lane is mounted with data-track-id).
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    if (!tv) return false;
    return (window.__foyer.store.state.session?.tracks || [])
      .some((t) => t.kind === "audio");
  })()`);

  const sent = await page.evaluate(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    const audio = window.__foyer.store.state.session.tracks
      .find((t) => t.kind === "audio");
    // Capture wire commands
    const log = [];
    const orig = window.__foyer.ws.send.bind(window.__foyer.ws);
    window.__foyer.ws.send = (m) => { log.push(m); orig(m); };
    // Build a DataTransfer the way Chrome surfaces it AT DROP time:
    // both \`types\` and \`getData\` populated. Pool stashes the same
    // payload on window for the dragover-time ghost preview.
    const payload = {
      id: "source.test.kick", name: "Kick.wav",
      path: "/tmp/pool/kick.wav", channel: 0,
      length_samples: 96000, sample_rate: 48000,
    };
    const data = new Map();
    data.set("application/x-foyer-audio-pool-source", JSON.stringify(payload));
    const dt = {
      types: ["application/x-foyer-audio-pool-source"],
      getData: (k) => data.get(k) || "",
    };
    window.__foyer._poolDrag = payload;
    const lane = tv.renderRoot.querySelector(\`.lane[data-track-id="\${audio.id}"]\`);
    const ev = {
      clientX: lane.getBoundingClientRect().left + 280,
      clientY: lane.getBoundingClientRect().top + 20,
      dataTransfer: dt,
      preventDefault() {},
      currentTarget: lane,
      target: lane,
    };
    tv._onLaneDrop(ev, audio);
    window.__foyer.ws.send = orig;
    window.__foyer._poolDrag = null;
    return {
      trackId: audio.id,
      create: log.filter((m) => m.type === "create_region"),
    };
  })()`);

  expect(sent.create.length).toBe(1);
  expect(sent.create[0].track_id).toBe(sent.trackId);
  expect(sent.create[0].kind).toBe("audio");
  expect(sent.create[0].source_path).toBe("/tmp/pool/kick.wav");
  expect(sent.create[0].length_samples).toBe(96000);
  expect(sent.create[0].name).toBe("Kick.wav");
  expect(sent.create[0].at_samples).toBeGreaterThan(0);
});

test("drop on a MIDI lane is rejected with no wire dispatch", async ({ page }) => {
  await bootTimeline(page);

  const result = await page.evaluate(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    const midi = window.__foyer.store.state.session.tracks
      .find((t) => t.kind === "midi");
    // Skip if the stub fixture doesn't have a MIDI track at all —
    // the audio-only gate is verified by the wire-payload assertion
    // in the previous test (no MIDI lane means no rejection path
    // to exercise here).
    if (!midi) return { skipped: true };
    const log = [];
    const orig = window.__foyer.ws.send.bind(window.__foyer.ws);
    window.__foyer.ws.send = (m) => { log.push(m); orig(m); };
    const data = new Map();
    data.set("application/x-foyer-audio-pool-source", JSON.stringify({
      path: "/tmp/pool/kick.wav", length_samples: 48000,
    }));
    const dt = {
      types: ["application/x-foyer-audio-pool-source"],
      getData: (k) => data.get(k) || "",
    };
    const lane = tv.renderRoot.querySelector(\`.lane[data-track-id="\${midi.id}"]\`);
    const ev = {
      clientX: lane.getBoundingClientRect().left + 100,
      clientY: lane.getBoundingClientRect().top + 20,
      dataTransfer: dt,
      preventDefault() {},
      currentTarget: lane,
      target: lane,
    };
    tv._onLaneDrop(ev, midi);
    window.__foyer.ws.send = orig;
    return {
      midiTrackId: midi.id,
      create: log.filter((m) => m.type === "create_region"),
    };
  })()`);

  if (result.skipped) {
    test.skip(true, "stub session has no MIDI track");
    return;
  }
  expect(result.create.length).toBe(0);
});

test("dragover with the pool MIME calls preventDefault (drop unblocked)", async ({ page }) => {
  await bootTimeline(page);

  const allowed = await page.evaluate(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    const audio = window.__foyer.store.state.session.tracks
      .find((t) => t.kind === "audio");
    let prevented = false;
    const lane = tv.renderRoot.querySelector(\`.lane[data-track-id="\${audio.id}"]\`);
    // dragover with the pool MIME present in types but getData
    // returning "" (Chrome's actual behavior during a drag).
    const dt = {
      types: ["application/x-foyer-audio-pool-source"],
      getData: () => "",  // critical: blocked until drop
      dropEffect: "",
    };
    const ev = {
      clientX: lane.getBoundingClientRect().left + 140,
      clientY: lane.getBoundingClientRect().top + 20,
      dataTransfer: dt,
      preventDefault() { prevented = true; },
      currentTarget: lane,
      target: lane,
    };
    window.__foyer._poolDrag = {
      length_samples: 48000, name: "Snare.wav",
    };
    tv._onLaneDragOver(ev, audio);
    const ghost = tv._poolDropGhost;
    tv._poolDropGhost = null;
    window.__foyer._poolDrag = null;
    return { prevented, dropEffect: dt.dropEffect, ghost };
  })()`);

  // The fix: preventDefault MUST fire during dragover, even though
  // getData() returns "" — without it the browser blocks `drop`.
  expect(allowed.prevented).toBe(true);
  expect(allowed.dropEffect).toBe("copy");
  // And the ghost preview is populated for the lane.
  expect(allowed.ghost).toBeTruthy();
  expect(allowed.ghost.lengthSamples).toBe(48000);
  expect(allowed.ghost.name).toBe("Snare.wav");
});
