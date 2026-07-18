import type { ReactElement } from "react";
import type { SearchState } from "../search/search";

/**
 * Native form-control filters for the Playground (spec §6.3: "Category, style,
 * domain, and platform filters" + spec §10 accessibility: native controls with
 * visible labels).
 *
 * Every control has a visible `<label>` (not placeholder-only) so screen readers
 * and keyboard users get a stable, programmatic name. Selecting a filter calls
 * back with the next {@link SearchState}; the Playground owns canonical URL
 * replacement so this component stays free of router concerns.
 *
 * Category, style, and platform are single-select dropdowns driven by the
 * snapshot's curated lists. The query is a labelled search input. (Domain
 * filtering is exercised by the URL-state tests; we expose it through the same
 * single-select pattern so users can narrow by source host too.)
 */

export interface SearchFiltersProps {
  /** Current search state. */
  readonly state: SearchState;
  /** Snapshot-derived filter options. */
  readonly categories: readonly string[];
  readonly styles: readonly string[];
  readonly domains: readonly string[];
  /** Platforms present in the corpus (may be empty when no entry carries one). */
  readonly platforms: readonly string[];
  /** Invoked with the next state whenever any control changes. */
  readonly onChange: (next: SearchState) => void;
}

const PLATFORM_OPTIONS = ["web", "ios", "android"] as const;

export function SearchFilters({
  state,
  categories,
  styles,
  domains,
  platforms,
  onChange,
}: SearchFiltersProps): ReactElement {
  const handleQuery = (value: string): void => {
    onChange({ ...state, query: value });
  };

  // Single-select category: replacing the array (rather than toggling) keeps the
  // scan view simple and predictable. An empty string is the "no filter" sentinel.
  const categoryValue = state.categories[0] ?? "";
  const handleCategory = (value: string): void => {
    onChange({ ...state, categories: value ? [value] : [] });
  };

  const styleValue = state.styles[0] ?? "";
  const handleStyle = (value: string): void => {
    onChange({ ...state, styles: value ? [value] : [] });
  };

  const domainValue = state.domains[0] ?? "";
  const handleDomain = (value: string): void => {
    onChange({ ...state, domains: value ? [value] : [] });
  };

  const platformValue = state.platform ?? "";
  const handlePlatform = (value: string): void => {
    onChange({ ...state, platform: value ? value : null });
  };

  // The platform dropdown shows every option that appears in the corpus, plus
  // the canonical fallback list when the corpus carries no platform tags yet.
  const platformOptions = uniquePlatforms(platforms);

  return (
    <div className="search-filters" role="group" aria-label="Search filters">
      <div className="search-filters__field search-filters__field--query">
        <label className="search-filters__label" htmlFor="playground-query">
          Ask the corpus
        </label>
        <input
          id="playground-query"
          className="search-filters__input"
          type="search"
          autoComplete="off"
          placeholder="e.g. pricing page hierarchy"
          value={state.query}
          onChange={(event) => handleQuery(event.target.value)}
        />
      </div>

      <div className="search-filters__field">
        <label className="search-filters__label" htmlFor="playground-category">
          Category
        </label>
        <select
          id="playground-category"
          className="search-filters__select"
          value={categoryValue}
          onChange={(event) => handleCategory(event.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
      </div>

      <div className="search-filters__field">
        <label className="search-filters__label" htmlFor="playground-style">
          Style
        </label>
        <select
          id="playground-style"
          className="search-filters__select"
          value={styleValue}
          onChange={(event) => handleStyle(event.target.value)}
        >
          <option value="">All styles</option>
          {styles.map((style) => (
            <option key={style} value={style}>
              {style}
            </option>
          ))}
        </select>
      </div>

      <div className="search-filters__field">
        <label className="search-filters__label" htmlFor="playground-domain">
          Domain
        </label>
        <select
          id="playground-domain"
          className="search-filters__select"
          value={domainValue}
          onChange={(event) => handleDomain(event.target.value)}
        >
          <option value="">All domains</option>
          {domains.map((domain) => (
            <option key={domain} value={domain}>
              {domain}
            </option>
          ))}
        </select>
      </div>

      <div className="search-filters__field">
        <label className="search-filters__label" htmlFor="playground-platform">
          Platform
        </label>
        <select
          id="playground-platform"
          className="search-filters__select"
          value={platformValue}
          onChange={(event) => handlePlatform(event.target.value)}
        >
          <option value="">All platforms</option>
          {platformOptions.map((platform) => (
            <option key={platform} value={platform}>
              {platform}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function uniquePlatforms(fromCorpus: readonly string[]): string[] {
  const set = new Set<string>();
  for (const fallback of PLATFORM_OPTIONS) set.add(fallback);
  for (const value of fromCorpus) {
    if (typeof value === "string" && value.length > 0) set.add(value);
  }
  return Array.from(set);
}
