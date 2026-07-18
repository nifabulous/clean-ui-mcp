import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyAction } from "./CopyAction";

// Clipboard behavior contract (spec §9.1: "Copy actions confirm success and
// provide a fallback when clipboard access is unavailable").
//
// The component must:
//   1. Confirm success (visibly + accessibly) when `navigator.clipboard.writeText`
//      resolves.
//   2. Fall back to a manual-copy affordance when the Clipboard API rejects or is
//      absent (e.g. insecure context). The fallback surfaces the text so the user
//      can select/copy it themselves, and never throws into the page.

/**
 * Matcher helper for the fallback value. It lives inside a <code> element whose
 * text content equals the value, but that text is also present in ancestor
 * elements. Return true ONLY for the element whose own text (not its
 * descendants') equals the value, so `findByText` matches a single node.
 */
function valueNode(node: Element | null, expected: string): boolean {
  if (!node) return false;
  // Exclude ancestors: only leaf-ish nodes whose direct child text is the value.
  const ownText = Array.from(node.childNodes)
    .filter((child) => child.nodeType === Node.TEXT_NODE)
    .map((child) => child.textContent ?? "")
    .join("");
  return ownText.trim() === expected;
}

/**
 * Install a controllable `navigator.clipboard`. The descriptor is writable +
 * configurable so each test can simulate a working, rejecting, or absent API
 * via plain reassignment or `installClipboard(undefined)`.
 */
function installClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value,
  });
}

describe("CopyAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Restore a neutral absent clipboard so spies do not leak between tests.
    installClipboard(undefined);
  });

  it("renders a button that copies the provided value", async () => {
    const writeText = vi.fn(async (text: string) => {
      void text;
    });
    installClipboard({ writeText });

    render(<CopyAction value="npm i clean-ui-mcp" label="Copy install command" />);
    fireEvent.click(screen.getByRole("button", { name: /copy install command/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("npm i clean-ui-mcp"));
  });

  it("confirms success after a successful copy", async () => {
    installClipboard({ writeText: vi.fn(async () => undefined) });

    render(<CopyAction value="hello" label="Copy" />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    // A success state is surfaced to assistive tech via role=status and to
    // sighted users via an updated, non-color-only affordance.
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("shows a manual-copy fallback when the Clipboard API rejects", async () => {
    installClipboard({
      writeText: vi.fn(() => Promise.reject(new Error("not allowed"))),
    });

    render(<CopyAction value="npm i clean-ui-mcp" label="Copy install command" />);
    fireEvent.click(screen.getByRole("button", { name: /copy install command/i }));

    // The value must be surfaced somewhere the user can select and copy by hand.
    expect(await screen.findByText((_, node) => valueNode(node, "npm i clean-ui-mcp")))
      .toBeInTheDocument();
    // The fallback affordance is announced and described (not color-only).
    expect(screen.getByRole("status")).toBeInTheDocument();
    // The button reflects the unavailable state, never just a color change.
    expect(screen.getByRole("button", { name: /copy unavailable/i })).toBeInTheDocument();
  });

  it("shows a manual-copy fallback when the Clipboard API is absent", async () => {
    // Remove the Clipboard API entirely (e.g. insecure context / old browser).
    installClipboard(undefined);

    render(<CopyAction value="node dist/server.js" label="Copy run command" />);
    fireEvent.click(screen.getByRole("button", { name: /copy run command/i }));

    // The component must not throw; it surfaces the text for manual copy.
    expect(await screen.findByText((_, node) => valueNode(node, "node dist/server.js")))
      .toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
