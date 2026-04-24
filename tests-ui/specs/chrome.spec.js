// Higher-signal smoke: the shipping UI actually paints its chrome
// (menu bar, transport bar, status bar) after the first snapshot.

import { test, expect } from "@playwright/test";

test.describe("shipping UI chrome", () => {
  test("top-bar surfaces mount", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("foyer-app")).toBeVisible({ timeout: 5000 });

    // Each of these is defined in ui/components and wires into the app
    // shell's render(). If any of them fail to upgrade as custom
    // elements the shell still paints but they render as empty boxes —
    // this test makes that case loud.
    await page.waitForFunction(() =>
      !!customElements.get("foyer-main-menu") &&
      !!customElements.get("foyer-transport-bar") &&
      !!customElements.get("foyer-status-bar"));

    await expect(page.locator("foyer-main-menu")).toHaveCount(1);
    await expect(page.locator("foyer-transport-bar")).toHaveCount(1);
    await expect(page.locator("foyer-status-bar")).toHaveCount(1);
  });

  test("tile container custom element is upgraded", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("foyer-app")).toBeVisible({ timeout: 5000 });
    // Stub backend in launcher mode hides the tile tree behind a
    // welcome screen until the user picks a project. We only assert
    // the custom element itself upgraded — proving tile-container.js
    // loaded without throwing and registered. Tile-instance rendering
    // is covered by per-surface tests once we have a recorded session
    // fixture to boot into.
    await page.waitForFunction(() => !!customElements.get("foyer-tile-container"));
    const defined = await page.evaluate(() => !!customElements.get("foyer-tile-container"));
    expect(defined).toBe(true);
  });

  test("view registry has the expected defaults", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => !!customElements.get("foyer-mixer"));
    const viewIds = await page.evaluate(async () => {
      const { listViews } = await import("/core/registry/views.js");
      return listViews().map((v) => v.id);
    });
    expect(viewIds).toEqual(
      expect.arrayContaining(["mixer", "timeline", "plugins", "session", "console"]),
    );
  });

  test("tile-leaf body survives store churn (no element re-mount)", async ({ page }) => {
    // Regression: the tile-leaf registry refactor first used
    // `document.createElement(meta.elementTag)` in `_renderBody()`,
    // which produced a fresh DOM node on every render. Lit couldn't
    // reuse the element, so `<foyer-mixer>` (and every other view)
    // unmounted + remounted on every store "change" event — the
    // symptom was `[mixer] Listen starting with codec=opus` spam,
    // no timeline waveforms, and mid-render white flashes. The fix
    // uses static-html + unsafeStatic so the template is stable.
    await page.goto("/");
    await page.waitForFunction(() => !!customElements.get("foyer-tile-leaf"));
    const leafCount = await page.locator("foyer-tile-leaf").count();
    test.skip(leafCount === 0, "welcome screen hides tile tree in launcher mode");

    // Snapshot a body element identity, then force several store
    // changes and check the element is the same object. Lit's
    // static-html keeps one ChildPart per tag, so the node persists.
    const sameNode = await page.evaluate(async () => {
      const leaf = document.querySelector("foyer-tile-leaf");
      const bodyWrap = leaf.shadowRoot.querySelector(".body");
      const before = bodyWrap.firstElementChild;
      for (let i = 0; i < 5; i++) {
        window.__foyer.store.dispatchEvent(new CustomEvent("change"));
        await new Promise((r) => setTimeout(r, 0));
      }
      const after = bodyWrap.firstElementChild;
      return before === after;
    });
    expect(sameNode).toBe(true);
  });
});
