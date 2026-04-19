// Minimal toast notifications for the `Msg` command.
//
// Single singleton stack mounted at document.body, bottom-right. Each toast
// auto-dismisses after 3s; click to dismiss sooner. Designed to be lazy —
// the `toast()` import path is only pulled in when a script uses `Msg`.

const STACK_ID = "foyer-toast-stack";

function ensureStack() {
  let el = document.getElementById(STACK_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = STACK_ID;
  Object.assign(el.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    display: "flex",
    flexDirection: "column-reverse",
    gap: "8px",
    zIndex: "6000",
    pointerEvents: "none",
  });
  document.body.appendChild(el);
  return el;
}

/** Show a toast. Returns a disposer that removes it early. */
export function toast(message, { ttl = 3000, tone = "info" } = {}) {
  const stack = ensureStack();
  const card = document.createElement("div");
  Object.assign(card.style, {
    background: "var(--color-surface-elevated)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-md)",
    padding: "8px 12px",
    color: "var(--color-text)",
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    boxShadow: "var(--shadow-panel)",
    minWidth: "180px",
    maxWidth: "320px",
    pointerEvents: "auto",
    cursor: "pointer",
    transition: "opacity 0.2s ease, transform 0.2s ease",
    opacity: "0",
    transform: "translateY(8px)",
  });
  if (tone === "error") {
    card.style.borderColor = "var(--color-danger)";
  } else if (tone === "warn") {
    card.style.borderColor = "var(--color-warning)";
  }
  card.textContent = String(message ?? "");
  stack.appendChild(card);

  // Animate in.
  requestAnimationFrame(() => {
    card.style.opacity = "1";
    card.style.transform = "translateY(0)";
  });

  const dismiss = () => {
    if (!card.isConnected) return;
    card.style.opacity = "0";
    card.style.transform = "translateY(8px)";
    setTimeout(() => card.remove(), 200);
  };
  card.addEventListener("click", dismiss);
  const timer = setTimeout(dismiss, ttl);
  return () => {
    clearTimeout(timer);
    dismiss();
  };
}
