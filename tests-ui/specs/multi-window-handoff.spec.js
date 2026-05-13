// Verifies the cross-window UX additions:
//   1. `identifyAllWindows()` paints a transient overlay on the
//      caller AND broadcasts to every sibling, so they paint too.
//   2. The pane-handoff transport carries a `floating-tile` payload
//      from one window to another; the receiver re-spawns it via
//      `LayoutStore.sendToTiles` (fallback path) or `openFloating`.

import { test, expect } from "@playwright/test";

async function openFamily(ctx) {
  const primary = await ctx.newPage();
  await primary.goto("/");
  await primary.waitForFunction(
    () => window.__foyer?.store?.state?.connection?.peerId,
    null,
    { timeout: 10_000 },
  );
  const peerId = await primary.evaluate(
    () => window.__foyer.store.state.connection.peerId,
  );
  const secondary = await ctx.newPage();
  await secondary.goto(`/?parent=${peerId}&slot=1`);
  await secondary.waitForFunction(
    () => window.__foyer?.store?.state?.connection?.peerId,
    null,
    { timeout: 10_000 },
  );
  // Wait for sibling hellos.
  await primary.waitForFunction(
    () => (window.__foyer.multiWindow?.siblings || []).length === 1,
    null,
    { timeout: 3000 },
  );
  await secondary.waitForFunction(
    () => (window.__foyer.multiWindow?.siblings || []).length === 1,
    null,
    { timeout: 3000 },
  );
  // Wait for the UI variant's `<foyer-app>` to mount on BOTH windows
  // — `__foyer.layout` is published in its `connectedCallback`,
  // which lands a few hundred ms after the greeting. Without this
  // wait, evaluate-time reads of `__foyer.layout` can race the
  // variant boot and see `undefined`.
  await primary.waitForFunction(
    () => typeof window.__foyer?.layout?.openFloating === "function",
    null,
    { timeout: 10_000 },
  );
  await secondary.waitForFunction(
    () => typeof window.__foyer?.layout?.openFloating === "function",
    null,
    { timeout: 10_000 },
  );
  return { primary, secondary };
}

test("identifyAllWindows flashes the Window N overlay on every sibling", async ({ browser }) => {
  const ctx = await browser.newContext();
  const { primary, secondary } = await openFamily(ctx);

  // Trigger from the primary.
  await primary.evaluate(() => window.__foyer.identifyAllWindows({ durationMs: 4000 }));

  // Both windows should have a visible overlay with the right number.
  const overlayVisible = async (page, expectedText) => {
    return await page.waitForFunction(
      (txt) => {
        const el = document.getElementById("foyer-window-identify-overlay");
        if (!el) return false;
        if (el.style.display !== "flex") return false;
        if (el.style.opacity === "0") return false;
        const num = el.querySelector('[data-role="number"]')?.textContent;
        return num === txt;
      },
      expectedText,
      { timeout: 3000 },
    );
  };

  await overlayVisible(primary, "1");
  await overlayVisible(secondary, "2");

  // Explicit hide propagates.
  await primary.evaluate(() => window.__foyer.hideAllWindowIdentifiers());
  await primary.waitForFunction(
    () => {
      const el = document.getElementById("foyer-window-identify-overlay");
      return !el || el.style.opacity === "0";
    },
    null,
    { timeout: 3000 },
  );
  await secondary.waitForFunction(
    () => {
      const el = document.getElementById("foyer-window-identify-overlay");
      return !el || el.style.opacity === "0";
    },
    null,
    { timeout: 3000 },
  );
});

test("floating-tile handoff lands on the receiving window's float list", async ({ browser }) => {
  const ctx = await browser.newContext();
  const { primary, secondary } = await openFamily(ctx);

  // Primary sends a floating-tile payload to the secondary. We use the
  // bundled `console` view since it's registered in every UI variant
  // and doesn't depend on session state.
  const secondaryConnId = await secondary.evaluate(
    () => window.__foyer.multiWindow.connectionId,
  );
  // Snapshot the receiver's float count beforehand so we can assert
  // additivity. `floating-tile` payloads land via `layout.openFloating`
  // which appends to the float list — not the tile tree.
  const before = await secondary.evaluate(
    () => (window.__foyer.layout?.floating?.() || []).length,
  );

  const ok = await primary.evaluate(async (target) => {
    const m = await import("/ui-core/layout/pane-handoff.js");
    return m.sendFloatingTile({
      targetConnectionId: target,
      view: "console",
      props: {},
    });
  }, secondaryConnId);
  expect(ok).toBe(true);

  // Receiver should mount a new floating entry. We wait on the float
  // list rather than tree leaves because `openFloating` does NOT add
  // to the tile tree.
  await secondary.waitForFunction(
    (prev) => {
      const floats = window.__foyer.layout?.floating?.() || [];
      return floats.length > prev && floats.some((f) => f.view === "console");
    },
    before,
    { timeout: 3000 },
  );
});

