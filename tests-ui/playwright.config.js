// Playwright config for Foyer's UI smoke tests.
//
// Assumptions:
//   - `just run` (or `cargo run --bin foyer -- serve`) is already
//     running on `http://127.0.0.1:3838` when tests fire. We do NOT
//     start the server from here because the sidecar's full boot
//     depends on a shim + JACK and isn't a single-process thing.
//     If you want an auto-started stub backend for pure UI tests,
//     set `FOYER_AUTO_SERVE=1` and we'll spin one up.

import { defineConfig, devices } from "@playwright/test";

const autoServe = process.env.FOYER_AUTO_SERVE === "1";

export default defineConfig({
  testDir: "./specs",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "report", open: "never" }],
  ],
  use: {
    baseURL: process.env.FOYER_BASE_URL || "http://127.0.0.1:3838",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 7_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: autoServe
    ? {
        // Stub backend, no project path — fastest boot for UI tests.
        command: "cargo run --bin foyer -- serve --listen 127.0.0.1:3838 --backend stub",
        url: "http://127.0.0.1:3838",
        timeout: 60_000,
        reuseExistingServer: true,
        cwd: "..",
      }
    : undefined,
});
