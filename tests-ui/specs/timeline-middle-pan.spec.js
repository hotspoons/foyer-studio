// Middle-click + drag pans the timeline in both axes — clientX
// delta drives `scrollLeft` (time), clientY delta drives `scrollTop`
// (track list). The handler lives on the `.scroll` div in
// `<foyer-timeline-view>`.
//
// Synthetic pointerdown/pointermove/pointerup with `button === 1`
// is what we need to dispatch — Playwright's `page.mouse.down`
// doesn't expose the middle button, so we dispatch native events
// directly inside `evaluate`.

import { test, expect } from "@playwright/test";
import { DEEP_FIND, bootTimeline } from "./_boot.js";

test("middle-click drag scrolls the timeline horizontally and vertically", async ({ page }) => {
  await bootTimeline(page);

  const result = await page.evaluate(`(() => {
    ${DEEP_FIND}
    const view = deepFind("foyer-timeline-view");
    if (!view) return { error: "no timeline view" };
    const scroll = view.renderRoot.querySelector(".scroll");
    if (!scroll) return { error: "no scroll div" };
    // Force overflow content so scroll deltas are observable; without
    // a long timeline + tall track list, scrollLeft/Top stay clamped
    // to 0 and the test would pass even if the handler did nothing.
    const grid = scroll.querySelector(".grid");
    if (grid) grid.style.minWidth = (scroll.clientWidth + 800) + "px";
    if (grid) grid.style.minHeight = (scroll.clientHeight + 600) + "px";
    // Initial state.
    scroll.scrollLeft = 0;
    scroll.scrollTop  = 0;

    const rect = scroll.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top  + rect.height / 2;
    // Middle-button pointerdown.
    scroll.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true,
      button: 1, buttons: 4,
      clientX: startX, clientY: startY,
      pointerId: 99, pointerType: "mouse",
    }));
    // Drag — the move listener was attached to window in
    // _onScrollPointerDown, so dispatching against window.
    window.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true,
      button: 1, buttons: 4,
      clientX: startX - 120, clientY: startY - 80,
      pointerId: 99, pointerType: "mouse",
    }));
    const after = { scrollLeft: scroll.scrollLeft, scrollTop: scroll.scrollTop };
    // Release.
    window.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true,
      button: 1, buttons: 0,
      clientX: startX - 120, clientY: startY - 80,
      pointerId: 99, pointerType: "mouse",
    }));
    return { after };
  })()`);

  expect(result.error).toBeUndefined();
  // Scroll positions should reflect the negative pointer delta:
  // dragging left moves content left → scrollLeft increases.
  expect(result.after.scrollLeft).toBeGreaterThanOrEqual(100);
  expect(result.after.scrollTop).toBeGreaterThanOrEqual(60);
});

test("left-click drag does not engage the scroll-pan handler", async ({ page }) => {
  await bootTimeline(page);

  const result = await page.evaluate(`(() => {
    ${DEEP_FIND}
    const view = deepFind("foyer-timeline-view");
    const scroll = view.renderRoot.querySelector(".scroll");
    const grid = scroll.querySelector(".grid");
    if (grid) grid.style.minWidth = (scroll.clientWidth + 800) + "px";
    if (grid) grid.style.minHeight = (scroll.clientHeight + 600) + "px";
    scroll.scrollLeft = 50;
    scroll.scrollTop  = 30;
    const rect = scroll.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top  + rect.height / 2;
    // Left-button — handler must early-return.
    scroll.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true,
      button: 0, buttons: 1,
      clientX: startX, clientY: startY,
      pointerId: 1, pointerType: "mouse",
    }));
    window.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true,
      button: 0, buttons: 1,
      clientX: startX - 200, clientY: startY - 200,
      pointerId: 1, pointerType: "mouse",
    }));
    const after = { scrollLeft: scroll.scrollLeft, scrollTop: scroll.scrollTop };
    window.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, cancelable: true,
      button: 0, buttons: 0,
      clientX: startX, clientY: startY,
      pointerId: 1, pointerType: "mouse",
    }));
    return after;
  })()`);

  // Left-click drag should NOT have moved scroll positions via the
  // pan handler. (Other handlers like marquee selection might run
  // but they don't touch scrollLeft/Top.)
  expect(result.scrollLeft).toBe(50);
  expect(result.scrollTop).toBe(30);
});
