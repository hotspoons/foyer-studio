// Timeline quantization grid honors time-signature changes.
// Regression: pre-fix, the grid keyed only on transport.tempo and
// drew every quarter-note as a beat — changing ts.num/ts.den had
// no visible effect. The fix adds a `.bar` line tier that lands
// every ts.num beats, and scales beat duration by 4/ts.den so a
// 6/8 grid steps in eighths.

import { test, expect } from "@playwright/test";

const DEEP_FIND = `
  function deepFind(tag) {
    const stack = [document.querySelector("foyer-app").shadowRoot];
    while (stack.length) {
      const r = stack.pop();
      const hit = r.querySelector(tag);
      if (hit) return hit;
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) stack.push(el.shadowRoot);
    }
    return null;
  }
`;

async function bootTimelineWithGrid(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/");
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
  await page.waitForFunction(
    () => typeof window.__foyer?.layout?.setTree === "function",
  );
  await page.evaluate(() => {
    window.__foyer.layout.setTree({
      kind: "leaf", id: "test_t", view: "timeline", props: {},
    });
  });
  await page.waitForFunction(`(() => {
    ${DEEP_FIND}
    return !!deepFind("foyer-timeline-view");
  })()`);
  // Force the grid on regardless of localStorage prefs from prior runs.
  await page.evaluate(`(() => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    if (!tv._quantOn) tv._toggleQuantOn();
  })()`);
}

async function lineTiers(page, n = 16) {
  return page.evaluate(`(async () => {
    ${DEEP_FIND}
    const tv = deepFind("foyer-timeline-view");
    // Two RAFs to let the grid template re-render after a ts change.
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    return Array.from(tv.shadowRoot.querySelectorAll(".quant-line"))
      .slice(0, ${n})
      .map((el) => el.classList.contains("bar") ? "bar"
                : el.classList.contains("beat") ? "beat"
                : el.classList.contains("sub") ? "sub"
                : "?");
  })()`);
}

test.describe("timeline grid honors time signature", () => {
  test.setTimeout(60_000);

  test("4/4 places a bar line every 4 beats", async ({ page }) => {
    await bootTimelineWithGrid(page);
    await page.evaluate(() => {
      window.__foyer.ws.controlSet("transport.ts.num", 4);
      window.__foyer.ws.controlSet("transport.ts.den", 4);
    });
    await page.waitForFunction(
      () => window.__foyer.store.state.controls.get("transport.ts.num") === 4
        && window.__foyer.store.state.controls.get("transport.ts.den") === 4,
    );
    const tiers = await lineTiers(page, 24);
    // First line is always a bar (offset 0). Whatever subsPerBeat the
    // user has set, the next bar lands every 4 beats. Find the bar
    // indices and assert spacing.
    const barIdx = tiers.map((t, i) => (t === "bar" ? i : -1)).filter((i) => i >= 0);
    expect(barIdx.length).toBeGreaterThanOrEqual(2);
    const spacing = barIdx[1] - barIdx[0];
    // 4 beats × subsPerBeat. subsPerBeat depends on the dropdown but
    // must be a positive integer; the spacing is therefore 4 × N.
    expect(spacing % 4).toBe(0);
  });

  test("6/8 puts the bar line every 6 grid positions (1 sub/beat)", async ({ page }) => {
    await bootTimelineWithGrid(page);
    // Force the dropdown to 1/8 so subsPerBeat resolves to 1 in 6/8
    // (max(1, round(8/8)) = 1) — gives a deterministic per-position
    // accounting where every step IS a beat.
    await page.evaluate(`(() => {
      ${DEEP_FIND}
      deepFind("foyer-timeline-view")._setQuantDiv(8);
    })()`);
    await page.evaluate(() => {
      window.__foyer.ws.controlSet("transport.ts.num", 6);
      window.__foyer.ws.controlSet("transport.ts.den", 8);
    });
    await page.waitForFunction(
      () => window.__foyer.store.state.controls.get("transport.ts.num") === 6
        && window.__foyer.store.state.controls.get("transport.ts.den") === 8,
    );
    const tiers = await lineTiers(page, 18);
    const barIdx = tiers.map((t, i) => (t === "bar" ? i : -1)).filter((i) => i >= 0);
    expect(barIdx[0]).toBe(0);
    expect(barIdx[1]).toBe(6); // 6 beats per bar in 6/8
    // Beats 1..5 between bars are all "beat".
    for (let i = 1; i < 6; i++) expect(tiers[i]).toBe("beat");
  });

  test("changing ts.num updates the rendered bar interval live", async ({ page }) => {
    await bootTimelineWithGrid(page);
    await page.evaluate(`(() => {
      ${DEEP_FIND}
      deepFind("foyer-timeline-view")._setQuantDiv(8);
    })()`);

    // Snapshot bar spacing as a function of the current ts.num. Done
    // twice — once before and once after a ts.num change — so the
    // assertion only depends on what the live store says, not on
    // assumptions about subsPerBeat (which depends on ts.den, and the
    // stub WS occasionally drops back-to-back transport.* writes).
    async function snapshot() {
      const tiers = await lineTiers(page, 24);
      const barIdx = tiers.map((t, i) => (t === "bar" ? i : -1)).filter((i) => i >= 0);
      const spacing = barIdx.length >= 2 ? barIdx[1] - barIdx[0] : null;
      const tsNum = await page.evaluate(
        () => window.__foyer.store.state.controls.get("transport.ts.num"),
      );
      return { spacing, tsNum };
    }

    await page.evaluate(() => window.__foyer.ws.controlSet("transport.ts.num", 4));
    await page.waitForFunction(
      () => window.__foyer.store.state.controls.get("transport.ts.num") === 4,
    );
    const before = await snapshot();

    await page.evaluate(() => window.__foyer.ws.controlSet("transport.ts.num", 3));
    await page.waitForFunction(
      () => window.__foyer.store.state.controls.get("transport.ts.num") === 3,
    );
    const after = await snapshot();

    // Spacing must scale linearly with ts.num (subsPerBeat is constant
    // across the change since ts.den didn't move).
    expect(after.spacing * before.tsNum).toBe(before.spacing * after.tsNum);
    // Sanity: the spacing actually CHANGED, confirming the grid
    // re-rendered. Pre-fix the spacing wouldn't move regardless of ts.
    expect(after.spacing).not.toBe(before.spacing);
  });
});
