// `<foyer-beat-sequencer>` smoke + behavior. The sequencer mounts off
// the timeline-view in production via `_doOpenBeatSequencer`, but for
// the test we instantiate it directly and feed it a layout — same
// shape that path would build, minus the window chrome and the
// `foyer:regions-updated` plumbing (those are timeline-view's job and
// are out of scope here).
//
// What's covered:
//   * Default-layout boot doesn't throw, and the grid renders the
//     expected rows × steps shape.
//   * Programmatically mutating `layout.patterns[0].cells` flips the
//     matching `.cell` to `.on` after the next render — the
//     authoritative "is this cell active" derivation works through
//     `_isOnInPattern` and the render loop reads it cleanly.
//   * Switching to pitched mode keeps the grid intact (no layout
//     wipe; the regression here would be the v1→v2 migration loop
//     that froze on 2026-04-22).
//
// All assertions go through the element's shadow root — same surface
// as the user would see.

import { test, expect } from "@playwright/test";
import { primeSessionsList } from "./_boot.js";

const STEPS = 16;

/// Boot foyer + register the beat-sequencer module. Mirrors
/// `bootEditor` in midi-editor.spec.js but pulls in the sequencer.
async function bootSequencer(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.waitForFunction(() => typeof window.__foyer?.layout?.setTree === "function");
  await primeSessionsList(page);
  await page.evaluate(async () => {
    await import("/ui-full/components/beat-sequencer.js");
  });
}

/// Minimal v2 layout. Two patterns × 4 rows × `STEPS` steps per pattern.
/// Mirrors what `defaultLayout` would emit — kept hand-rolled here so
/// the test isn't coupled to the upstream factory's evolving choices.
function makeLayout(steps = STEPS) {
  const id = "p_test";
  return {
    version: 2,
    mode: "drum",
    resolution: 4,
    pattern_steps: steps,
    active: true,
    rows: [
      { pitch: 36, label: "Kick",  channel: 9, color: "#f59e0b" },
      { pitch: 38, label: "Snare", channel: 9, color: "#a78bfa" },
      { pitch: 42, label: "HH",    channel: 9, color: "#22d3ee" },
      { pitch: 49, label: "Crash", channel: 9, color: "#fb7185" },
    ],
    patterns: [{ id, name: "P1", color: "#7c5cff", cells: [], free_notes: [] }],
    arrangement: [{ pattern_id: id, bar: 0, arrangement_row: 0 }],
  };
}

async function mountSequencer(page, props) {
  return page.evaluateHandle((props) => {
    document.querySelectorAll("foyer-beat-sequencer").forEach((e) => e.remove());
    const el = document.createElement("foyer-beat-sequencer");
    Object.assign(el, props);
    document.body.appendChild(el);
    return el;
  }, props);
}

test.describe("foyer-beat-sequencer", () => {
  test("renders default drum layout without throwing", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await bootSequencer(page);
    const layout = makeLayout();
    const handle = await mountSequencer(page, {
      layout,
      notes: [],
      regionId: "r_test",
      regionName: "Beat smoke",
      trackId: "t_test",
      trackRegions: [],
    });
    await handle.evaluate((el) => el.updateComplete);

    const probe = await handle.evaluate((el) => {
      const root = el.shadowRoot;
      return {
        gridRows: root.querySelectorAll(".grid-row").length,
        cells: root.querySelectorAll(".cell").length,
      };
    });

    // 4 rows × 16 steps = 64 cells, no covered/spanned cells in a
    // freshly-empty pattern.
    expect(probe.gridRows).toBe(4);
    expect(probe.cells).toBe(4 * STEPS);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("a cell flips to .on after layout.cells mutation", async ({ page }) => {
    await bootSequencer(page);
    const layout = makeLayout();
    const handle = await mountSequencer(page, {
      layout,
      notes: [],
      regionId: "r_test",
      regionName: "Toggle smoke",
      trackId: "t_test",
      trackRegions: [],
    });
    await handle.evaluate((el) => el.updateComplete);

    // Pre-state: no .on cells in row=0/step=0.
    const before = await handle.evaluate((el) => {
      const cell = el.shadowRoot.querySelector('.cell[data-row="0"][data-step="0"]');
      return { exists: !!cell, on: !!cell?.classList.contains("on") };
    });
    expect(before.exists).toBe(true);
    expect(before.on).toBe(false);

    // Push a fresh layout reference (Lit's hasChanged is identity, so
    // mutating in place wouldn't trigger a re-render; that's also how
    // production sets it via `bindRegion`).
    await handle.evaluate((el) => {
      const next = JSON.parse(JSON.stringify(el.layout));
      next.patterns[0].cells.push({ row: 0, step: 0, velocity: 100, length_steps: 1 });
      el.layout = next;
    });
    await handle.evaluate((el) => el.updateComplete);

    const after = await handle.evaluate((el) => {
      const cell = el.shadowRoot.querySelector('.cell[data-row="0"][data-step="0"]');
      return { on: !!cell?.classList.contains("on") };
    });
    expect(after.on).toBe(true);
  });

  test("switching to pitched mode keeps the grid intact", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await bootSequencer(page);
    const layout = makeLayout();
    const handle = await mountSequencer(page, {
      layout,
      notes: [],
      regionId: "r_test",
      regionName: "Pitched switch",
      trackId: "t_test",
      trackRegions: [],
    });
    await handle.evaluate((el) => el.updateComplete);

    await handle.evaluate((el) => {
      const next = JSON.parse(JSON.stringify(el.layout));
      next.mode = "pitched";
      // Pitched mode demands at least one row with a pitch — keep the
      // four drum rows; the component's normalizer reads `pitch` per
      // row, not the mode label, so this is a clean stay-here switch.
      el.layout = next;
    });
    await handle.evaluate((el) => el.updateComplete);

    const probe = await handle.evaluate((el) => ({
      gridRows: el.shadowRoot.querySelectorAll(".grid-row").length,
      cells: el.shadowRoot.querySelectorAll(".cell").length,
      mode: el.layout?.mode,
    }));

    expect(probe.mode).toBe("pitched");
    expect(probe.gridRows).toBe(4);
    expect(probe.cells).toBe(4 * STEPS);
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
