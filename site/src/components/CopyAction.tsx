import { useEffect, useRef, useState, type ReactElement } from "react";

/**
 * Copy state machine (spec §9.1: "Copy actions confirm success and provide a
 * fallback when clipboard access is unavailable").
 *
 * - `idle`: the button shows its label, ready to copy.
 * - `success`: the Clipboard API resolved; the button announces "Copied".
 * - `fallback`: the Clipboard API rejected or is absent; the value is rendered
 *   in a selectable region so the user can copy it manually.
 */
type CopyState = "idle" | "success" | "fallback";

export interface CopyActionProps {
  /** The exact text to place on the clipboard. */
  readonly value: string;
  /** Accessible name and visible label for the copy button. */
  readonly label: string;
}

/**
 * A copy-to-clipboard control with a guaranteed fallback.
 *
 * Attempts `navigator.clipboard.writeText`. On success it announces "Copied" via
 * a live `role="status"` region (color is never the only signal). When the
 * Clipboard API rejects or is absent (insecure context, permissions, old
 * browser), it surfaces the value in a selectable text region with an announced
 * "copy unavailable — select manually" note, instead of throwing or silently
 * failing.
 */
export function CopyAction({ value, label }: CopyActionProps): ReactElement {
  const [state, setState] = useState<CopyState>("idle");
  const fallbackRef = useRef<HTMLDivElement | null>(null);

  // Reset to idle a moment after a successful copy so the control can be reused.
  // The fallback state is sticky (the value stays selectable) until the user
  // interacts again.
  useEffect(() => {
    if (state !== "success") return;
    const timer = window.setTimeout(() => setState("idle"), 2400);
    return () => window.clearTimeout(timer);
  }, [state]);

  const handleCopy = async (): Promise<void> => {
    // Reset any prior announcement first so a repeated attempt is observed.
    setState("idle");

    const clipboard = readClipboard();
    if (!clipboard || typeof clipboard.writeText !== "function") {
      // No Clipboard API at all: fall straight back to a manual-select affordance.
      setState("fallback");
      selectFallback();
      return;
    }

    try {
      // Call as a method on the clipboard holder so `this` is preserved (some
      // implementations require it) AND the underlying function reference is
      // invoked directly — important for test spies and for rejections to throw.
      await clipboard.writeText(value);
      setState("success");
    } catch {
      // Rejection (permissions, insecure context): surface the value for manual
      // copy. Never throw into the page.
      setState("fallback");
      selectFallback();
    }
  };

  const selectFallback = (): void => {
    // Defer to the next frame so the fallback region has rendered.
    window.requestAnimationFrame(() => {
      const node = fallbackRef.current;
      if (!node) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      if (!selection) return;
      selection.removeAllRanges();
      selection.addRange(range);
    });
  };

  const accessibleName =
    state === "success" ? `${label} — copied` : state === "fallback" ? `${label} — copy unavailable, select manually` : label;

  return (
    <span className="copy-action">
      <button
        type="button"
        className="copy-action__button"
        onClick={handleCopy}
        aria-label={accessibleName}
        data-state={state}
      >
        <span aria-hidden="true" className="copy-action__glyph">
          {state === "success" ? "✓" : "⧉"}
        </span>
        <span className="copy-action__label">
          {state === "success" ? "Copied" : state === "fallback" ? "Select to copy" : "Copy"}
        </span>
      </button>
      {state === "fallback" && (
        <span className="copy-action__fallback">
          {/* The value is rendered as selectable text so the user can copy it by
              hand when the async Clipboard API is unavailable. */}
          <span className="copy-action__fallback-label">Copy unavailable — select:</span>
          <code ref={fallbackRef} className="copy-action__fallback-value">
            {value}
          </code>
        </span>
      )}
      {(state === "success" || state === "fallback") && (
        <span className="copy-action__status" role="status">
          {state === "success" ? "Copied to clipboard." : "Clipboard unavailable. Select the text to copy manually."}
        </span>
      )}
    </span>
  );
}

/**
 * Read the `clipboard` holder off `navigator` if it exists, or `null` when the
 * Clipboard API is absent. Returning the holder (not the bound function) keeps
 * `writeText` callable as a method (preserving `this`) and lets test spies on
 * `navigator.clipboard.writeText` observe the call.
 */
function readClipboard(): { writeText: (data: string) => Promise<void> } | null {
  if (typeof navigator !== "object" || navigator === null) return null;
  const clipboard = (navigator as Navigator & {
    clipboard?: { writeText?: (data: string) => Promise<void> };
  }).clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") return null;
  return { writeText: clipboard.writeText };
}
