// Phone variant — boot, welcome, active session, wire-roundtrip,
// session sheet, viewport-driven auto-routing.
//
// The probe-by-hand flow that built this UI is below in spec form
// so a refactor at any seam (variant registry, store reducer, RBAC,
// recents, controlSet) trips one of these instead of silently
// breaking the phone surface.
//
// Phone-shadow walk pattern: the app is `<foyer-phone-app>`, NOT
// `<foyer-app>`. Use `deepFindPhone()` rather than the helper in
// _boot.js (which is rooted on `<foyer-app>`).

import { test, expect } from "@playwright/test";

// Phone-rooted shadow walker — drops into a page.evaluate string so
// the function definition travels with each call.
const DEEP_FIND_PHONE = `
  function deepFindPhone(tag) {
    const root = document.querySelector("foyer-phone-app");
    if (!root) return null;
    const stack = [root.shadowRoot];
    while (stack.length) {
      const r = stack.pop();
      const hit = r.querySelector(tag);
      if (hit) return hit;
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) stack.push(el.shadowRoot);
    }
    return null;
  }
`;

async function gotoPhone(page) {
  page.setDefaultTimeout(20_000);
  await page.goto("/?ui=phone");
  // Variant boot is async (dynamic-imports its package, then app.js).
  // Wait for the custom element to upgrade before any further work.
  await page.waitForFunction(
    () => !!document.querySelector("foyer-phone-app"),
  );
  await page.waitForFunction(
    () => window.__foyer?.store?.state?.status === "open",
  );
}

test.describe("phone variant boot", () => {
  test("?ui=phone routes to foyer-phone-app, NOT foyer-app", async ({ page }) => {
    await gotoPhone(page);
    await expect(page.locator("foyer-phone-app")).toBeVisible();
    await expect(page.locator("foyer-app")).toHaveCount(0);
  });

  test("welcome state renders when no session is open", async ({ page }) => {
    await gotoPhone(page);
    // The probe earlier confirmed the stub doesn't auto-open a
    // session, so the phone shell stays in welcome until we launch.
    const has = await page.evaluate(`(() => {
      ${DEEP_FIND_PHONE}
      return {
        welcome: !!deepFindPhone(".welcome"),
        cta: deepFindPhone(".welcome .cta")?.textContent?.trim() ?? null,
        topBar: !!deepFindPhone("foyer-phone-top-bar"),
      };
    })()`);
    expect(has.topBar).toBe(true);
    expect(has.welcome).toBe(true);
    expect(has.cta).toBe("Pick a session");
  });

});

// The match-predicate score numbers are an implementation detail; the
// "phone-auto-routing" describe below verifies the only thing that
// matters: a small touch viewport actually mounts the phone variant.

test.describe("phone with an open session", () => {
  test("launching a stub project paints transport + tracks", async ({ page }) => {
    await gotoPhone(page);
    await page.evaluate(() => {
      window.__foyer.ws.send({
        type: "launch_project", backend_id: "stub", project_path: "",
      });
    });
    // Wait for the store to register the session AND the snapshot
    // to land — render gates on `currentSession()`, which in turn
    // depends on `currentSessionId` being non-null.
    await page.waitForFunction(
      () => !!window.__foyer.store.currentSession(),
    );
    const has = await page.evaluate(`(() => {
      ${DEEP_FIND_PHONE}
      const rows = document.querySelector("foyer-phone-app")
        .shadowRoot.querySelectorAll("foyer-phone-track-row");
      return {
        transport: !!deepFindPhone("foyer-phone-transport"),
        rowCount: rows.length,
        firstName: rows[0]?.track?.name ?? null,
      };
    })()`);
    expect(has.transport).toBe(true);
    expect(has.rowCount).toBeGreaterThan(0);
    expect(has.firstName).toBeTruthy();
  });

  test("R chip on a track round-trips through controlSet", async ({ page }) => {
    await gotoPhone(page);
    await page.evaluate(() => {
      window.__foyer.ws.send({
        type: "launch_project", backend_id: "stub", project_path: "",
      });
    });
    await page.waitForFunction(
      () => !!window.__foyer.store.currentSession(),
    );
    // Wait for at least one row to render.
    await page.waitForFunction(() =>
      document.querySelector("foyer-phone-app")
        .shadowRoot.querySelectorAll("foyer-phone-track-row").length > 0,
    );

    // Capture before, click R, capture after. The stub backend echoes
    // the controlSet back as a control_update so the store flips.
    const result = await page.evaluate(async () => {
      const app = document.querySelector("foyer-phone-app");
      const row = app.shadowRoot.querySelector("foyer-phone-track-row");
      const armId = row.track.record_arm.id;
      const before = !!Number(window.__foyer.store.get(armId));
      row.shadowRoot.querySelector(".chip.rec").click();
      // Round-trip is fast on the stub but not zero — give it a beat.
      await new Promise((r) => setTimeout(r, 250));
      const after = !!Number(window.__foyer.store.get(armId));
      return { before, after, name: row.track.name };
    });
    expect(result.before).toBe(false);
    expect(result.after).toBe(true);
  });

  test("tapping the top-bar session opens the sheet", async ({ page }) => {
    await gotoPhone(page);
    await page.evaluate(() => {
      window.__foyer.ws.send({
        type: "launch_project", backend_id: "stub", project_path: "",
      });
    });
    await page.waitForFunction(
      () => !!window.__foyer.store.currentSession(),
    );

    // Click the session button; the click bubbles `open-sheet` up to
    // the app, which flips `_sheetOpen`. Lit re-renders on the next
    // microtask — wait for the sheet host to reflect open=true.
    const opened = await page.evaluate(async () => {
      const app = document.querySelector("foyer-phone-app");
      const tb  = app.shadowRoot.querySelector("foyer-phone-top-bar");
      tb.shadowRoot.querySelector(".session").click();
      await app.updateComplete;
      const sheet = app.shadowRoot.querySelector("foyer-phone-session-sheet");
      await sheet.updateComplete;
      return {
        open: sheet.open,
        rowCount: sheet.shadowRoot.querySelectorAll(".row").length,
      };
    });
    expect(opened.open).toBe(true);
    // At least the open "stub" session shows up as a row.
    expect(opened.rowCount).toBeGreaterThanOrEqual(1);
  });
});

test.describe("phone auto-routing", () => {
  // The default Playwright viewport is 1280x720 (desktop), so without
  // overriding, ui-full wins. Override per-test so this exercises the
  // real phone-detection path — not just the URL override.
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

  test("small-touch viewport boots the phone variant on its own", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");                  // no ?ui= override
    await page.waitForFunction(
      () => !!document.querySelector("foyer-phone-app")
         || !!document.querySelector("foyer-app"),
    );
    await expect(page.locator("foyer-phone-app")).toBeVisible();
    await expect(page.locator("foyer-app")).toHaveCount(0);
  });
});
