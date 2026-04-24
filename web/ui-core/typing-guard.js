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
