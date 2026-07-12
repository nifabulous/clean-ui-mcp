/**
 * dom-motion.ts — normalize DOM transition/animation declarations into bounded signals.
 *
 * Pure function: takes raw computed-style declarations from the capture pipeline
 * and returns a bounded, deduplicated, redacted list of motion signals. No I/O,
 * no DOM access — fully testable offline.
 *
 * Key design decisions:
 * - Zero-duration signals are dropped (no motion → no signal)
 * - Time is normalized to integer milliseconds
 * - Selectors are redacted (strip class hashes, keep tag/role/test-id hints)
 * - Caps: max 50 elements, max 100 signals (prevents prompt bloat)
 * - Failures degrade gracefully (empty signals, not exceptions)
 */
export interface DomMotionInput {
  selector: string;
  transitionDuration?: string;
  transitionProperty?: string;
  transitionDelay?: string;
  transitionTimingFunction?: string;
  animationDuration?: string;
  animationName?: string;
  animationIterationCount?: string;
  animationDelay?: string;
  animationTimingFunction?: string;
}

export interface DomMotionSignal {
  selector: string;       // redacted semantic hint (tag, role, test-id — no class hashes)
  property: string;       // CSS property or animation name
  durationMs: number;     // normalized to integer ms
  delayMs: number;        // normalized to integer ms
  iterationCount?: string; // "infinite" for animations, undefined for transitions
  timingFunction?: string;
}

export interface MotionResult {
  signals: DomMotionSignal[];
  coverage: "full" | "partial" | "none";
  inaccessibleStylesheets: number;
  prefersReducedMotion: boolean;
}

const MAX_ELEMENTS = 50;
const MAX_SIGNALS = 100;

/** Parse a CSS time value (e.g. "0.3s", "250ms") to integer milliseconds. */
function parseTimeMs(value: string | undefined): number {
  if (!value || typeof value !== "string") return 0;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.endsWith("ms")) {
    return Math.round(parseFloat(trimmed) || 0);
  }
  if (trimmed.endsWith("s")) {
    return Math.round((parseFloat(trimmed) || 0) * 1000);
  }
  return Math.round(parseFloat(trimmed) || 0);
}

/** Redact a CSS selector: strip class hashes, keep tag/role/test-id hints. */
function redactSelector(selector: string): string {
  // Keep only semantic tag names and allowlisted role/test-id attributes. Never
  // echo IDs, classes, or arbitrary attribute values from the captured DOM.
  const parts = selector.trim().split(/\s+/);
  return parts
    .map((part) => {
      const tag = part.match(/^(?:[a-z][a-z0-9-]*|\*)/i)?.[0] ?? "";
      const role = part.match(/\[role\s*=\s*["']?([a-z][a-z0-9-]*)["']?\s*\]/i)?.[1];
      const testId = part.match(/\[data-testid\s*=\s*["']?([a-z0-9_-]+)["']?\s*\]/i)?.[1];
      return `${tag}${role ? `[role=${role}]` : ""}${testId ? `[data-testid=${testId}]` : ""}`;
    })
    .filter((p) => p.length > 0)
    .join(" ") || "element";
}

/** Split a comma-separated CSS list into individual values. */
function splitList(value: string | undefined): string[] {
  if (!value || typeof value !== "string") return [];
  return value.split(",").map((s) => s.trim());
}

/**
 * Normalize raw DOM motion declarations into bounded signals.
 */
export function normalizeMotionDeclarations(
  inputs: DomMotionInput[],
  options?: { inaccessibleStylesheets?: number; prefersReducedMotion?: boolean },
): MotionResult {
  const signals: DomMotionSignal[] = [];
  const seenSelectors = new Set<string>();
  const seenSignals = new Set<string>();

  const appendSignal = (signal: DomMotionSignal): void => {
    const key = [signal.selector, signal.property, signal.durationMs, signal.delayMs, signal.iterationCount ?? "", signal.timingFunction ?? ""].join("\u0000");
    if (seenSignals.has(key)) return;
    seenSignals.add(key);
    signals.push(signal);
  };

  for (const input of inputs) {
    if (signals.length >= MAX_SIGNALS) break;

    const selector = redactSelector(input.selector);
    const selectorAlreadyCounted = seenSelectors.has(selector);
    if (!selectorAlreadyCounted && seenSelectors.size >= MAX_ELEMENTS) continue;
    const signalsBefore = signals.length;

    // ── Transitions ──────────────────────────────────────────────────────
    const tDurations = splitList(input.transitionDuration);
    const tProperties = splitList(input.transitionProperty);
    const tDelays = splitList(input.transitionDelay);

    for (let i = 0; i < tDurations.length; i++) {
      if (signals.length >= MAX_SIGNALS) break;
      const durationMs = parseTimeMs(tDurations[i]);
      if (durationMs === 0) continue; // zero-duration → no signal

      const property = tProperties[i] ?? tProperties[0] ?? "unknown";
      const delayMs = tDelays.length > 1 ? parseTimeMs(tDelays[i]) : parseTimeMs(tDelays[0]);

      appendSignal({
        selector,
        property,
        durationMs,
        delayMs,
        timingFunction: input.transitionTimingFunction,
      });
    }

    // ── Animations ───────────────────────────────────────────────────────
    if (input.animationDuration && input.animationName) {
      const aDurations = splitList(input.animationDuration);
      const aNames = splitList(input.animationName);

      for (let i = 0; i < aDurations.length; i++) {
        if (signals.length >= MAX_SIGNALS) break;
        const durationMs = parseTimeMs(aDurations[i]);
        if (durationMs === 0) continue;

        const name = aNames[i] ?? aNames[0] ?? "unknown";
        appendSignal({
          selector,
          property: `animation:${name}`,
          durationMs,
          delayMs: parseTimeMs(input.animationDelay),
          iterationCount: input.animationIterationCount,
          timingFunction: input.animationTimingFunction ?? input.transitionTimingFunction,
        });
      }
    }

    // The element cap limits elements that actually yield motion. Static
    // declarations must not crowd later animated elements out of the budget.
    if (signals.length > signalsBefore) seenSelectors.add(selector);
  }

  const coverage: MotionResult["coverage"] =
    signals.length === 0 ? "none" :
    signals.length >= MAX_SIGNALS ? "partial" :
    "full";

  return {
    signals,
    coverage,
    inaccessibleStylesheets: options?.inaccessibleStylesheets ?? 0,
    prefersReducedMotion: options?.prefersReducedMotion ?? false,
  };
}
