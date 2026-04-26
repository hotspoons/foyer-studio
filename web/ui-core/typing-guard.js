// SPDX-License-Identifier: Apache-2.0
//
// Shared guard for global keydown handlers. Lit components render into
// shadow roots, so a `keydown` event that originated on a <textarea>
// inside `<foyer-chat-panel>` shows up at the `window` handler with
// `ev.target === <foyer-chat-panel>`. The classic
// `target instanceof HTMLInputElement` test silently fails and the
// global handler hijacks Space / Arrow / etc. while the user is typing.
//
// `composedPath()` walks through shadow roots, so we catch the real
// deep target. Also accepts `role="textbox"` elements and
// contentEditable hosts for future-proofing.

/**
 * Whether there's a non-empty text selection visible to the user
 * right now — anywhere on the page, including inside shadow roots.
 * Use this to decide whether `Cmd+C` / `Cmd+X` keybinds should
 * defer to the browser's native clipboard instead of routing through
 * a DAW `edit.copy` action. Highlighted credentials in a modal,
 * paths in the project picker, log lines in the console — all of
 * those want native copy.
 *
 * @returns {boolean} true if any selection has at least one character.
 */
export function hasActiveTextSelection() {
  // Top-level document selection — covers most cases.
  const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
  if (sel && !sel.isCollapsed && sel.toString().length > 0) return true;
  // Selections inside a shadow root don't appear in document.getSelection
  // on all browsers; check the active element's shadow root too.
  // (Chromium ≥ 53 + Safari handle shadow selection via the document
  // method but this catches edge cases like nested shadow roots.)
  let node = typeof document !== "undefined" ? document.activeElement : null;
  while (node && node.shadowRoot) {
    const inner = node.shadowRoot.getSelection?.();
    if (inner && !inner.isCollapsed && inner.toString().length > 0) return true;
    node = node.shadowRoot.activeElement;
  }
  return false;
}

/**
 * @param {Event} ev
 * @returns {boolean} true if the event originated inside a text entry.
 */
export function isTypingTarget(ev) {
  if (!ev) return false;
  const path = typeof ev.composedPath === "function" ? ev.composedPath() : [];
  const nodes = path.length ? path : [ev.target];
  for (const node of nodes) {
    if (!node) continue;
    if (node instanceof HTMLInputElement) {
      // A checkbox / button / radio isn't "typing" — only text-bearing types.
      const type = (node.type || "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset"
          || type === "checkbox" || type === "radio" || type === "range"
          || type === "color" || type === "file") {
        continue;
      }
      return true;
    }
    if (node instanceof HTMLTextAreaElement) return true;
    if (node instanceof HTMLSelectElement) return true;
    if (node instanceof HTMLElement) {
      if (node.isContentEditable) return true;
      const role = node.getAttribute?.("role");
      if (role === "textbox" || role === "searchbox" || role === "combobox") return true;
    }
  }
  return false;
}
