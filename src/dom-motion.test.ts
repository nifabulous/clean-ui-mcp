import { describe, expect, it } from "vitest";
import { normalizeMotionDeclarations, type DomMotionInput } from "./dom-motion.js";

describe("normalizeMotionDeclarations", () => {
  it("returns empty for zero-duration transitions", () => {
    const result = normalizeMotionDeclarations([
      { selector: "button", transitionDuration: "0s", transitionProperty: "transform", transitionDelay: "0s" },
    ]);
    expect(result.signals).toEqual([]);
  });

  it("normalizes seconds to milliseconds", () => {
    const result = normalizeMotionDeclarations([
      { selector: "div", transitionDuration: "0.3s", transitionProperty: "opacity", transitionDelay: "0s" },
    ]);
    expect(result.signals[0].durationMs).toBe(300);
  });

  it("normalizes milliseconds as-is", () => {
    const result = normalizeMotionDeclarations([
      { selector: "div", transitionDuration: "250ms", transitionProperty: "transform", transitionDelay: "0s" },
    ]);
    expect(result.signals[0].durationMs).toBe(250);
  });

  it("handles mixed s/ms duration lists (property cycling)", () => {
    const result = normalizeMotionDeclarations([
      {
        selector: "div",
        transitionDuration: "0.2s, 0.1s",
        transitionProperty: "transform, opacity",
        transitionDelay: "0s, 0.05s",
      },
    ]);
    expect(result.signals.length).toBe(2);
    expect(result.signals[0].durationMs).toBe(200);
    expect(result.signals[0].property).toBe("transform");
    expect(result.signals[1].durationMs).toBe(100);
    expect(result.signals[1].property).toBe("opacity");
    expect(result.signals[1].delayMs).toBe(50);
  });

  it("handles transition: all", () => {
    const result = normalizeMotionDeclarations([
      { selector: "*", transitionDuration: "0.4s", transitionProperty: "all", transitionDelay: "0s" },
    ]);
    expect(result.signals.length).toBe(1);
    expect(result.signals[0].property).toBe("all");
  });

  it("handles animation declarations", () => {
    const result = normalizeMotionDeclarations([
      { selector: ".spinner", animationDuration: "1s", animationName: "spin", animationIterationCount: "infinite" },
    ]);
    expect(result.signals.length).toBe(1);
    expect(result.signals[0].durationMs).toBe(1000);
    expect(result.signals[0].property).toBe("animation:spin");
    expect(result.signals[0].iterationCount).toBe("infinite");
  });

  it("caps at 100 signals", () => {
    const inputs: DomMotionInput[] = Array.from({ length: 200 }, (_, i) => ({
      selector: `el-${i}`, transitionDuration: "0.3s", transitionProperty: "transform", transitionDelay: "0s",
    }));
    const result = normalizeMotionDeclarations(inputs);
    expect(result.signals.length).toBeLessThanOrEqual(100);
  });

  it("caps at 50 elements", () => {
    const inputs: DomMotionInput[] = Array.from({ length: 200 }, (_, i) => ({
      selector: `el-${i}`, transitionDuration: "0.3s", transitionProperty: "transform", transitionDelay: "0s",
    }));
    const result = normalizeMotionDeclarations(inputs);
    // Each element produces 1 signal → at most 100 signals from 50 elements
    // But the cap is on signals (100), not elements directly — verify we process ≤50 unique selectors
    const uniqueSelectors = new Set(result.signals.map((s) => s.selector));
    expect(uniqueSelectors.size).toBeLessThanOrEqual(50);
  });

  it("redacts unstable selectors (class hashes)", () => {
    const result = normalizeMotionDeclarations([
      { selector: ".css-1abc2def button", transitionDuration: "0.3s", transitionProperty: "opacity", transitionDelay: "0s" },
    ]);
    // Should keep the tag/role hint but strip the class hash
    expect(result.signals[0].selector).not.toContain("css-1abc2def");
    expect(result.signals[0].selector).toContain("button");
  });

  it("returns partial coverage instead of throwing on empty input", () => {
    const result = normalizeMotionDeclarations([]);
    expect(result.signals).toEqual([]);
    expect(result.coverage).toBe("none");
  });

  it("reports inaccessibleStylesheets count", () => {
    const result = normalizeMotionDeclarations(
      [{ selector: "div", transitionDuration: "0.3s", transitionProperty: "opacity", transitionDelay: "0s" }],
      { inaccessibleStylesheets: 2 },
    );
    expect(result.inaccessibleStylesheets).toBe(2);
  });

  it("detects prefers-reduced-motion override", () => {
    const result = normalizeMotionDeclarations(
      [{ selector: "div", transitionDuration: "0.3s", transitionProperty: "opacity", transitionDelay: "0s" }],
      { prefersReducedMotion: true },
    );
    expect(result.prefersReducedMotion).toBe(true);
  });
});
