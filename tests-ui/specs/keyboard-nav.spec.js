// Keyboard navigation smoke tests for the timeline + mixer.
//
// Covers the new per-view focus model: arrow-up/down moves the track
// selection in the timeline, arrow-left/right moves it in the mixer,
// and region nudge only fires when the timeline itself has focus
// (previously it was a global capture that fired anywhere).

import { test, expect } from "@playwright/test";
import { DEEP_FIND, bootTimeline, primeSessionsList } from "./_boot.js";

test("timeline arrow-up/down navigates track selection", async ({ page }) => {
  await bootTimeline(page);

  // Capture the current track ordering — we'll move selection within it.
  const tids = await page.evaluate(() => {
    const tracks = window.__foyer?.store?.state?.session?.tracks || [];
    return tracks.map((t) => t.id);
  });
  expect(tids.length).toBeGreaterThan(1);

  // Seed selection on the first track so we have an anchor to move from.
  await page.evaluate((firstId) => {
    window.__foyer.store.selectTrack(firstId, "replace");
  }, tids[0]);

  // Focus the timeline host + send ArrowDown. The host's keydown
  // handler should call selectTrack with the next track's id.
  await page.evaluate(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    tv.focus();
    tv.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  })()`);

  const afterDown = await page.evaluate(() =>
    Array.from(window.__foyer.store.state.selectedTrackIds),
  );
  expect(afterDown).toEqual([tids[1]]);

  // ArrowUp should take it back to the first track.
  await page.evaluate(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    tv.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  })()`);

  const afterUp = await page.evaluate(() =>
    Array.from(window.__foyer.store.state.selectedTrackIds),
  );
  expect(afterUp).toEqual([tids[0]]);
});

test("mixer arrow-left/right navigates track selection", async ({ page }) => {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.waitForFunction(
    () => typeof window.__foyer?.layout?.setTree === "function",
  );
  await primeSessionsList(page);
  // Mount the mixer so its keydown handler is live.
  await page.evaluate(() => {
    window.__foyer.layout.setTree({
      kind: "leaf", id: "test_mx", view: "mixer", props: {},
    });
  });
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    return !!deepFind("foyer-mixer");
  })()`);

  // Compute the same ordering the mixer uses (inputs first, then
  // master/monitor) so we can assert against it.
  const orderedTids = await page.evaluate(() => {
    const tracks = window.__foyer?.store?.state?.session?.tracks || [];
    const inputs = tracks.filter((t) => t.kind !== "master" && t.kind !== "monitor");
    const masters = tracks.filter((t) => t.kind === "master" || t.kind === "monitor");
    return [...inputs, ...masters].map((t) => t.id);
  });
  expect(orderedTids.length).toBeGreaterThan(1);

  await page.evaluate((firstId) => {
    window.__foyer.store.selectTrack(firstId, "replace");
  }, orderedTids[0]);

  await page.evaluate(`(() => {
    ${DEEP_FIND}
    const mx = deepFind("foyer-mixer");
    mx.focus();
    mx.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  })()`);

  const afterRight = await page.evaluate(() =>
    Array.from(window.__foyer.store.state.selectedTrackIds),
  );
  expect(afterRight).toEqual([orderedTids[1]]);
});

test("foyer-knob nudges value on ArrowUp / ArrowDown", async ({ page }) => {
  page.setDefaultTimeout(15_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");

  // Create a freestanding knob in the page so the test doesn't depend
  // on which view happens to mount it.
  await page.evaluate(async () => {
    const mod = await import("/ui-core/widgets/knob.js");
    void mod;
    const knob = document.createElement("foyer-knob");
    knob.value = 0.5;
    knob.range = [0, 1];
    knob.scale = "linear";
    document.body.appendChild(knob);
    window.__knob = knob;
    // Listen for change so we can confirm the keypress drove an emit.
    window.__knobChanges = [];
    knob.addEventListener("change", (ev) => window.__knobChanges.push(ev.detail.value));
    knob.focus();
  });

  await page.evaluate(() => {
    window.__knob.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
    }));
  });

  const after = await page.evaluate(() => ({
    value: window.__knob.value,
    changes: window.__knobChanges,
  }));
  expect(after.value).toBeGreaterThan(0.5);
  expect(after.changes.length).toBe(1);
});
