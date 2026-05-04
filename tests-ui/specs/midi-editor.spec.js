// `<foyer-midi-editor>` renders + a few behaviors. The editor mounts
// off-tree (we attach to document.body, not inside foyer-app's shadow)
// so the test stays focused on the component itself, not the
// timeline / right-dock plumbing that wires it to a real region. The
// production open path in `openMidiEditor()` does the same shape:
// `document.createElement` + property assignment.
//
// What's covered:
//   * Boots cleanly under chromatic mode (TDZ regression guard — the
//     `scaleHL` const block used to live below the loop that read it,
//     which crashed first paint with `Cannot access 'scaleHL' before
//     initialization`).
//   * Boots cleanly under a major scale (covers the same const block
//     under the highlighted-lanes branch).
//   * The notes prop renders one `.note` element per note.
//   * Read-only banner appears when the region carries an active
//     foyer_sequencer layout — that's the "sequencer-owned, piano-roll
//     would clobber" gate the editor enforces against accidental edits.

import { test, expect } from "@playwright/test";
import { primeSessionsList, DEEP_FIND } from "./_boot.js";

const DEEP = `
  ${DEEP_FIND}
  function deepFindAll(tag) {
    const out = [];
    const stack = [document.querySelector("foyer-app").shadowRoot];
    while (stack.length) {
      const r = stack.pop();
      for (const el of r.querySelectorAll(tag)) out.push(el);
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) stack.push(el.shadowRoot);
    }
    return out;
  }
`;

/// Boot foyer + ensure the midi-editor module has been registered
/// (so `document.createElement("foyer-midi-editor")` returns the real
/// class, not an HTMLUnknownElement).
async function bootEditor(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.waitForFunction(() => typeof window.__foyer?.layout?.setTree === "function");
  await primeSessionsList(page);
  // Force registration. The variant's main app already pulls this in
  // via static-html-rendered `foyer-midi-editor` references but a fresh
  // boot may not have hit a path that exercises it yet.
  await page.evaluate(async () => {
    await import("/ui-full/components/midi-editor.js");
  });
}

/// Mount a `<foyer-midi-editor>` into document.body, configured per
/// `props`. Returns a JS handle that subsequent `evaluateHandle` /
/// `evaluate` calls can reach back through.
async function mountEditor(page, props) {
  return page.evaluateHandle((props) => {
    // Tear down any prior editor so each test's assertions see a clean
    // shadow DOM — Lit elements are reactive, but accumulating stale
    // ones across tests makes count-based asserts fragile.
    document.querySelectorAll("foyer-midi-editor").forEach((e) => e.remove());
    const el = document.createElement("foyer-midi-editor");
    Object.assign(el, props);
    document.body.appendChild(el);
    return el;
  }, props);
}

test.describe("foyer-midi-editor", () => {
  test("renders without throwing in chromatic mode (TDZ guard)", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await bootEditor(page);
    // Force chromatic mode (no scale highlighting). The TDZ regression
    // hit *both* branches of the highlighting check, so we want to
    // exercise the no-highlight path explicitly.
    await page.evaluate(() => {
      try { localStorage.setItem("foyer.midi.scale.mode", "chromatic"); } catch {}
    });

    const handle = await mountEditor(page, {
      notes: [
        { id: "n1", pitch: 60, start_ticks: 0,    length_ticks: 240, velocity: 100 },
        { id: "n2", pitch: 64, start_ticks: 240,  length_ticks: 240, velocity:  90 },
        { id: "n3", pitch: 67, start_ticks: 480,  length_ticks: 240, velocity:  80 },
      ],
      regionId: "r_test",
      regionName: "Test region",
      ppqn: 960,
    });

    // `updateComplete` resolves after Lit has painted; if the render
    // threw, this rejects.
    await handle.evaluate((el) => el.updateComplete);

    const probe = await handle.evaluate((el) => ({
      noteCount: el.shadowRoot.querySelectorAll(".note").length,
      hasCanvas: !!el.shadowRoot.querySelector(".notes-canvas"),
      hasKeyboard: !!el.shadowRoot.querySelector(".keyboard"),
    }));
    expect(probe.hasCanvas).toBe(true);
    expect(probe.hasKeyboard).toBe(true);
    expect(probe.noteCount).toBe(3);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("renders cleanly with scale highlighting on", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });

    await bootEditor(page);
    await page.evaluate(() => {
      try {
        localStorage.setItem("foyer.midi.scale.mode", "major");
        localStorage.setItem("foyer.midi.scale.root", "0");
      } catch {}
    });

    const handle = await mountEditor(page, {
      notes: [
        { id: "n1", pitch: 60, start_ticks: 0,   length_ticks: 240, velocity: 100 },
      ],
      regionId: "r_test",
      regionName: "Major scale",
      ppqn: 960,
    });
    await handle.evaluate((el) => el.updateComplete);

    const probe = await handle.evaluate((el) => ({
      laneCount: el.shadowRoot.querySelectorAll(".scale-lane").length,
      canvasHasHl: el.shadowRoot.querySelector(".notes-canvas")?.classList.contains("scale-hl-on"),
    }));
    // At least one root + several in/out lanes should render across
    // the visible pitch range.
    expect(probe.laneCount).toBeGreaterThan(0);
    expect(probe.canvasHasHl).toBe(true);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("read-only banner appears for sequencer-owned regions", async ({ page }) => {
    await bootEditor(page);

    const handle = await mountEditor(page, {
      notes: [],
      regionId: "r_seq",
      regionName: "Sequencer region",
      ppqn: 960,
      readOnly: true,
      sequencerLayout: { active: true, rows: [], steps: 16, beats: 4 },
    });
    await handle.evaluate((el) => el.updateComplete);

    // The editor's banner / readonly state is the load-bearing UX hook
    // — assert it's reachable, regardless of exact wording.
    const probe = await handle.evaluate((el) => {
      const root = el.shadowRoot;
      const text = root.textContent || "";
      return {
        // Banner has its own class (`.banner` or `.readonly-banner`
        // depending on revision); fall back to a substring scan so
        // copy tweaks don't break the test.
        bannerVisible: /sequencer|read.?only|convert/i.test(text),
        notesCanvasInteractive:
          !root.querySelector(".notes-canvas")?.classList.contains("readonly"),
      };
    });
    expect(probe.bannerVisible).toBe(true);
  });
});
