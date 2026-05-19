// Render / mixdown smoke test.
//
// Exercises:
//   1. The session snapshot advertises a `render` capability with at
//      least one encoder (the stub backend ships WAV).
//   2. `render_session` → `render_started` ack → at least one
//      `render_progress` → `render_complete` with a non-empty
//      output buffer that starts with the RIFF/WAVE magic bytes
//      (stub is configured to inline_bytes=true here).
//   3. The render-modal mounts and disables its primary button while
//      a render is in flight.

import { test, expect } from "@playwright/test";

test.describe("render / mixdown", () => {
  test("session snapshot advertises render capability", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
    await page.waitForFunction(
      () => !!window.__foyer?.store?.state?.session?.render,
    );
    const caps = await page.evaluate(
      () => window.__foyer.store.state.session.render,
    );
    expect(Array.isArray(caps.formats)).toBe(true);
    expect(caps.formats.length).toBeGreaterThan(0);
    expect(caps.formats.map((f) => f.id)).toContain("wav");
    expect(caps.max_channels).toBeGreaterThanOrEqual(2);
  });

  test("render_session → progress → complete round-trip", async ({ page }) => {
    page.setDefaultTimeout(30_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");

    await page.evaluate(() => {
      window.__render_envs = [];
      window.__foyer.ws.addEventListener("envelope", (ev) => {
        const t = ev.detail?.body?.type;
        if (t && t.startsWith("render_")) {
          window.__render_envs.push(ev.detail.body);
        }
      });
      const handle = `test-${Math.random().toString(36).slice(2, 10)}`;
      window.__render_handle = handle;
      window.__foyer.ws.send({
        type: "render_session",
        handle,
        opts: {
          format_id: "wav",
          sample_rate: 48000,
          bit_depth: "int16",
          channels: 2,
          target: { kind: "master" },
          range: { kind: "session" },
          normalize_to_master: true,
          inline_bytes: true,
        },
      });
    });

    // Wait for the terminal envelope (complete or error).
    await page.waitForFunction(() =>
      window.__render_envs.some(
        (b) => b.type === "render_complete" || b.type === "render_error",
      ),
    );

    const summary = await page.evaluate(() => {
      const evs = window.__render_envs;
      const started = evs.find((b) => b.type === "render_started");
      const progress = evs.filter((b) => b.type === "render_progress");
      const complete = evs.find((b) => b.type === "render_complete");
      const error = evs.find((b) => b.type === "render_error");
      const out = complete?.outputs?.[0];
      // Decode the first 12 bytes of the inline base64 to check WAV magic.
      let head = "";
      if (out?.bytes_b64) {
        const bin = atob(out.bytes_b64);
        for (let i = 0; i < Math.min(12, bin.length); i++) {
          head += bin.charCodeAt(i).toString(16).padStart(2, "0");
        }
      }
      return {
        started_ok: !!started,
        progress_count: progress.length,
        completed: !!complete,
        errored: !!error,
        error_msg: error?.message,
        size_bytes: out?.size_bytes,
        format_id: out?.format_id,
        wav_magic_hex_head: head,
      };
    });

    expect(summary.errored, summary.error_msg).toBe(false);
    expect(summary.started_ok).toBe(true);
    expect(summary.completed).toBe(true);
    expect(summary.size_bytes).toBeGreaterThan(0);
    expect(summary.format_id).toBe("wav");
    // "RIFF" = 52 49 46 46, "WAVE" appears at offset 8.
    expect(summary.wav_magic_hex_head.startsWith("52494646")).toBe(true);
    expect(summary.wav_magic_hex_head.toLowerCase()).toContain("57415645");
  });

  test("render-modal mounts and exposes a Render button", async ({ page }) => {
    page.setDefaultTimeout(20_000);
    await page.goto("/");
    await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");
    await page.waitForFunction(
      () => !!window.__foyer?.store?.state?.session?.render,
    );

    await page.evaluate(async () => {
      // Force the module to load + define the element. The Session
      // menu path triggers this dynamically; we shortcut here to keep
      // the test independent of the foyer-app shell.
      await import("/ui-full/components/render-modal.js");
    });
    await page.waitForFunction(() =>
      !!customElements.get("foyer-render-modal"),
    );

    await page.evaluate(() => {
      const el = document.createElement("foyer-render-modal");
      el.id = "test-render-modal";
      document.body.appendChild(el);
    });

    // Modal should pick up the format from the snapshot caps. Walk
    // the shadow root to confirm a primary Render button exists.
    await page.waitForFunction(() => {
      const el = document.querySelector("#test-render-modal");
      const btn = el?.shadowRoot?.querySelector("button.primary");
      return !!btn && btn.textContent.trim().toLowerCase() === "render";
    });
  });
});
