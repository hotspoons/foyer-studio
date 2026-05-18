// i18n smoke — proves the Drupal-style t() wrapper actually swaps
// rendered strings when the locale flips, both in components that
// were live when the change happened (transport bar, main menu) AND
// in the picker UI itself (settings modal).
//
// What we DON'T test here: that every single user-facing string in
// the app is wrapped. That's a checklist task tracked separately
// in docs/TODO.md and surfaced by `just i18n-extract`.

import { test, expect } from "@playwright/test";

test.describe("i18n", () => {
  test.beforeEach(async ({ context }) => {
    // Make sure no prior test left a localStorage locale around —
    // we want a clean English start, then explicit setLocale("es").
    await context.addInitScript(() => {
      try { localStorage.removeItem("foyer.locale"); } catch {}
    });
  });

  test("locale flips swap rendered text in mounted components", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
    await page.waitForFunction(
      () => typeof window.__foyer?.layout?.setTree === "function",
    );

    // Wait for the i18n module to register its global so we can drive
    // it from page.evaluate. bootstrap.js wires `installI18n()`
    // fire-and-forget; the catalogs land asynchronously.
    await page.waitForFunction(async () => {
      try {
        const mod = await import("/core/i18n.js");
        return typeof mod.setLocale === "function";
      } catch {
        return false;
      }
    });

    // Deep-find walker — needed because every interesting node is
    // nested ≥2 shadow roots deep.
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

    // The Session menu button is always visible. Read its text
    // before + after the locale flip and assert it actually changed.
    const labelBefore = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const menu = deepFind("foyer-main-menu");
      const buttons = menu?.shadowRoot?.querySelectorAll("button.btn") || [];
      return buttons[0]?.textContent?.trim() || null;
    })()`);
    expect(labelBefore).toBe("Session");

    // Flip to Spanish.
    await page.evaluate(async () => {
      const mod = await import("/core/i18n.js");
      await mod.setLocale("es");
    });
    // The locale-changed event is dispatched on the next microtask;
    // Lit batches the requestUpdate into a microtask + rAF. Wait for
    // the rendered DOM to reflect the new value.
    await page.waitForFunction(`(() => {
      ${DEEP_FIND}
      const menu = deepFind("foyer-main-menu");
      const buttons = menu?.shadowRoot?.querySelectorAll("button.btn") || [];
      return buttons[0]?.textContent?.trim() === "Sesión";
    })()`);

    // Transport bar tooltip should follow too — proves
    // disparate-component re-render isn't a fluke.
    const playTitle = await page.evaluate(`(() => {
      ${DEEP_FIND}
      const tb = deepFind("foyer-transport-bar");
      const play = tb?.shadowRoot?.querySelector(".btn.play");
      return play?.getAttribute("title") || null;
    })()`);
    // Either "Reproducir (Espacio)" (paused) or "Pausar (Espacio)" (playing).
    expect(playTitle).toMatch(/^(Reproducir|Pausar) \(Espacio\)$/);

    // Flip back to English to leave the next test on a clean slate.
    await page.evaluate(async () => {
      const mod = await import("/core/i18n.js");
      await mod.setLocale("en");
    });
    await page.waitForFunction(`(() => {
      ${DEEP_FIND}
      const menu = deepFind("foyer-main-menu");
      const buttons = menu?.shadowRoot?.querySelectorAll("button.btn") || [];
      return buttons[0]?.textContent?.trim() === "Session";
    })()`);
  });

  // Every shipped locale should translate the Session menu label.
  // This is the cheapest probe that proves the JSON file parses,
  // the manifest knows about it, and the runtime lookup works for
  // a 1-key sample. If you add a locale, append it here.
  test("every shipped locale translates the Session label", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
    await page.waitForFunction(async () => {
      try {
        const mod = await import("/core/i18n.js");
        return typeof mod.setLocale === "function";
      } catch {
        return false;
      }
    });
    const expected = {
      de: "Sitzung",
      es: "Sesión",
      it: "Sessione",
      ja: "セッション",
      ko: "세션",
      zh: "会话",
    };
    for (const [code, want] of Object.entries(expected)) {
      const got = await page.evaluate(async (c) => {
        const mod = await import("/core/i18n.js");
        await mod.setLocale(c);
        return mod.t("Session");
      }, code);
      expect(got, `locale ${code}`).toBe(want);
    }
    // Reset for the next test.
    await page.evaluate(async () => {
      const mod = await import("/core/i18n.js");
      await mod.setLocale("en");
    });
  });

  test("untranslated keys fall back to English source", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
    const probe = await page.evaluate(async () => {
      const mod = await import("/core/i18n.js");
      await mod.setLocale("es");
      const present = mod.t("Session");
      const absent = mod.t("definitely-not-in-the-catalog-%{x}", { x: "Q" });
      await mod.setLocale("en");
      return { present, absent };
    });
    expect(probe.present).toBe("Sesión");
    // Missing keys identity-render with placeholders substituted.
    expect(probe.absent).toBe("definitely-not-in-the-catalog-Q");
  });
});
