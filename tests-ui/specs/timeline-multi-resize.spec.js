// Drag-resize on a track that's part of a multi-track selection
// should resize every selected track by the same delta. Mirrors the
// standard DAW expectation that bulk-edit ops follow the selection.
//
// Notes for future agents poking at this spec:
//   1. `__foyer.layout.setTree` only becomes available AFTER foyer-app's
//      constructor runs; that lags `status === "open"` by a few hundred
//      ms in a cold headless boot. Wait on the actual capability, not
//      on the smoke-test's visibility check.
//   2. `<foyer-timeline-view>` lives nested two shadow roots deep:
//      foyer-app → foyer-tile-container → foyer-tile-leaf → here.
//      `document.querySelector` skips closed shadow roots; use the
//      `deepFind` walk below or `page.locator(...).shadowRoot`-style
//      composed selectors.

import { test, expect } from "@playwright/test";
import { DEEP_FIND, bootTimeline } from "./_boot.js";

async function bootAndMountTimeline(page) {
  await bootTimeline(page);
  await page.waitForFunction(
    () => (window.__foyer?.store?.state?.session?.tracks?.length ?? 0) >= 3,
    { timeout: 20_000 },
  );
}

async function runResize(page, { trackId, dy, shift = false }) {
  await page.evaluate(
    ({ trackId, dy, shift, deepFindSrc }) => {
      // eslint-disable-next-line no-eval
      eval(deepFindSrc);
      // eslint-disable-next-line no-undef
      const tv = deepFind("foyer-timeline-view");
      tv._startLaneResize(
        {
          clientY: 100,
          shiftKey: shift,
          preventDefault() {},
          stopPropagation() {},
        },
        trackId,
      );
      window.dispatchEvent(new PointerEvent("pointermove", { clientY: 100 + dy }));
      window.dispatchEvent(new PointerEvent("pointerup"));
    },
    { trackId, dy, shift, deepFindSrc: DEEP_FIND },
  );
}

async function heights(page, ids) {
  return page.evaluate(
    ({ ids, deepFindSrc }) => {
      // eslint-disable-next-line no-eval
      eval(deepFindSrc);
      // eslint-disable-next-line no-undef
      const tv = deepFind("foyer-timeline-view");
      return ids.map((id) => tv._laneHeightFor(id));
    },
    { ids, deepFindSrc: DEEP_FIND },
  );
}

async function setSelection(page, ids) {
  await page.evaluate((ids) => {
    const sel = window.__foyer.store.state.selectedTrackIds;
    sel.clear();
    for (const id of ids) sel.add(id);
  }, ids);
}

test.describe("timeline lane-resize selection awareness", () => {
  test.setTimeout(60_000);

  test("dragging a selected track resizes every selected track", async ({ page }) => {
    await bootAndMountTimeline(page);
    const ids = await page.evaluate(() => {
      return window.__foyer.store.state.session.tracks.slice(0, 3).map((t) => t.id);
    });
    await setSelection(page, [ids[0], ids[1]]);
    const before = await heights(page, ids);
    await runResize(page, { trackId: ids[0], dy: 40 });
    const after = await heights(page, ids);
    expect(after[0]).toBe(before[0] + 40);
    expect(after[1]).toBe(before[1] + 40);
    expect(after[2]).toBe(before[2]); // unselected lane unchanged
  });

  test("dragging an UNselected track resizes only that track", async ({ page }) => {
    await bootAndMountTimeline(page);
    const ids = await page.evaluate(() =>
      window.__foyer.store.state.session.tracks.slice(0, 3).map((t) => t.id),
    );
    await setSelection(page, [ids[0], ids[1]]);
    const before = await heights(page, ids);
    await runResize(page, { trackId: ids[2], dy: 25 });
    const after = await heights(page, ids);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2] + 25);
  });

  test("Shift-drag resizes every track regardless of selection", async ({ page }) => {
    await bootAndMountTimeline(page);
    const ids = await page.evaluate(() =>
      window.__foyer.store.state.session.tracks.slice(0, 3).map((t) => t.id),
    );
    await setSelection(page, []); // no selection
    const before = await heights(page, ids);
    await runResize(page, { trackId: ids[0], dy: 10, shift: true });
    const after = await heights(page, ids);
    expect(after[0]).toBe(before[0] + 10);
    expect(after[1]).toBe(before[1] + 10);
    expect(after[2]).toBe(before[2] + 10);
  });

  test("single-selection drag is the same as no-selection drag", async ({ page }) => {
    await bootAndMountTimeline(page);
    const ids = await page.evaluate(() =>
      window.__foyer.store.state.session.tracks.slice(0, 3).map((t) => t.id),
    );
    await setSelection(page, [ids[1]]); // single track selected
    const before = await heights(page, ids);
    await runResize(page, { trackId: ids[1], dy: 15 });
    const after = await heights(page, ids);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1] + 15);
    expect(after[2]).toBe(before[2]);
  });
});
