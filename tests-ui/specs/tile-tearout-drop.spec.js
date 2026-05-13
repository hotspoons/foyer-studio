// Tear-out drop onto a slot landing zone should re-enter the tile
// tree at the chosen position rather than producing a free-floating
// overlay. Rich's 2026-05-13 report: he tore Track Editor out of a
// 3x1 row and dropped on the bottom-right quadrant, expecting Timeline
// to shrink and accommodate it. Instead it floated.

import { test, expect } from "@playwright/test";

async function bootApp(page) {
  await page.goto("/");
  await page.waitForFunction(
    () => typeof window.__foyer?.layout?.setTree === "function",
    null,
    { timeout: 10_000 },
  );
}

test("insertIntoTreeAtSlot bottom-right wraps the rightmost leaf with a column split", async ({ page }) => {
  await bootApp(page);
  // Set a known 3-column tree.
  await page.evaluate(() => {
    const Tree = window.__foyer.layout;
    Tree.setTree({
      kind: "split",
      id: "root",
      direction: "row",
      ratios: [1/3, 1/3, 1/3],
      children: [
        { kind: "leaf", id: "L", view: "mixer", props: {} },
        { kind: "leaf", id: "M", view: "timeline", props: {} },
        { kind: "leaf", id: "R", view: "timeline", props: {} },
      ],
    });
  });

  // Insert into bottom-right; verify the tree changes shape:
  // the rightmost leaf gets column-split, with the new leaf in the
  // bottom half. Drives the helper directly so the test doesn't
  // depend on the tear-out gesture (a separate pointer choreography
  // test owns that path).
  await page.evaluate(async () => {
    const Tree = await import("/ui-core/layout/tile-tree.js");
    const newLeaf = Tree.leaf("console", {});
    const next = Tree.insertIntoTreeAtSlot(
      window.__foyer.layout.tree,
      newLeaf,
      "br",
      "M",
    );
    window.__foyer.layout.setTree(next);
  });

  const shape = await page.evaluate(() => {
    function describe(n) {
      if (!n) return null;
      if (n.kind === "leaf") return { kind: "leaf", view: n.view };
      return {
        kind: "split",
        direction: n.direction,
        children: (n.children || []).map(describe),
      };
    }
    return describe(window.__foyer.layout.tree);
  });

  // Expected: row(mixer, timeline, column(timeline, console))
  expect(shape).toEqual({
    kind: "split",
    direction: "row",
    children: [
      { kind: "leaf", view: "mixer" },
      { kind: "leaf", view: "timeline" },
      {
        kind: "split",
        direction: "column",
        children: [
          { kind: "leaf", view: "timeline" },
          { kind: "leaf", view: "console" },
        ],
      },
    ],
  });
});

test("insertIntoTreeAtSlot left-half wraps the existing tree as the right side", async ({ page }) => {
  await bootApp(page);
  await page.evaluate(() => {
    window.__foyer.layout.setTree({
      kind: "leaf", id: "only", view: "mixer", props: {},
    });
  });
  await page.evaluate(async () => {
    const Tree = await import("/ui-core/layout/tile-tree.js");
    const next = Tree.insertIntoTreeAtSlot(
      window.__foyer.layout.tree,
      Tree.leaf("timeline", {}),
      "left-half",
    );
    window.__foyer.layout.setTree(next);
  });
  const shape = await page.evaluate(() => {
    const t = window.__foyer.layout.tree;
    return {
      direction: t.direction,
      left: t.children[0].view,
      right: t.children[1].view,
    };
  });
  expect(shape).toEqual({
    direction: "row",
    left: "timeline",
    right: "mixer",
  });
});

test("insertIntoTreeAtSlot center replaces the focused leaf", async ({ page }) => {
  await bootApp(page);
  await page.evaluate(() => {
    window.__foyer.layout.setTree({
      kind: "split",
      id: "root",
      direction: "row",
      ratios: [0.5, 0.5],
      children: [
        { kind: "leaf", id: "L", view: "mixer", props: {} },
        { kind: "leaf", id: "R", view: "timeline", props: {} },
      ],
    });
  });
  await page.evaluate(async () => {
    const Tree = await import("/ui-core/layout/tile-tree.js");
    const next = Tree.insertIntoTreeAtSlot(
      window.__foyer.layout.tree,
      Tree.leaf("console", {}),
      "center",
      "R",
    );
    window.__foyer.layout.setTree(next);
  });
  const views = await page.evaluate(() => {
    return window.__foyer.layout.tree.children.map((c) => c.view);
  });
  expect(views).toEqual(["mixer", "console"]);
});
