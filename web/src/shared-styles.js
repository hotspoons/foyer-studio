// Styles that need to live INSIDE every shadow root.
//
// Lit components live in their own shadow roots. Rules we drop into
// `web/styles/tw.css` apply to the light DOM only — in particular,
// `::-webkit-scrollbar*` pseudo-elements are scoped per shadow root and
// don't inherit across the boundary. Any component that has
// `overflow: auto/scroll` needs to import the styles here and include them
// in its `static styles` array so the user sees our styled scrollbars
// instead of the host OS's.

import { css } from "lit";

export const scrollbarStyles = css`
  * {
    scrollbar-width: thin;
    scrollbar-color:
      color-mix(in oklab, var(--color-border) 80%, transparent) transparent;
  }
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb {
    background: color-mix(in oklab, var(--color-border) 80%, transparent);
    border-radius: 4px;
    border: 1px solid transparent;
    background-clip: padding-box;
  }
  *::-webkit-scrollbar-thumb:hover {
    background: color-mix(in oklab, var(--color-accent) 60%, var(--color-border) 40%);
  }
  *::-webkit-scrollbar-corner { background: transparent; }
`;
