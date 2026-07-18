import type { ReactElement, ReactNode } from "react";

/**
 * Shared async-state component (spec §9.1: "Every asynchronous surface
 * implements loading, empty, partial-data, offline, success, and error
 * states").
 *
 * The Playground snapshot load and the evidence page both use this to render a
 * single coherent state machine instead of per-page `if/else` ladders. It
 * supports four states: `loading`, `error`, `empty`, and `ready`.
 *
 * The error state surfaces a retry affordance (spec §9.1: "Failed snapshot load
 * offers retry"). The empty state is intentionally minimal here — the rich
 * empty-search surface (active filters + related queries) is owned by the
 * Playground itself, because those actions are search-specific. This component
 * accepts an optional `empty` node so the caller can compose its own empty body.
 */

export type AsyncStateStatus = "loading" | "error" | "empty" | "ready";

export interface AsyncStateProps {
  /** Which state branch to render. */
  readonly status: AsyncStateStatus;
  /** Error message shown when `status === "error"`. */
  readonly errorMessage?: string;
  /** Optional retry handler. When provided, the error state renders a Retry button. */
  readonly onRetry?: () => void;
  /** Optional label for the retry button (defaults to "Retry"). */
  readonly retryLabel?: string;
  /** Optional node rendered when `status === "empty"`. */
  readonly empty?: ReactNode;
  /** Children rendered when `status === "ready"`. */
  readonly children?: ReactNode;
}

/**
 * Render the requested branch. The loading and error branches are announced to
 * assistive technology via `role="status"` so screen readers observe the
 * transition (and so the homepage contract test that waits on a status region
 * keeps working when this component is adopted there).
 */
export function AsyncState({
  status,
  errorMessage,
  onRetry,
  retryLabel = "Retry",
  empty,
  children,
}: AsyncStateProps): ReactElement {
  if (status === "loading") {
    return (
      <div className="async-state async-state--loading" role="status" aria-live="polite">
        <span className="async-state__spinner" aria-hidden="true" />
        <span className="async-state__label">Loading…</span>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="async-state async-state--error" role="status">
        <p className="async-state__message">
          {errorMessage && errorMessage.length > 0
            ? errorMessage
            : "Something went wrong while loading this."}
        </p>
        {onRetry && (
          <button type="button" className="async-state__retry" onClick={onRetry}>
            {retryLabel}
          </button>
        )}
      </div>
    );
  }

  if (status === "empty") {
    return <div className="async-state async-state--empty">{empty}</div>;
  }

  return <>{children}</>;
}
