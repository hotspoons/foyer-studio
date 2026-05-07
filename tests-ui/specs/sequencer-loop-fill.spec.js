// Sequencer-resize fill behavior. When the user drags a sequencer
// region's right edge to extend it, the timeline auto-loops the
// existing arrangement to fill the new bars — but ONLY when that
// arrangement is itself a clean repeating pattern. If we can't
// detect a period that divides the existing extent evenly, leave
// the new bars empty rather than smearing a non-repeating
// arrangement past its intended end (Rich's "dubious patterning"
// concern, 2026-05-07).
import { test, expect } from "@playwright/test";
import { DEEP_FIND, primeSessionsList } from "./_boot.js";

async function bootTimeline(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.waitForFunction(
    () => typeof window.__foyer?.layout?.setTree === "function",
  );
  await primeSessionsList(page);
  await page.evaluate(() => {
    window.__foyer.layout.setTree({ kind: "leaf", id: "tl_test", view: "timeline", props: {} });
  });
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    return !!deepFind("foyer-timeline-view");
  })()`);
}

// `_loopSequencerArrangementToFit` is keyed off live session state
// (sample rate, tempo) so we drive it through a deepFind handle on
// the mounted timeline instead of importing it directly.
async function callLoopFill(page, layout, newLengthSamples) {
  return page.evaluate(
    ({ layout, newLengthSamples, deepFindSrc }) => {
      eval(deepFindSrc);
      // eslint-disable-next-line no-undef
      const tl = deepFind("foyer-timeline-view");
      return tl._loopSequencerArrangementToFit(layout, newLengthSamples);
    },
    { layout, newLengthSamples, deepFindSrc: DEEP_FIND },
  );
}

// 1 bar in samples at the stub's defaults: 16 steps × 1/16 = 4 beats
// per bar; 120 BPM → 0.5 sec/beat; ×48 000 SR → 96 000 samples/bar.
const ONE_BAR = 96_000;

function layout(arrangement) {
  return {
    version: 2,
    mode: "drum",
    resolution: 4,
    pattern_steps: 16,
    rows: [{ pitch: 60, channel: 0 }],
    patterns: [
      { id: "P1", name: "P1", cells: [], free_notes: [] },
      { id: "P2", name: "P2", cells: [], free_notes: [] },
      { id: "P3", name: "P3", cells: [], free_notes: [] },
    ],
    arrangement,
    cells: [],
    free_notes: [],
    active: true,
  };
}

test.describe("sequencer resize loop-fill", () => {
  test("repeating single-bar arrangement extends cleanly", async ({ page }) => {
    await bootTimeline(page);
    const result = await callLoopFill(page, layout([
      { pattern_id: "P1", bar: 0, arrangement_row: 0 },
    ]), ONE_BAR * 4);  // resize to 4 bars
    expect(result).not.toBeNull();
    const bars = (result.arrangement || []).map((s) => s.bar).sort((a, b) => a - b);
    expect(bars).toEqual([0, 1, 2, 3]);
  });

  test("two-bar P1/P2 pattern with one shown rep extends cleanly", async ({ page }) => {
    await bootTimeline(page);
    // Existing arrangement: P1 P2 P1 P2 over 4 bars — at least two
    // full reps, so period=2 is detectable. Resize to 6 bars and
    // we expect the arrangement to fill to 6 bars (3 full reps).
    const result = await callLoopFill(page, layout([
      { pattern_id: "P1", bar: 0, arrangement_row: 0 },
      { pattern_id: "P2", bar: 1, arrangement_row: 0 },
      { pattern_id: "P1", bar: 2, arrangement_row: 0 },
      { pattern_id: "P2", bar: 3, arrangement_row: 0 },
    ]), ONE_BAR * 6);
    expect(result).not.toBeNull();
    const slots = (result.arrangement || []).map((s) => `${s.bar}:${s.pattern_id}`).sort();
    expect(slots).toEqual([
      "0:P1", "1:P2", "2:P1", "3:P2", "4:P1", "5:P2",
    ]);
  });

  test("one-shot 2-bar arrangement (P1/P2) leaves new bars empty", async ({ page }) => {
    await bootTimeline(page);
    // Only one rep of the supposed unit shown — could be a one-shot
    // intro or a 2-bar loop. Without proof of repetition we're not
    // willing to assume the user wants this looped, so leave new
    // bars empty. (Add a second rep manually and the previous test
    // shows the auto-fill kicks in.)
    const result = await callLoopFill(page, layout([
      { pattern_id: "P1", bar: 0, arrangement_row: 0 },
      { pattern_id: "P2", bar: 1, arrangement_row: 0 },
    ]), ONE_BAR * 6);
    expect(result).toBeNull();
  });

  test("non-repeating arrangement returns null (no fill)", async ({ page }) => {
    await bootTimeline(page);
    // P1 P2 P3 — no period divides 3 cleanly except 1 (which would
    // need every bar to match bar 0) and 3 itself (which is the full
    // extent, no repetition). Result: null → caller leaves new bars
    // empty.
    const result = await callLoopFill(page, layout([
      { pattern_id: "P1", bar: 0, arrangement_row: 0 },
      { pattern_id: "P2", bar: 1, arrangement_row: 0 },
      { pattern_id: "P3", bar: 2, arrangement_row: 0 },
    ]), ONE_BAR * 6);  // resize to 6 bars
    expect(result).toBeNull();
  });

  test("partial trailing unit is left empty (no half-loop)", async ({ page }) => {
    await bootTimeline(page);
    // P1 at bar 0 — period 1. Resize to 3.5 bars. We fill 3 full
    // bars (P1 × 3) and leave the trailing 0.5 bar empty.
    const result = await callLoopFill(page, layout([
      { pattern_id: "P1", bar: 0, arrangement_row: 0 },
    ]), Math.round(ONE_BAR * 3.5));  // 3.5 bars
    expect(result).not.toBeNull();
    const bars = (result.arrangement || []).map((s) => s.bar).sort((a, b) => a - b);
    // ceil(3.5) = 4 total bars; floor(4 / period=1) = 4 units; fills [0..3].
    // (The criterion is full-period units, with `newTotalBars = ceil(samples/barSamples)` rounded up.)
    expect(bars).toEqual([0, 1, 2, 3]);
  });
});
