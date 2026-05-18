// SPDX-License-Identifier: Apache-2.0
//
// CSS extracted from agent-panel.js so the component file stays readable.
// Interpolated JS constants are re-exported here as the source of
// truth; the component imports them back from this module.

import { css } from "lit";
import { scrollbarStyles } from "foyer-ui-core/shared-styles.js";

export const FAB_SIZE = 48;

export const panelStyles = css`
    ${scrollbarStyles}
    :host { display: contents; }

    /* FAB — gradient accent, always on top, draggable. */
    .fab {
      position: fixed;
      width: ${FAB_SIZE}px;
      height: ${FAB_SIZE}px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border: none;
      cursor: grab;
      box-shadow: var(--shadow-fab);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      transition: box-shadow 0.15s ease, transform 0.15s ease;
      touch-action: none;
      user-select: none;
    }
    .fab:hover {
      box-shadow: var(--shadow-fab-hover);
      transform: scale(1.04);
    }
    .fab.dragging { cursor: grabbing; transition: none; }
    .fab.open {
      background: linear-gradient(135deg, var(--color-accent-2), var(--color-accent-3));
    }
    .fab svg {
      width: 22px; height: 22px; stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }

    /* Panel — position set via inline style, bounded by viewport. */
    .panel {
      position: fixed;
      min-width: 320px;
      min-height: 280px;
      max-width: calc(100vw - 2.5rem);
      max-height: calc(100vh - 5rem);
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-panel);
      display: flex;
      flex-direction: column;
      z-index: 999;
      color: var(--color-text);
      overflow: hidden;
    }

    .panel header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px;
      border-bottom: 1px solid var(--color-border);
      cursor: grab;
      background: var(--color-surface-elevated);
      font-family: var(--font-sans);
      font-size: 10px;
      color: var(--color-text-muted);
    }
    .panel header.dragging { cursor: grabbing; }
    .panel header .title {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text);
    }
    .panel header .spacer { flex: 1; }
    .panel header button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: transparent;
      color: var(--color-text-muted);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      padding: 2px 6px;
      font: inherit;
      font-size: 10px;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .panel header button:hover {
      color: var(--color-text);
      border-color: var(--color-border);
      background: var(--color-surface);
    }

    .transcript {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 12px;
      line-height: 1.5;
      scrollbar-width: thin;
      scrollbar-color: var(--color-border) transparent;
      /* Highlight + copy must work inside chat messages. The panel
         container above suppresses selection so the drag-handle isn't
         accidentally selecting; we re-enable it here so users can grab
         text, code, and tool-call args/results. */
      user-select: text;
      -webkit-user-select: text;
    }
    /* Flex children default to flex-shrink:1, which squeezes every
       message progressively as the column fills up — that's what
       turned tool cards into hairlines once the transcript grew long.
       Pin all transcript items to their natural height and let the
       transcript's own overflow-y:auto handle scroll. NB: keep
       backticks out of this comment; they close the css template. */
    .transcript > * { flex-shrink: 0; }
    .msg {
      max-width: 80%;
      padding: 8px 10px;
      border-radius: var(--radius-md);
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .msg.user {
      align-self: flex-end;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border-bottom-right-radius: 2px;
      max-width: 80%;
    }
    .msg.assistant,
    .msg.system {
      align-self: stretch;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      color: var(--color-text);
      max-width: none;
    }
    .msg.system { opacity: 0.7; font-style: italic; }
    /* Markdown rendered inside assistant messages */
    .msg.assistant .md > :first-child { margin-top: 0; }
    .msg.assistant .md > :last-child  { margin-bottom: 0; }
    .msg.assistant .md p { margin: 0.4em 0; }
    .msg.assistant .md ul,
    .msg.assistant .md ol { margin: 0.4em 0; padding-left: 1.4em; }
    .msg.assistant .md code {
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: 3px;
      padding: 0 4px;
      font-family: var(--font-mono, monospace);
      font-size: 11px;
    }
    .msg.assistant .md pre {
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 8px 10px;
      overflow-x: auto;
      margin: 0.4em 0;
    }
    .msg.assistant .md pre code { background: transparent; border: 0; padding: 0; }

    /* Reasoning trace — collapsible block emitted by models that expose
       chain-of-thought (DeepSeek-R1, QwQ, OpenAI o-series). Kept dim
       and italic so it doesn't compete with the final reply. */
    .thinking {
      align-self: stretch;
      font-size: 11px;
      color: var(--color-text-muted);
      margin: 2px 0;
    }
    .thinking summary {
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      list-style: none;
      user-select: none;
      padding: 2px 0;
      opacity: 0.75;
    }
    .thinking summary::-webkit-details-marker { display: none; }
    .thinking summary .caret {
      display: inline-block;
      transition: transform 0.15s ease;
      font-size: 9px;
    }
    .thinking[open] summary .caret { transform: rotate(90deg); }
    .thinking .body {
      margin-top: 2px;
      padding: 6px 8px;
      border-left: 2px solid var(--color-border);
      white-space: pre-wrap;
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      line-height: 1.45;
      opacity: 0.85;
      user-select: text;
      -webkit-user-select: text;
      /* No internal scroll: the transcript already scrolls, and a
         nested scroller hides the report text that follows the
         thinking block. Long reasoning just grows the row — the
         user collapses it via the disclosure caret if they don't
         want it taking space. */
    }
    .thinking.live summary { opacity: 1; }
    .thinking.live summary .spinner {
      width: 10px; height: 10px;
      border: 1.5px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: foyer-agent-spin 0.8s linear infinite;
    }
    @keyframes foyer-agent-spin { to { transform: rotate(360deg); } }

    /* Tool call cards (patapsco-style) */
    .tool-card {
      align-self: stretch;
      display: block;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      font-size: 12px;
      overflow: hidden;
    }
    .tool-card > summary {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px;
      cursor: pointer;
      list-style: none;
      color: var(--color-text);
      user-select: none;
    }
    .tool-card > summary::-webkit-details-marker { display: none; }
    .tool-card .tool-name { font-weight: 600; flex-shrink: 0; }
    /* Truncated inline result summary — keeps the closed card useful
       so the user doesn't have to expand every call to see what it
       returned. */
    .tool-card .tool-inline-summary {
      color: var(--color-text-muted);
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1 1 auto;
    }
    .tool-card .tool-status {
      margin-left: auto;
      color: var(--color-text-muted);
      font-size: 11px;
      flex-shrink: 0;
    }
    .tool-card.done    { border-color: color-mix(in oklab, var(--color-accent) 50%, var(--color-border)); }
    .tool-card.error   { border-color: var(--color-danger, #ef4444); }
    .tool-card.running { border-color: var(--color-accent); }
    .tool-card.awaiting_confirm { border-color: var(--color-warning, #d49b1c); }
    .tool-details {
      border-top: 1px solid var(--color-border);
      padding: 6px 10px;
      display: flex; flex-direction: column; gap: 6px;
      background: var(--color-surface-elevated);
    }
    .tool-block {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--color-text);
      user-select: text;
      -webkit-user-select: text;
    }
    .tool-block-expand {
      align-self: flex-start;
      background: transparent;
      border: 1px solid var(--color-border);
      color: var(--color-text-muted);
      font: inherit;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      cursor: pointer;
    }
    .tool-block-expand:hover { color: var(--color-text); }
    .tool-view-toggle {
      display: inline-flex;
      gap: 2px;
      align-self: flex-end;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 2px;
    }
    .tool-view-toggle button {
      background: transparent;
      border: 0;
      color: var(--color-text-muted);
      font: inherit;
      font-size: 10px;
      padding: 2px 8px;
      cursor: pointer;
      border-radius: 3px;
    }
    .tool-view-toggle button.active {
      background: var(--color-surface-elevated);
      color: var(--color-text);
    }
    .tool-section-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--color-text-muted);
      margin-top: 2px;
    }
    .tool-section-label + .tool-block,
    .tool-section-label + .tool-kv,
    .tool-section-label + .tool-kv-list,
    .tool-section-label + .tool-kv-scalar {
      margin-top: -2px;
    }
    /* Pretty K/V default view: two-column dl with terms left, values
       right. Stays compact even for moderately wide cards. */
    .tool-kv {
      display: grid;
      grid-template-columns: max-content 1fr;
      column-gap: 10px;
      row-gap: 2px;
      margin: 0;
      font-size: 11px;
    }
    .tool-kv dt {
      color: var(--color-text-muted);
      font-family: var(--font-mono, monospace);
    }
    .tool-kv dd {
      margin: 0;
      color: var(--color-text);
      word-break: break-word;
      user-select: text;
    }
    .tool-kv-list {
      margin: 0;
      padding-left: 1.4em;
      font-size: 11px;
    }
    .tool-kv-scalar {
      font-size: 11px;
      color: var(--color-text);
      user-select: text;
    }
    .tool-kv-str { color: var(--color-text); }
    .tool-kv-num { color: color-mix(in oklab, var(--color-accent) 60%, var(--color-text)); }
    .tool-kv-bool { color: color-mix(in oklab, var(--color-warning, #d49b1c) 70%, var(--color-text)); }
    .tool-kv-json {
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 3px;
      padding: 1px 4px;
      color: var(--color-text-muted);
    }
    .muted { color: var(--color-text-muted); opacity: 0.7; }

    /* Inline media thumbnail (24px tall by spec) — click opens
       full-resolution zoom modal mounted at the panel root. */
    .tool-media-thumb {
      background: transparent;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 2px;
      cursor: zoom-in;
      align-self: flex-start;
      transition: border-color 0.12s ease;
    }
    .tool-media-thumb:hover { border-color: var(--color-accent); }
    .tool-media-thumb img {
      display: block;
      height: 24px;
      width: auto;
      max-width: 320px;
      object-fit: contain;
    }

    /* Zoom modal — full-screen backdrop, image centered, click outside
       (or X / Escape) to close. Lives at the top of the panel so it
       overlays everything including the composer. */
    .media-zoom-backdrop {
      position: fixed;
      inset: 0;
      z-index: 9000;
      background: rgba(0,0,0,0.72);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      cursor: zoom-out;
    }
    .media-zoom-image {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      cursor: default;
      box-shadow: 0 12px 48px rgba(0,0,0,0.55);
      border-radius: var(--radius-md);
    }
    .media-zoom-close {
      position: absolute;
      top: 16px;
      right: 16px;
      background: rgba(0,0,0,0.4);
      color: white;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: var(--radius-sm);
      padding: 4px;
      cursor: pointer;
    }
    .media-zoom-close:hover { background: rgba(0,0,0,0.6); }
    .tool-confirm-row {
      display: flex; gap: 6px; padding: 6px 10px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
    }
    .tool-confirm-row button { flex: 1; font-size: 11px; padding: 4px 8px; }

    /* Chat sessions overlay (Claude-Code-style picker). Mounted
       inside the panel so it lives next to the FAB even when the
       panel is floating somewhere off-screen. */
    .sessions-backdrop {
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.55);
      display: flex; align-items: center; justify-content: center;
      z-index: 50;
    }
    .sessions-modal {
      width: 92%; max-width: 380px; max-height: 90%;
      background: var(--color-surface-elevated);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    .sessions-modal > header {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      font-size: 10px;
      color: var(--color-text-muted);
    }
    .sessions-modal > header .title {
      font-size: 10px; font-weight: 600;
      letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--color-text);
    }
    .sessions-modal > header .spacer { flex: 1; }
    .sessions-modal > header button {
      display: inline-flex; align-items: center; gap: 4px;
      background: transparent;
      color: var(--color-text-muted);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      padding: 2px 6px;
      font: inherit; font-size: 10px;
      cursor: pointer;
    }
    .sessions-modal > header button:hover {
      color: var(--color-text);
      border-color: var(--color-border);
      background: var(--color-surface);
    }
    .sessions-body {
      flex: 1; overflow-y: auto;
      padding: 6px;
      display: flex; flex-direction: column; gap: 4px;
    }
    .sessions-empty {
      padding: 16px;
      text-align: center;
      color: var(--color-text-muted);
      font-size: 11px;
    }
    .session-row {
      display: flex; align-items: stretch; gap: 4px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    .session-row.active {
      border-color: var(--color-accent);
    }
    .session-pick {
      flex: 1;
      text-align: left;
      background: transparent;
      border: 0;
      padding: 8px 10px;
      cursor: pointer;
      color: var(--color-text);
    }
    .session-pick:hover { background: var(--color-surface-elevated); }
    .session-title { font-size: 12px; font-weight: 600; }
    .session-meta { font-size: 10px; color: var(--color-text-muted); margin-top: 2px; }
    .session-action {
      background: transparent;
      border: 0;
      color: var(--color-text-muted);
      cursor: pointer;
      padding: 0 8px;
    }
    .session-action:hover { color: var(--color-text); }
    .session-action.danger:hover { color: var(--color-danger, #ef4444); }
    .sessions-confirm {
      padding: 8px 10px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface);
      font-size: 11px;
      color: var(--color-text);
      display: flex; align-items: center; gap: 10px;
    }
    .sessions-confirm span { flex: 1; }
    .sessions-confirm button {
      font: inherit;
      font-size: 11px;
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--color-border);
      background: var(--color-surface-elevated);
      color: var(--color-text);
      cursor: pointer;
    }
    .sessions-confirm button.danger {
      background: var(--color-danger, #ef4444);
      border-color: var(--color-danger, #ef4444);
      color: #fff;
    }
    .welcome,
    .empty {
      color: var(--color-text-muted);
      font-size: 12px;
      padding: 24px 12px;
      text-align: center;
    }
    .welcome strong,
    .empty strong {
      display: block;
      margin-bottom: 4px;
      color: var(--color-text);
      font-weight: 600;
    }

    .composer {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 6px;
      padding: 10px 12px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    .composer textarea {
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 6px 8px;
      font-family: var(--font-sans);
      font-size: 12px;
      /* User-resizable: drag the SE grip to grow vertically (and
         a little horizontally, capped by the column). Height is
         sticky via _composerHeight saved into localStorage. */
      resize: vertical;
      min-height: 36px;
      max-height: 360px;
      width: 100%;
      box-sizing: border-box;
    }
    .composer textarea:focus {
      outline: none;
      border-color: var(--color-accent);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-accent) 30%, transparent);
    }
    .composer button {
      width: 36px; height: 36px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-elevated);
      color: var(--color-text);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .composer button:hover:not(:disabled) {
      filter: brightness(1.1);
      transform: translateY(-1px);
    }
    .composer button:disabled { opacity: 0.5; cursor: not-allowed; }
    .composer.drop-hover {
      outline: 2px dashed var(--color-accent);
      outline-offset: -2px;
    }
    /* Send button switches to a stop/interrupt affordance when the
       agent is busy AND the user has typed something — clicking it
       cancels the current turn and dispatches the new message. */
    .composer button.send-stop {
      background: var(--color-danger, #ef4444);
      color: white;
      border-color: var(--color-danger, #ef4444);
    }
    /* Queued-message banner above the textarea. Visible only while
       the user has parked a message and the agent is still busy. */
    .queued-banner {
      grid-column: 1 / -1;
      display: flex;
      gap: 6px;
      align-items: center;
      justify-content: space-between;
      padding: 4px 6px;
      margin-bottom: 4px;
      border: 1px dashed var(--color-warning, #d49b1c);
      border-radius: var(--radius-sm);
      background: color-mix(in oklab, var(--color-warning, #d49b1c) 6%, var(--color-surface));
      font-size: 11px;
    }
    .queued-banner-body {
      display: flex;
      gap: 6px;
      min-width: 0;
      flex: 1;
      align-items: center;
    }
    .queued-banner strong {
      color: var(--color-text-muted);
      flex-shrink: 0;
    }
    .queued-text {
      color: var(--color-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .queued-banner-actions { display: inline-flex; gap: 4px; flex-shrink: 0; }
    .queued-banner-actions button {
      background: transparent;
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 2px 8px;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .queued-banner-actions .queued-stop {
      background: var(--color-warning, #d49b1c);
      color: black;
      border-color: var(--color-warning, #d49b1c);
      font-weight: 600;
    }
    .queued-banner-actions .queued-stop:hover { filter: brightness(1.05); }
    .queued-banner-actions .queued-restore:hover,
    .queued-banner-actions .queued-cancel:hover { background: var(--color-surface-elevated); }
    .queued-banner-actions .queued-cancel {
      width: 22px; height: 22px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .attachments {
      grid-column: 1 / -1;
      display: flex;
      flex-direction: column;
      gap: 4px;
      align-items: stretch;
      max-height: 120px;
      overflow-y: auto;
      margin-bottom: 4px;
      /* Vertical stack with a hard cap so dropping a dozen files
       * doesn't push the textarea offscreen — chips beyond ~3 rows
       * scroll inside this container. */
    }
    .attachments .chip {
      display: flex; align-items: center; gap: 6px;
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 3px 6px 3px 8px;
      font-size: 11px;
      color: var(--color-text);
      /* Each chip takes the FULL width of the stack so the layout
       * grows DOWN, not across — matches the "stack then scroll"
       * expectation. */
      width: 100%;
      box-sizing: border-box;
    }
    .attachments .chip button {
      width: 16px; height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      background: transparent;
      border: 0;
      color: var(--color-text-muted);
      cursor: pointer;
      padding: 0;
    }
    .attachments .chip button:hover { color: var(--color-text); }
    .attachments .chip .name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Image preview inside the chip — same 24 px sizing the tool-call
     * media renderer uses so the two surfaces feel consistent. Click
     * opens the existing zoom modal. */
    .attachments .chip .thumb {
      background: transparent;
      border: 0;
      padding: 0;
      cursor: zoom-in;
      display: inline-flex;
      align-items: center;
    }
    .attachments .chip .thumb img {
      display: block;
      height: 22px;
      width: auto;
      max-width: 80px;
      object-fit: contain;
      border-radius: 3px;
    }

    .input-area {
      display: flex;
      gap: 6px;
      padding: 10px 12px;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    .input-area textarea {
      flex: 1;
      background: var(--color-surface-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 6px 8px;
      font-family: var(--font-sans);
      font-size: 12px;
      resize: none;
      min-height: 36px;
      max-height: 140px;
      transition: border-color 0.15s ease;
    }
    .input-area textarea:focus {
      outline: none;
      border-color: var(--color-accent);
      box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-accent) 30%, transparent);
    }
    .input-area button {
      width: 36px;
      height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
      color: #fff;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .input-area button:hover:not(:disabled) {
      filter: brightness(1.12);
      transform: translateY(-1px);
    }
    .input-area button:disabled { opacity: 0.45; cursor: not-allowed; }
    .input-area button svg {
      width: 16px; height: 16px; stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }

    /* Resize handle (single corner, opposite the FAB). */
    .resize {
      position: absolute;
      width: 14px; height: 14px;
      z-index: 2;
    }
    .resize.nw { top: 0; left: 0;   cursor: nw-resize; }
    .resize.ne { top: 0; right: 0;  cursor: ne-resize; }
    .resize.sw { bottom: 0; left: 0; cursor: sw-resize; }
    .resize.se { bottom: 0; right: 0; cursor: se-resize; }
`;
