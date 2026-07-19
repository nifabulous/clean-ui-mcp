import type { ReactElement } from "react";

/**
 * Abstract architectural backdrop for the hero (spec §5.2).
 *
 * Pure CSS/SVG — no external assets. Renders faint layout-region forms (abstract
 * rectangles and lines suggesting UI regions/cards) that frame the hero but
 * never cross critical copy or controls.
 *
 * Accessibility + interaction contract:
 * - `aria-hidden="true"`: decorative geometry is hidden from assistive tech.
 * - `pointer-events: none`: the layer never intercepts clicks/taps on the
 *   overlaying hero copy or actions.
 * - Reduces opacity at `max-width: 900px` (simplifies on mid-width screens).
 * - Removes the large flank objects below `max-width: 640px` (narrow screens),
 *   leaving only the faintest center scaffolding so the hero stays legible.
 */
export function ArchitecturalBackdrop(): ReactElement {
  return (
    <div className="arch-backdrop" aria-hidden="true" data-testid="architectural-backdrop">
      <svg
        className="arch-backdrop__svg"
        viewBox="0 0 1440 720"
        preserveAspectRatio="xMidYMid slice"
        focusable="false"
      >
        {/* Faint baseline grid suggesting a layout canvas. */}
        <g className="arch-backdrop__grid">
          <line x1="0" y1="180" x2="1440" y2="180" />
          <line x1="0" y1="360" x2="1440" y2="360" />
          <line x1="0" y1="540" x2="1440" y2="540" />
          <line x1="480" y1="0" x2="480" y2="720" />
          <line x1="960" y1="0" x2="960" y2="720" />
        </g>

        {/* Left flank: a stacked-card composition suggesting app regions. */}
        <g className="arch-backdrop__flank arch-backdrop__flank--left">
          <rect x="60" y="120" width="240" height="140" rx="14" />
          <rect x="84" y="150" width="120" height="12" rx="6" />
          <rect x="84" y="174" width="192" height="8" rx="4" />
          <rect x="84" y="194" width="160" height="8" rx="4" />
          <rect x="60" y="290" width="200" height="160" rx="14" />
          <rect x="84" y="320" width="64" height="64" rx="10" />
          <rect x="160" y="328" width="100" height="10" rx="5" />
          <rect x="160" y="348" width="76" height="10" rx="5" />
        </g>

        {/* Right flank: a column of abstract regions + a chart-line motif. */}
        <g className="arch-backdrop__flank arch-backdrop__flank--right">
          <rect x="1140" y="140" width="240" height="100" rx="14" />
          <rect x="1164" y="168" width="140" height="10" rx="5" />
          <rect x="1164" y="190" width="180" height="8" rx="4" />
          <rect x="1140" y="270" width="240" height="190" rx="14" />
          <polyline points="1164,420 1210,360 1256,390 1302,318 1348,352 1364,330" />
          <rect x="1164" y="450" width="120" height="8" rx="4" />
        </g>

        {/* Center scaffolding: a single faint hero region outline. */}
        <g className="arch-backdrop__center">
          <rect x="520" y="110" width="400" height="500" rx="18" />
        </g>
      </svg>
    </div>
  );
}
