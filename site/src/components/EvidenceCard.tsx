import type { ReactElement } from "react";
import { Link } from "react-router-dom";
import type { PublicEntry } from "../data/public-entry";
import { EvidenceImage } from "./EvidenceImage";

/**
 * Scan-view evidence card (spec §6.3: "The initial scan must not render full
 * critique paragraphs. Detailed reasoning appears only when the user opens a
 * result").
 *
 * Each card shows: screenshot (or wireframe fallback), title/product, pattern,
 * platform, tier/score, and ONE critique excerpt. The full `entry.critique`
 * body is deliberately NOT rendered here — progressive disclosure is the rule.
 *
 * The "View evidence" link preserves `location.search` so the user returns to
 * the same results after reading the detail page.
 */

export interface EvidenceCardProps {
  readonly entry: PublicEntry;
  /**
   * The originating search string (including the leading `?`) to carry onto the
   * evidence-detail link so the back navigation restores the same results view.
   * Defaults to the empty string (no params preserved).
   */
  readonly returnSearch?: string;
}

export function EvidenceCard({ entry, returnSearch = "" }: EvidenceCardProps): ReactElement {
  // ONE excerpt only. Prefer the curated critiqueExcerpt; fall back to the first
  // sentence of the critique. The full critique paragraph must never render here.
  const excerpt =
    entry.critiqueExcerpt && entry.critiqueExcerpt.trim().length > 0
      ? entry.critiqueExcerpt
      : firstSentence(entry.critique);

  const evidenceHref = `/evidence/${encodeURIComponent(entry.id)}${returnSearch}`;

  const platform = typeof entry.platform === "string" ? entry.platform : null;

  return (
    <article className="evidence-card">
      <Link
        to={evidenceHref}
        className="evidence-card__media"
        aria-label={`View evidence for ${entry.title}`}
      >
        <EvidenceImage
          src={entry.imageUrl}
          alt={`Screenshot of ${entry.title} (${entry.source.productName})`}
          width={480}
          height={360}
          decorative
        />
      </Link>

      <div className="evidence-card__body">
        <div className="evidence-card__head">
          <h3 className="evidence-card__title">{entry.title}</h3>
          <span className="evidence-card__pattern">{entry.patternType}</span>
        </div>

        <p className="evidence-card__source">
          <span className="visually-hidden">Source product: </span>
          {entry.source.productName}
        </p>

        <p className="evidence-card__excerpt">{excerpt}</p>

        <dl className="evidence-card__meta">
          <div className="evidence-card__meta-item">
            <dt>Tier</dt>
            <dd>{entry.qualityTier}</dd>
          </div>
          <div className="evidence-card__meta-item">
            <dt>Score</dt>
            <dd aria-label={`Quality score ${entry.qualityScore} out of 3`}>{entry.qualityScore}/3</dd>
          </div>
          {platform && (
            <div className="evidence-card__meta-item">
              <dt>Platform</dt>
              <dd>{platform}</dd>
            </div>
          )}
        </dl>

        <div className="evidence-card__actions">
          <Link className="evidence-card__link" to={evidenceHref}>
            View evidence
            <span aria-hidden="true"> →</span>
          </Link>
        </div>
      </div>
    </article>
  );
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const match = trimmed.match(/^.+?[.!?](\s|$)/);
  return match ? match[0].trim() : trimmed;
}
