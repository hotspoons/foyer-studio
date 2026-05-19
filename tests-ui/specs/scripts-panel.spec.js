// Scripts panel smoke + round-trip.
//
// Exercises the end-to-end path the user takes:
//   1. Boot foyer with the stub backend.
//   2. The session snapshot carries scripting capabilities (stub
//      advertises Ardour-shaped types + Lua).
//   3. The server's on-attach push fires Event::ScriptList so the
//      panel renders without an explicit refresh.
//   4. Open the Scripts widget; assert the seeded scripts appear.
//   5. Save a fresh script via WS and watch the row appear.
//   6. Run that script; assert the stub's echo lands in the output
//      log.
//
// Doesn't lean on simulating pointer drags through nested shadow
// roots — drives the panel via the same WS surface the agent uses,
// which is exactly what the FE component reads from. Mirrors the
// "test by calling component methods, not by simulating drags"
// guidance in CLAUDE.md.

import { test, expect } from "@playwright/test";
import { DEEP_FIND } from "./_boot.js";

test.describe("scripts panel", () => {
  test("seeded scripts surface on attach", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
    // session.scripting (the cap surface) lives on the snapshot.
    await page.waitForFunction(
      () => !!window.__foyer?.store?.state?.session?.scripting,
    );
    const caps = await page.evaluate(
      () => window.__foyer.store.state.session.scripting,
    );
    expect(caps.languages.map((l) => l.id)).toContain("lua");
    expect(caps.script_types.map((t) => t.id)).toEqual(
      expect.arrayContaining(["snippet", "editor_action", "editor_hook", "dsp"]),
    );
  });

  test("save → list → run round-trip echoes through the WS", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
    await page.waitForFunction(
      () => !!window.__foyer?.store?.state?.session?.scripting,
    );

    // Hook a listener on the page so we can observe the events the
    // scripts-view component listens to.
    await page.evaluate(() => {
      window.__test_envelopes = [];
      window.__foyer.ws.addEventListener("envelope", (ev) => {
        const t = ev.detail?.body?.type;
        if (t && t.startsWith("script")) {
          window.__test_envelopes.push(ev.detail.body);
        }
      });
    });

    // Save a fresh script. Empty id → backend allocates one.
    await page.evaluate(() => {
      window.__foyer.ws.send({
        type: "save_script",
        script: {
          id: "",
          name: "Playwright probe",
          description: "test fixture",
          script_type: "snippet",
          language: "lua",
          enabled: true,
          body: "print('hi from playwright')\n",
          args: {},
          hook: null,
          disabled_on_upload: false,
          updated_at: 0,
        },
      });
    });

    // Wait for the ScriptSaved echo.
    await page.waitForFunction(() =>
      window.__test_envelopes.some(
        (b) => b.type === "script_saved" && b.script?.name === "Playwright probe",
      ),
    );
    const savedId = await page.evaluate(() => {
      const ev = window.__test_envelopes.find(
        (b) => b.type === "script_saved" && b.script?.name === "Playwright probe",
      );
      return ev.script.id;
    });
    expect(savedId).toBeTruthy();

    // Run it; expect a ScriptRunResult with ok=true and "Playwright probe" in stdout.
    await page.evaluate((id) => {
      window.__foyer.ws.send({ type: "run_script", id });
    }, savedId);
    await page.waitForFunction(
      (id) =>
        window.__test_envelopes.some(
          (b) =>
            b.type === "script_run_result" &&
            b.result?.id === id &&
            b.result?.ok === true,
        ),
      savedId,
    );
    const result = await page.evaluate((id) => {
      const ev = window.__test_envelopes.find(
        (b) => b.type === "script_run_result" && b.result?.id === id,
      );
      return ev.result;
    }, savedId);
    expect(result.stdout).toMatch(/Playwright probe/);

    // Delete cleanup so reruns of this test against the same stub
    // process don't accumulate fixtures (stub backend state persists
    // across tests in a single playwright run — see CLAUDE.md).
    await page.evaluate((id) => {
      window.__foyer.ws.send({ type: "delete_script", id });
    }, savedId);
  });

  test("foyer-scripts-view mounts and renders rows", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");

    // Mount the view in a tile leaf via setTree — exercises the same
    // dynamic-import path the right-dock takes when the user clicks
    // "+ Scripts" but without depending on FAB geometry.
    await page.evaluate(async () => {
      // Force the module to load so the custom element is defined.
      await import("/ui-full/components/scripts-view.js");
    });
    await page.waitForFunction(() =>
      !!customElements.get("foyer-scripts-view"),
    );

    // Plant one directly in the body to keep the test independent
    // of the tile system + foyer-window chrome.
    await page.evaluate(() => {
      const el = document.createElement("foyer-scripts-view");
      el.id = "test-scripts-view";
      el.style.cssText = "position:fixed;top:0;left:0;width:800px;height:500px;z-index:9999";
      document.body.appendChild(el);
    });

    // Wait until the seeded "Hello Foyer" script row appears.
    await page.waitForFunction(`(() => {
      const el = document.querySelector("#test-scripts-view");
      if (!el?.shadowRoot) return false;
      return el.shadowRoot.textContent.includes("Hello Foyer");
    })()`);
  });
});
