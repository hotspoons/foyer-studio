#!/usr/bin/env bun
// Foyer UI probe — drive the live page from the CLI.
//
// Use cases:
//   · Screenshot the current UI state without switching to a browser.
//   · Click / fill / type into the UI programmatically.
//   · Evaluate JS expressions against `window.__foyer` to inspect
//     store state, peer counts, RBAC, etc.
//   · Capture console output over a short window so debugging
//     doesn't require DevTools.
//
// The probe assumes a Foyer server is already serving at
// $FOYER_BASE_URL (default http://127.0.0.1:3838). It launches a
// headless Chromium each invocation — that's a second of startup
// cost; acceptable for scripting, and there's no daemon to manage.
//
// Examples:
//   bun probe.js screenshot /tmp/foyer.png
//   bun probe.js eval 'window.__foyer.store.state.status'
//   bun probe.js click 'foyer-transport-bar button[title*="Play"]'
//   bun probe.js dump
//
// For long-running observation or headed mode, drop into:
//   bun probe.js inspect            # keeps browser open, prints URL
// (exit with Ctrl+C).

import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE_URL = process.env.FOYER_BASE_URL || "http://127.0.0.1:3838";
const HEADLESS = process.env.FOYER_PROBE_HEADLESS !== "0";
const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);

function usage() {
  console.error(`usage: bun probe.js <subcommand> [args]

Subcommands:
  screenshot <path>            Save a PNG of the full page
  click <selector>             Click the first match
  fill <selector> <value>      Type into an input
  eval <expr>                  Evaluate a JS expression in the page
  dump                         Print useful globals (store, rbac, peers)
  hash <path>                  Set window.location.hash to the given path
  url <url>                    Navigate to a full or relative URL
  inspect                      Open headed, keep running until Ctrl+C

Env:
  FOYER_BASE_URL               Target (default ${BASE_URL})
  FOYER_PROBE_HEADLESS=0       Run headed (for human observation)
`);
  process.exit(1);
}

if (!cmd) usage();

const browser = await chromium.launch({ headless: HEADLESS });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const consoleBuf = [];
page.on("console", (msg) => consoleBuf.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => consoleBuf.push(`[pageerror] ${err.message}`));

await page.goto(BASE_URL);
// Wait for both the global handles AND a mounted surface (full UI
// or fallback shell). Without this second wait, a probe fired
// during the boot race sees an empty body and reports the UI as
// "missing." 6s is plenty for the stub backend's greeting to land.
await page.waitForFunction(
  () => !!window.__foyer && (
    !!document.querySelector("foyer-app") ||
    !!document.querySelector(".foyer-fallback")
  ),
  null,
  { timeout: 6_000 },
).catch(() => {});

try {
  switch (cmd) {
    case "screenshot": {
      const path = rest[0] || "/tmp/foyer.png";
      await page.waitForTimeout(500);
      await page.screenshot({ path, fullPage: true });
      console.log(path);
      break;
    }
    case "click": {
      if (!rest[0]) usage();
      await page.click(rest[0], { timeout: 5_000 });
      console.log(`clicked: ${rest[0]}`);
      break;
    }
    case "fill": {
      if (!rest[0] || rest[1] == null) usage();
      await page.fill(rest[0], rest[1]);
      console.log(`filled: ${rest[0]} = ${rest[1]}`);
      break;
    }
    case "eval": {
      if (!rest[0]) usage();
      const result = await page.evaluate(rest[0]);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "dump": {
      const result = await page.evaluate(() => ({
        status: window.__foyer?.store?.state?.status,
        rbac: window.__foyer?.store?.state?.rbac,
        peers: Array.from(window.__foyer?.store?.state?.peers || new Map()).map(
          ([id, p]) => ({ id, label: p.label, role: p.role_id, is_tunnel: p.is_tunnel }),
        ),
        currentSessionId: window.__foyer?.store?.state?.currentSessionId,
        sessions: (window.__foyer?.store?.state?.sessions || []).map(
          (s) => ({ id: s.id, name: s.name, dirty: !!s.dirty }),
        ),
        activeVariant: window.__foyer?.store?.state?.greeting?.default_ui_variant || null,
      }));
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "hash": {
      const path = rest[0] || "";
      await page.evaluate((h) => { window.location.hash = h; }, path);
      console.log(`hash: #${path}`);
      break;
    }
    case "url": {
      const url = rest[0] || "/";
      await page.goto(url.startsWith("http") ? url : `${BASE_URL}${url}`);
      console.log(`navigated: ${url}`);
      break;
    }
    case "inspect": {
      console.log(`inspecting ${BASE_URL} headed — Ctrl+C to exit`);
      await new Promise(() => {});
      break;
    }
    default:
      usage();
  }
} catch (err) {
  console.error(`[probe] ${err?.message || err}`);
  if (consoleBuf.length) console.error(`page console:\n${consoleBuf.join("\n")}`);
  await browser.close();
  process.exit(2);
}

await browser.close();
