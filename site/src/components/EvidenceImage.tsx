import { useState, type ReactElement } from "react";

/**
 * Resilient evidence image (spec §9.1: "Failed images render structured
 * wireframe fallbacks and never broken-image icons").
 *
 * The component renders a normal `<img>` until either the `onError` event fires
 * or the host reports it cannot load. On failure it swaps the `<img>` for a
 * structured wireframe placeholder: an outlined frame with a labeled icon and
 * the entry's title. The wireframe is decorative-but-labeled so screen readers
 * announce "screenshot unavailable" instead of "image" / "unlabeled".
 *
 * Intrinsic dimensions (`width`/`height` props) are passed through to the
 * underlying `<img>` so the browser can reserve layout space (spec §12: CLS
 * below 0.1, responsive images with intrinsic width and height).
 */

export interface EvidenceImageProps {
  /** Resolved absolute image URL (safe by construction from the snapshot adapter). */
  readonly src: string;
  /** Accessible description, typically the entry title + product. */
  readonly alt: string;
  /** Intrinsic width in CSS pixels, when known. */
  readonly width?: number;
  /** Intrinsic height in CSS pixels, when known. */
  readonly height?: number;
  /** Optional label shown on the wireframe fallback ("Screenshot unavailable"). */
  readonly unavailableLabel?: string;
  /** Decorative? When true the image is hidden from AT (alt=""). */
  readonly decorative?: boolean;
  /** Extra className applied to the wrapper. */
  readonly className?: string;
}

export function EvidenceImage({
  src,
  alt,
  width,
  height,
  unavailableLabel = "Screenshot unavailable",
  decorative = false,
  className,
}: EvidenceImageProps): ReactElement {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`evidence-image__wireframe ${className ?? ""}`.trim()}
        data-testid="image-wireframe"
        role="img"
        aria-label={decorative ? unavailableLabel : `${alt} (${unavailableLabel.toLowerCase()})`}
        style={dimensionStyle(width, height)}
      >
        <span className="evidence-image__wireframe-icon" aria-hidden="true">
          {/* Minimal inline wireframe glyph — no external asset dependency. */}
          <svg viewBox="0 0 32 32" width="40" height="40" focusable="false">
            <rect
              x="2"
              y="4"
              width="28"
              height="24"
              rx="2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <circle cx="9" cy="11" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M4 24l7-7 5 5 4-4 6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="evidence-image__wireframe-label">{unavailableLabel}</span>
      </div>
    );
  }

  return (
    <img
      className={`evidence-image ${className ?? ""}`.trim()}
      src={src}
      alt={decorative ? "" : alt}
      width={width}
      height={height}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function dimensionStyle(
  width: number | undefined,
  height: number | undefined,
): Record<string, string> {
  const style: Record<string, string> = {};
  if (typeof width === "number") style.width = `${width}px`;
  if (typeof height === "number") style.height = `${height}px`;
  return style;
}
