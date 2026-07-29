import { useMemo, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import type { PublicEntry, PublicSnapshot } from "../data/public-entry";
import { createSearch, type SearchFilters } from "../search/search";

/**
 * Real product preview shown in the hero (spec §6.2 first viewport).
 *
 * Unlike a static screenshot, this is the live corpus search/results UI: it
 * builds a {@link createSearch} index over a few representative snapshot entries
 * and lets the visitor type a query. It demonstrates the actual product
 * behavior — search relevance, the evidence-summary card, and provenance —
 * rather than a fabricated image.
 *
 * The preview is intentionally compact: a query input, a live result count, and
 * a few result cards each showing title/product, pattern, quality, one critique
 * excerpt, and a link to the full corpus-search surface at `/browse`. Full
 * critique and filters live there. (`/playground` is the C3 composer — C3 Task 6
 * moved search to `/browse`, so this preview must not link to the composer.)
 */
export interface ProductPreviewProps {
  /** A few representative parsed entries from the snapshot. */
  readonly snapshot: PublicSnapshot;
}

const NO_FILTERS: SearchFilters = {
  categories: [],
  styles: [],
  domains: [],
  platform: null,
};

/** Representative starter queries the visitor can click to see real results. */
const STARTER_QUERIES = ["pricing", "dashboard", "navigation"] as const;

export function ProductPreview({ snapshot }: ProductPreviewProps): ReactElement {
  // Build the search index once per snapshot. Memoized so re-typing does not
  // rebuild the MiniSearch index.
  const search = useMemo(() => createSearch(snapshot.entries), [snapshot]);
  const [query, setQuery] = useState<string>("");

  const results = useMemo(() => search.search(query, NO_FILTERS).slice(0, 3), [search, query]);
  const count = search.search(query, NO_FILTERS).length;

  return (
    <div className="product-preview" data-testid="product-preview">
      <div className="product-preview__chrome" aria-hidden="true">
        <span className="product-preview__dot" />
        <span className="product-preview__dot" />
        <span className="product-preview__dot" />
        <span className="product-preview__chrome-label">clean-ui playground</span>
      </div>

      <div className="product-preview__bar">
        <label className="product-preview__label" htmlFor="product-preview-query">
          Ask the corpus
        </label>
        <input
          id="product-preview-query"
          className="product-preview__input"
          type="search"
          autoComplete="off"
          placeholder="e.g. pricing page hierarchy"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="product-preview__chips" role="group" aria-label="Starter queries">
        {STARTER_QUERIES.map((starter) => (
          <button
            key={starter}
            type="button"
            className="product-preview__chip"
            aria-pressed={query === starter}
            onClick={() => setQuery(starter)}
          >
            {starter}
          </button>
        ))}
      </div>

      <p className="product-preview__count" aria-live="polite">
        {count} {count === 1 ? "result" : "results"}
        {query ? ` for “${query}”` : " across the corpus"}
      </p>

      <ul className="product-preview__results">
        {results.map((result) => (
          <li key={result.id}>
            <PreviewResultCard entry={result.entry} />
          </li>
        ))}
      </ul>

      <div className="product-preview__footnote">
        {/* /browse, NOT /playground. `/playground` became the C3 create_ui_spec
            composer (Task 6) and has no search UI, so sending a visitor there
            from the corpus preview would silently drop them onto a generator. */}
        <Link className="product-preview__more" to="/browse">
          Browse the full corpus →
        </Link>
      </div>
    </div>
  );
}

/** A compact evidence card for the preview (full cards are Task 5). */
function PreviewResultCard({ entry }: { readonly entry: PublicEntry }): ReactElement {
  const excerpt = entry.critiqueExcerpt ?? entry.critique.split(". ")[0];
  return (
    <article className="preview-card">
      <img
        className="preview-card__image"
        src={entry.imageUrl}
        alt=""
        loading="lazy"
        decoding="async"
        width={96}
        height={72}
      />
      <div className="preview-card__body">
        <div className="preview-card__head">
          <span className="preview-card__title">{entry.title}</span>
          <span className="preview-card__pattern">{entry.patternType}</span>
        </div>
        <p className="preview-card__excerpt">{excerpt}</p>
        <dl className="preview-card__meta">
          <div>
            <dt>Tier</dt>
            <dd>{entry.qualityTier}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{entry.source.productName}</dd>
          </div>
        </dl>
      </div>
    </article>
  );
}
