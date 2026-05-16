// Keymap profile smoke.
//
// 1. Default profile is "foyer"; plain wheel on the timeline body resolves
//    to "hzoom".
// 2. Switching to "cubase" makes plain wheel resolve to "vscroll" (Cubase
//    convention) and Ctrl-wheel resolve to "hzoom".
// 3. `matchKey` agrees with the profile picks: "g" fires editor.zoom_out
//    under Cubase but not under Foyer.
//
// Lives outside any DAW round-trip — keymap is a pure client-side module,
// so we just import it through the running page's module graph.

import { test, expect } from "@playwright/test";

test.describe("keymap profile", () => {
  test("profile resolves wheel + key correctly", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");

    const result = await page.evaluate(async () => {
      const km = await import("/core/keymap/index.js");
      const plainEv = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
      const ctrlEv = { altKey: false, ctrlKey: true,  metaKey: false, shiftKey: false };
      const out = {};

      km.setActiveProfile("foyer");
      out.foyer_main_plain   = km.resolveWheel("timeline_main", plainEv);
      out.foyer_main_ctrl    = km.resolveWheel("timeline_main", ctrlEv);
      // = is editor.zoom_in under foyer
      out.foyer_eq_zooms_in  = km.matchKey("editor.zoom_in", { key: "=", ...plainEv });
      // g is NOT bound to zoom under foyer
      out.foyer_g_zooms_out  = km.matchKey("editor.zoom_out", { key: "g", ...plainEv });

      km.setActiveProfile("cubase");
      out.cubase_main_plain  = km.resolveWheel("timeline_main", plainEv);
      out.cubase_main_ctrl   = km.resolveWheel("timeline_main", ctrlEv);
      // g IS bound to zoom_out under cubase, and h is zoom_in
      out.cubase_g_zooms_out = km.matchKey("editor.zoom_out", { key: "g", ...plainEv });
      out.cubase_h_zooms_in  = km.matchKey("editor.zoom_in",  { key: "h", ...plainEv });

      km.setActiveProfile("reaper");
      out.reaper_main_plain  = km.resolveWheel("timeline_main", plainEv);
      out.reaper_main_ctrl   = km.resolveWheel("timeline_main", ctrlEv);

      // Restore default so we don't bleed state into other specs.
      km.setActiveProfile("foyer");
      return out;
    });

    expect(result.foyer_main_plain).toBe("hzoom");
    expect(result.foyer_main_ctrl).toBe("hscroll");
    expect(result.foyer_eq_zooms_in).toBe(true);
    expect(result.foyer_g_zooms_out).toBe(false);

    expect(result.cubase_main_plain).toBe("vscroll");
    expect(result.cubase_main_ctrl).toBe("hzoom");
    expect(result.cubase_g_zooms_out).toBe(true);
    expect(result.cubase_h_zooms_in).toBe(true);

    expect(result.reaper_main_plain).toBe("hscroll");
    expect(result.reaper_main_ctrl).toBe("hzoom");
  });

  test("preferences picker updates the active profile", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");

    const before = await page.evaluate(async () => {
      const km = await import("/core/keymap/index.js");
      km.setActiveProfile("foyer");
      return km.getActiveProfileId();
    });
    expect(before).toBe("foyer");

    // Open Preferences modal via the chat panel's `/settings` shortcut is
    // overkill — we drive setActiveProfile directly the way the modal
    // does. That keeps the spec resilient to selector churn in the modal.
    const after = await page.evaluate(async () => {
      const km = await import("/core/keymap/index.js");
      km.setActiveProfile("protools");
      const id = km.getActiveProfileId();
      km.setActiveProfile("foyer");  // restore
      return id;
    });
    expect(after).toBe("protools");
  });
});
