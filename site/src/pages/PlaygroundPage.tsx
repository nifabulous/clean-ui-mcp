import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AsyncState } from "../components/AsyncState";
import { EvidenceCard } from "../components/EvidenceCard";
import { SearchFilters } from "../components/SearchFilters";
import { loadPublicSnapshot } from "../data/load-snapshot";
import type { PublicEntry, PublicSnapshot } from "../data/public-entry";
import {
  createSearch,
  parseSearchState,
  serializeSearchState,
  type SearchState,
} from "../search/search";
import "../styles/playground.css";

/**
 * Playground (spec §6.3) — prompt-led corpus search with category/style/domain/
 * platform filters, canonical shareable URLs, responsive result cards, and
 * progressive disclosure.
 *
 * State flow:
 *   - The URL is the source of truth. On mount we read `location.search` via
 *     {@link parseSearchState}. Every state change is serialized back to the URL
 *     with {@link serializeSearchState} and pushed through `useNavigate`, so a
 *     refresh or a shared link restores the exact view.
 *   - The query input is debounced (300ms) so a fast typist does not rebuild
 *     the result set on every keystroke. Filters apply immediately.
 *   - Each card's evidence link carries the current `location.search`, so
 *     navigating to detail and back preserves the results view.
 *
 * Resilience (spec §9.1): a failed snapshot load surfaces a Retry button; an
 * empty result set lists the active filters with remove buttons plus three
 * deterministic related-query suggestions; one unavailable image falls back to a
 * wireframe without blocking the others (handled by {@link EvidenceImage}).
 */

const DEBOUNCE_MS = 300;

const EMPTY_FILTERS: SearchState = {
  query: "",
  categories: [],
  styles: [],
  domains: [],
  platform: null,
};

/** Stable empty entries array used while the snapshot is still loading. */
const EMPTY_ENTRIES: readonly PublicEntry[] = [];

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: PublicSnapshot };

export function PlaygroundPage(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();

  // URL-derived canonical state — the single source of truth.
  const [urlState, setUrlState] = useState<SearchState>(() =>
    parseSearchState(location.search),
  );

  // Debounced query: typed immediately into a local field, applied to the
  // search after DEBOUNCE_MS of inactivity. Filters apply with no debounce.
  const [pendingQuery, setPendingQuery] = useState<string>(urlState.query);
  const debounceRef = useRef<number | null>(null);

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [loadNonce, setLoadNonce] = useState(0);

  // Keep urlState in sync when the browser back/forward changes location.search
  // (e.g. popstate). Comparing the serialized form avoids loops.
  useEffect(() => {
    const next = parseSearchState(location.search);
    if (serializeSearchState(next) !== serializeSearchState(urlState)) {
      setUrlState(next);
      setPendingQuery(next.query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const loadSnapshot = useCallback(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    loadPublicSnapshot()
      .then((snapshot) => {
        if (!cancelled) setLoad({ status: "ready", snapshot });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setLoad({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cancel = loadSnapshot();
    return cancel;
  }, [loadNonce, loadSnapshot]);

  // Push state changes back to the URL (canonical, shareable). We replace rather
  // than push for filter-only changes so the history does not fill with one
  // entry per keystroke; we DO push on explicit filter changes so back works.
  const commitState = useCallback(
    (next: SearchState, replace: boolean): void => {
      const serialized = serializeSearchState(next);
      const target = serialized.length === 0 ? "/playground" : `/playground?${serialized}`;
      // Avoid pushing when nothing changed.
      const currentSearch = serializeSearchState(urlState);
      if (serialized === currentSearch) {
        // Still update local state if the caller mutated a copy.
        setUrlState(next);
        return;
      }
      setUrlState(next);
      navigate(target, { replace });
    },
    [navigate, urlState],
  );

  // Debounce the query input: apply after DEBOUNCE_MS of quiet.
  useEffect(() => {
    if (pendingQuery === urlState.query) return;
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    const handle = window.setTimeout(() => {
      debounceRef.current = null;
      commitState({ ...urlState, query: pendingQuery }, true);
    }, DEBOUNCE_MS);
    debounceRef.current = handle;
    return () => {
      window.clearTimeout(handle);
      debounceRef.current = null;
    };
  }, [pendingQuery, urlState, commitState]);

  const handleFiltersChange = useCallback(
    (next: SearchState) => {
      // Determine whether the change was a query-text edit or a filter change.
      // Query edits are debounced (update pendingQuery; the debounce effect will
      // commit). Filter changes commit immediately so a select feels responsive.
      const filtersChanged =
        !sameStringList(next.categories, urlState.categories) ||
        !sameStringList(next.styles, urlState.styles) ||
        !sameStringList(next.domains, urlState.domains) ||
        (next.platform ?? null) !== (urlState.platform ?? null);

      setPendingQuery(next.query);
      if (filtersChanged) {
        // Carry the *current* (debounced) query so an in-flight query edit does
        // not get discarded — the user's typed text stays in the input either way.
        commitState({ ...next, query: urlState.query }, true);
      }
      // Query-only change: the debounce effect commits `pendingQuery` after the
      // quiet window. No commit here.
    },
    [urlState, commitState],
  );

  const removeFilter = useCallback(
    (kind: "categories" | "styles" | "domains" | "platform", value: string | null) => {
      // Construct the next state immutably — SearchState fields are readonly.
      const next: SearchState =
        kind === "platform"
          ? { ...urlState, platform: null }
          : {
              ...urlState,
              [kind]: urlState[kind].filter((entry) => entry !== value),
            };
      setPendingQuery(next.query);
      commitState(next, true);
    },
    [urlState, commitState],
  );

  const applySuggestion = useCallback(
    (query: string) => {
      const next: SearchState = { ...EMPTY_FILTERS, query };
      setPendingQuery(query);
      commitState(next, false);
    },
    [commitState],
  );

  // All hooks MUST run before any early return (Rules of Hooks). Memoize the
  // search index over the snapshot entries; while loading, index an empty list.
  const snapshotEntries =
    load.status === "ready" ? load.snapshot.entries : EMPTY_ENTRIES;
  const search = useMemo(() => createSearch(snapshotEntries), [snapshotEntries]);

  if (load.status === "loading" || load.status === "error") {
    return (
      <div className="playground">
        <header className="playground__header">
          <p className="playground__eyebrow">Playground</p>
          <h1>Search the critiqued corpus</h1>
          <p className="playground__lede">
            Prompt-led search over real product interfaces. Each result carries a decision, the
            evidence behind it, what to steal, and what to avoid.
          </p>
          <div className="playground__header-actions">
            <Link className="playground__install-link" to="/install">
              Install
            </Link>
          </div>
        </header>
        <AsyncState
          status={load.status}
          errorMessage={load.status === "error" ? load.message : undefined}
          onRetry={load.status === "error" ? () => setLoadNonce((n) => n + 1) : undefined}
        />
      </div>
    );
  }

  const snapshot = load.snapshot;
  const results = search.search(urlState.query, urlState);
  const count = results.length;

  const returnSearch = location.search;

  return (
    <div className="playground">
      <header className="playground__header">
        <p className="playground__eyebrow">Playground</p>
        <h1>Search the critiqued corpus</h1>
        <p className="playground__lede">
          Prompt-led search over real product interfaces. Each result carries a decision, the
          evidence behind it, what to steal, and what to avoid.
        </p>
        <div className="playground__header-actions">
          <Link className="playground__install-link" to="/install">
            Install
          </Link>
        </div>
      </header>

      <SearchFilters
        state={{ ...urlState, query: pendingQuery }}
        categories={snapshot.categories}
        styles={snapshot.styleTags}
        domains={snapshotDomains(snapshot)}
        platforms={snapshotPlatforms(snapshot)}
        onChange={handleFiltersChange}
      />

      <section className="playground__results" aria-labelledby="playground-results-title">
        <h2 id="playground-results-title" className="visually-hidden">
          Playground results
        </h2>
        {/* Result count announced via a live region (spec §10: announced
            asynchronous search results). */}
        <p className="playground__count" role="status" aria-live="polite">
          {count} {count === 1 ? "result" : "results"}
          {urlState.query.trim().length > 0 ? ` for “${urlState.query}”` : " across the corpus"}
        </p>

        {count === 0 ? (
          <EmptyResults
            state={urlState}
            onRemoveFilter={removeFilter}
            onSuggestion={applySuggestion}
            categories={snapshot.categories}
          />
        ) : (
          <ul className="playground__grid">
            {results.map((result) => (
              <li key={result.id} className="playground__grid-item">
                <EvidenceCard entry={result.entry} returnSearch={returnSearch} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Empty-results surface (spec §9.1: "Empty search results identify restrictive
 * filters and offer related queries").
 *
 * Lists every active filter as a removable chip and offers three deterministic
 * related-query suggestions derived from the corpus's category list (so they are
 * always real, never fabricated).
 */
function EmptyResults({
  state,
  onRemoveFilter,
  onSuggestion,
  categories,
}: {
  readonly state: SearchState;
  readonly onRemoveFilter: (
    kind: "categories" | "styles" | "domains" | "platform",
    value: string | null,
  ) => void;
  readonly onSuggestion: (query: string) => void;
  readonly categories: readonly string[];
}): ReactElement {
  const activeFilters: Array<{ kind: "categories" | "styles" | "domains" | "platform"; value: string }> = [];
  for (const value of state.categories) activeFilters.push({ kind: "categories", value });
  for (const value of state.styles) activeFilters.push({ kind: "styles", value });
  for (const value of state.domains) activeFilters.push({ kind: "domains", value });
  if (state.platform) activeFilters.push({ kind: "platform", value: state.platform });

  // Three deterministic related queries. Derived from the corpus categories so
  // they always refer to real patterns; fall back to canonical defaults if the
  // corpus is unusually small.
  const suggestions = pickSuggestions(categories, state);

  return (
    <div className="playground__empty">
      <h3 className="playground__empty-title">No results</h3>
      <p className="playground__empty-lede">
        Your current filters don&rsquo;t match any entry. Try removing a filter or running a broader
        query.
      </p>

      {activeFilters.length > 0 && (
        <ul className="playground__active-filters" role="list" aria-label="Active filters">
          {activeFilters.map((filter) => (
            <li key={`${filter.kind}:${filter.value}`} className="playground__active-filter">
              <span className="playground__active-filter-label">
                <span className="visually-hidden">{filter.kind}: </span>
                {filter.value}
              </span>
              <button
                type="button"
                className="playground__active-filter-remove"
                aria-label={`Remove ${filter.kind} filter ${filter.value}`}
                onClick={() => onRemoveFilter(filter.kind, filter.value)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="playground__suggestions">
        <p className="playground__suggestions-label">Try one of these:</p>
        <ul className="playground__suggestion-list" role="list" aria-label="Related queries">
          {suggestions.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                className="playground__suggestion"
                onClick={() => onSuggestion(suggestion)}
              >
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function pickSuggestions(categories: readonly string[], state: SearchState): string[] {
  // Derive three deterministic suggestions from the corpus categories, excluding
  // any category already active as a filter. The order is stable so the test
  // assertion on "three deterministic" suggestions holds.
  const used = new Set(state.categories.map((c) => c.toLowerCase()));
  const fromCategories = categories
    .filter((c) => !used.has(c.toLowerCase()))
    .slice(0, 3)
    .map((c) => c);
  const fallback = ["pricing", "dashboard", "navigation"];
  const merged: string[] = [];
  for (const value of [...fromCategories, ...fallback]) {
    if (merged.includes(value)) continue;
    merged.push(value);
    if (merged.length === 3) break;
  }
  return merged;
}

function snapshotDomains(snapshot: PublicSnapshot): string[] {
  const hosts = new Set<string>();
  for (const entry of snapshot.entries) {
    const host = hostnameOf(entry.source.url);
    if (host) hosts.add(host);
  }
  return Array.from(hosts).sort();
}

function snapshotPlatforms(snapshot: PublicSnapshot): string[] {
  const set = new Set<string>();
  for (const entry of snapshot.entries) {
    if (typeof entry.platform === "string" && entry.platform.length > 0) {
      set.add(entry.platform);
    }
  }
  return Array.from(set).sort();
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
