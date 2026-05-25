// Drives a foyer-served variant through one provisioning cycle so
// the resulting Ardour session can be zipped and shipped as a
// canonical template under `crates/foyer-cli/templates/`.
//
// Invoked by `just template-rebuild`. Inputs come in as env vars
// because the Justfile is the source of truth for the foyer-port +
// variant-url + scratch-dir resolution; this script doesn't try to
// guess.
//
// Required env:
//   PROBE_PORT       — port the foyer-cli is listening on (e.g. 3849)
//   PROBE_URL_PATH   — variant entry path (e.g. /?ui=sprunki)
//   PROBE_SCRATCH    — absolute path the variant is expected to
//                      auto-provision the session under (e.g.
//                      /workspaces/sprunki-beats-scratch). We don't
//                      consume this in JS — the Justfile zips that
//                      path after the script exits.
//
// What this script does:
//   1. Opens a fresh chromium against `http://127.0.0.1:<port><url>`.
//   2. Waits for the foyer-core WS to reach `status === "open"`.
//   3. Skips any sprunki-style asset-pack consent prompt (call into
//      the variant's own skip handler when it exposes one).
//   4. Waits for the variant to reach a "ready" state via a generic
//      probe: either the custom element exposes `_status === "ready"`,
//      or the session snapshot has > 1 track (i.e. provisioning ran).
//   5. Dispatches an explicit `session.save` so the .ardour file
//      captures everything.
//   6. Sleeps briefly so Ardour finishes the write, then exits.
//
// Stdout is purely status text; the Justfile reads exit code only.

import { chromium } from "../../tests-ui/node_modules/playwright/index.mjs";

const PORT = process.env.PROBE_PORT;
const URL_PATH = process.env.PROBE_URL_PATH || "/";
if (!PORT) {
  console.error("seed-template.js: PROBE_PORT env var required");
  process.exit(64);
}
const BASE = `http://127.0.0.1:${PORT}`;

const SAVE_SETTLE_MS = 3_000;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newContext().then((c) => c.newPage());
  page.setDefaultTimeout(180_000);
  page.on("console", (m) => {
    const text = m.text();
    const t = m.type();
    if (t === "error" || t === "warn") console.log(`[browser ${t}] ${text}`);
    else if (text.startsWith("[")) console.log(`[browser ${t}] ${text}`);
  });
  page.on("pageerror", (e) => console.log(`[browser pageerror] ${e.message}`));

  console.log(`▶ navigating to ${BASE}${URL_PATH}`);
  await page.goto(`${BASE}${URL_PATH}`);
  await page.waitForFunction(() => window.__foyer?.store?.state?.status === "open");

  // Variant-agnostic asset-prompt skip: if there's a sprunki-app
  // custom element exposing `_onAssetSkip`, hit it. Other variants
  // either don't have this concept or expose their own; future
  // variants should add a similar skip hook to this list.
  await page.evaluate(() => {
    const sprunki = document.querySelector("sprunki-app");
    if (sprunki && typeof sprunki._onAssetSkip === "function") {
      sprunki._onAssetSkip();
    }
  });

  console.log("▶ waiting for variant to finish provisioning…");
  await page.waitForFunction(
    () => {
      // Sprunki-specific fast-path.
      const sprunki = document.querySelector("sprunki-app");
      if (sprunki && sprunki._status === "ready") return true;
      // Generic fallback: provisioning is "done" once the session
      // snapshot lists more than just Master.
      const tracks = window.__foyer?.store?.state?.session?.tracks || [];
      return tracks.length > 1;
    },
    { timeout: 180_000 },
  );

  // Brief settle so any in-flight `set_sequencer_layout` debounced
  // pushes land before the save — Ardour serializes XML at save time,
  // we want the layout XML included.
  await page.waitForTimeout(1_500);

  console.log("▶ dispatching session.save…");
  await page.evaluate(() => {
    window.__foyer.ws.send({ type: "invoke_action", id: "session.save" });
  });
  await page.waitForTimeout(SAVE_SETTLE_MS);

  console.log("✓ template seeded");
  await browser.close();
})();
