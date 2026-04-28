// Smoke tests — prove the three-tier split actually loads + the
// bootstrap picks a UI variant + the shipping UI paints its chrome.
//
// These tests DON'T assert feature behaviour — they only guarantee
// that core boots, ui-core's fallback doesn't show (because a real
// variant wins), and ui's top-level shell mounts. When any of these
// break, the refactor is wrong at the seams and deeper tests aren't
// worth running.

import { test, expect } from "@playwright/test";

test.describe("foyer boot", () => {
  test("loads index and mounts foyer-app (full UI variant wins)", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`console: ${msg.text()}`);
    });

    await page.goto("/");

    // Wait until either the full UI paints, or the fallback does.
    const app = page.locator("foyer-app");
    const fallback = page.locator(".foyer-fallback");
    await expect(app.or(fallback)).toBeVisible({ timeout: 10_000 });

    // On a desktop viewport the full UI variant's `match` score wins,
    // so we expect foyer-app and NOT the fallback.
    await expect(app).toBeVisible();
    await expect(fallback).toHaveCount(0);

    // __foyer globals set up by core bootstrap + extended by ui/app.js.
    const globals = await page.evaluate(() => ({
      hasStore: !!window.__foyer?.store,
      hasWs: !!window.__foyer?.ws,
      hasLayout: !!window.__foyer?.layout,
      hasMount: typeof window.__foyer?.mountVariant === "function",
    }));
    expect(globals.hasStore).toBe(true);
    expect(globals.hasWs).toBe(true);
    expect(globals.hasLayout).toBe(true);
    expect(globals.hasMount).toBe(true);

    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  test("fallback shell appears when ?ui= is bogus and no variant matches", async ({ page }) => {
    await page.goto("/?ui=__definitely_not_a_variant__");
    // The bogus id doesn't resolve; pickUiVariant falls through to
    // highest-score. Desktop viewport → foyer-ui still wins.
    // This test just confirms bogus ids don't crash.
    const app = page.locator("foyer-app");
    const fallback = page.locator(".foyer-fallback");
    await expect(app.or(fallback)).toBeVisible({ timeout: 10_000 });
  });

  test("core is reachable without a UI", async ({ page }) => {
    // Tests that the registries export what we expect at their public
    // contract — alternate-UI authors will do this same probe.
    await page.goto("/");
    const shape = await page.evaluate(async () => {
      const core = await import("/core/index.js");
      return {
        exports: Object.keys(core).sort(),
        listViews: typeof core.listUiVariants,
        sniffEnv: typeof core.sniffEnv,
      };
    });
    expect(shape.listViews).toBe("function");
    expect(shape.sniffEnv).toBe("function");
    expect(shape.exports).toEqual(
      expect.arrayContaining([
        "MANIFEST",
        "bootFoyerCore",
        "FoyerWs",
        "Store",
        "registerUiVariant",
        "pickUiVariant",
        "setFeatures",
        "registerWidget",
        "isAllowed",
      ]),
    );
  });
});

test.describe("connection status", () => {
  test("ws reaches open within a few seconds", async ({ page }) => {
    await page.goto("/");
    const status = await page.waitForFunction(
      () => window.__foyer?.store?.state?.status,
      null,
      { timeout: 8_000 },
    );
    const val = await status.jsonValue();
    expect(["open", "idle"]).toContain(val);
  });
});
