import { useEffect, useState, type ReactElement } from "react";
import { Link, useParams, useLocation } from "react-router-dom";
import { AsyncState } from "../components/AsyncState";
import { CopyAction } from "../components/CopyAction";
import { EvidenceImage } from "../components/EvidenceImage";
import { loadPublicSnapshot } from "../data/load-snapshot";
import type { PublicEntry, PublicSnapshot } from "../data/public-entry";
import "../styles/evidence.css";

/**
 * Evidence detail page (spec §6.4).
 *
 * Reads `:entryId` from the route, finds the entry in the snapshot, and renders:
 *   - A large authentic screenshot with intrinsic dimensions and a wireframe
 *     fallback on failure (handled by {@link EvidenceImage}).
 *   - Product, source, pattern, quality, and provenance.
 *   - Structured Decision, Evidence, Steal, Avoid, Accessibility, and
 *     Provenance sections — the full critique renders here (unlike the scan view).
 *   - A copyable agent-ready prompt.
 *   - A "Back to results" link that returns to `/playground?<same params>` so
 *     the originating search state is preserved.
 *
 * Unknown entry ids render a defined not-found state (never a blank page).
 */

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshot: PublicSnapshot };

export function EvidencePage(): ReactElement {
  const params = useParams<{ entryId: string }>();
  const location = useLocation();
  const entryId = params.entryId ?? "";

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [loadNonce, setLoadNonce] = useState(0);

  useEffect(() => {
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
  }, [loadNonce]);

  if (load.status !== "ready") {
    return (
      <div className="evidence">
        <BackToResults search={location.search} />
        <AsyncState
          status={load.status}
          errorMessage={load.status === "error" ? load.message : undefined}
          onRetry={load.status === "error" ? () => setLoadNonce((n) => n + 1) : undefined}
        />
      </div>
    );
  }

  const snapshot = load.snapshot;
  const entry = findEntry(snapshot, entryId);

  if (!entry) {
    return (
      <div className="evidence">
        <BackToResults search={location.search} />
        <section className="evidence__not-found">
          <h1>Evidence not found</h1>
          <p>
            No entry in the corpus matches <code>{entryId}</code>. It may have been removed or
            unpublished. Return to the Playground to search the live corpus.
          </p>
          <Link className="evidence__not-found-link" to={backTarget(location.search)}>
            Back to results
          </Link>
        </section>
      </div>
    );
  }

  return <EvidenceDetail entry={entry} search={location.search} />;
}

function EvidenceDetail({
  entry,
  search,
}: {
  readonly entry: PublicEntry;
  readonly search: string;
}): ReactElement {
  const agentPrompt = buildAgentPrompt(entry);
  const backHref = backTarget(search);
  const platform = typeof entry.platform === "string" ? entry.platform : null;
  // source.url is optional in the tracked snapshot (some captures have no
  // recorded origin link). Render the provenance link only when it is present.
  const sourceUrl = typeof entry.source.url === "string" ? entry.source.url : null;
  const sourceHost = sourceUrl ? hostnameOf(sourceUrl) : "";

  return (
    <div className="evidence">
      <BackToResultsLink href={backHref} />

      <header className="evidence__header">
        <p className="evidence__eyebrow">{entry.patternType}</p>
        <h1>{entry.title}</h1>
        <p className="evidence__lede">
          {entry.source.productName}
          {sourceHost ? ` — ${sourceHost}` : ""}
        </p>

        <dl className="evidence__meta">
          <div className="evidence__meta-item">
            <dt>Quality tier</dt>
            <dd>{entry.qualityTier}</dd>
          </div>
          <div className="evidence__meta-item">
            <dt>Quality score</dt>
            <dd>{entry.qualityScore}/3</dd>
          </div>
          {platform && (
            <div className="evidence__meta-item">
              <dt>Platform</dt>
              <dd>{platform}</dd>
            </div>
          )}
          <div className="evidence__meta-item">
            <dt>Categories</dt>
            <dd>{entry.categories.join(", ")}</dd>
          </div>
          <div className="evidence__meta-item">
            <dt>Styles</dt>
            <dd>{entry.styleTags.join(", ")}</dd>
          </div>
        </dl>
      </header>

      <figure className="evidence__screenshot">
        <EvidenceImage
          src={entry.imageUrl}
          alt={`Screenshot of ${entry.title} (${entry.source.productName})`}
          width={1280}
          height={800}
        />
        <figcaption>
          Authentic screenshot captured from {entry.source.productName}.
        </figcaption>
      </figure>

      <div className="evidence__sections">
        <section className="evidence__section" aria-labelledby="evidence-decision">
          <h2 id="evidence-decision">Decision</h2>
          <p>{entry.critiqueExcerpt ?? firstSentence(entry.critique)}</p>
        </section>

        <section className="evidence__section" aria-labelledby="evidence-evidence">
          <h2 id="evidence-evidence">Evidence</h2>
          {/* The full critique body renders only here (progressive disclosure). */}
          <p>{entry.critique}</p>
        </section>

        <section className="evidence__section" aria-labelledby="evidence-steal">
          <h2 id="evidence-steal">Steal</h2>
          <ul className="evidence__list">
            {entry.whatToSteal.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="evidence__section" aria-labelledby="evidence-avoid">
          <h2 id="evidence-avoid">Avoid</h2>
          <ul className="evidence__list">
            {entry.antiPatterns.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="evidence__section" aria-labelledby="evidence-accessibility">
          <h2 id="evidence-accessibility">Accessibility</h2>
          <ul className="evidence__list">
            {summarizeAccessibility(entry).map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>

        <section className="evidence__section" aria-labelledby="evidence-provenance">
          <h2 id="evidence-provenance">Provenance</h2>
          <p>
            Captured from <strong>{entry.source.productName}</strong>
            {sourceUrl ? (
              <>
                .{" "}
                <a href={sourceUrl} rel="noreferrer noopener" target="_blank">
                  {sourceHost || sourceUrl}
                </a>
              </>
            ) : (
              "."
            )}
          </p>
        </section>
      </div>

      <section className="evidence__agent" aria-labelledby="evidence-agent">
        <h2 id="evidence-agent">Agent-ready prompt</h2>
        <p>
          Copy this context into your agent or MCP call to ground it in this specific decision.
        </p>
        {/* The prompt text is exposed in a selectable region so the test (and
            screen readers) can read the exact value that will be copied. */}
        <pre className="evidence__agent-prompt" data-testid="agent-prompt">
          {agentPrompt}
        </pre>
        <div className="evidence__agent-copy">
          <CopyAction value={agentPrompt} label="Copy agent prompt" />
        </div>
      </section>

      <div className="evidence__foot">
        <BackToResultsLink href={backHref} />
      </div>
    </div>
  );
}

function BackToResults({ search }: { readonly search: string }): ReactElement {
  return <div className="evidence__back"><BackToResultsLink href={backTarget(search)} /></div>;
}

function BackToResultsLink({ href }: { readonly href: string }): ReactElement {
  return (
    <Link className="evidence__back-link" to={href}>
      <span aria-hidden="true">← </span>Back to results
    </Link>
  );
}

function findEntry(snapshot: PublicSnapshot, id: string): PublicEntry | null {
  for (const entry of snapshot.entries) {
    if (entry.id === id) return entry;
  }
  return null;
}

/** Build the playground back-target URL, preserving the originating search. */
function backTarget(search: string): string {
  if (!search || search === "?") return "/playground";
  // Already includes the leading "?".
  if (search.startsWith("?")) return `/playground${search}`;
  return `/playground?${search}`;
}

function buildAgentPrompt(entry: PublicEntry): string {
  const lines: string[] = [];
  lines.push(`Pattern: ${entry.patternType}`);
  lines.push(`Title: ${entry.title}`);
  lines.push(`Source: ${entry.source.productName}`);
  if (typeof entry.platform === "string") lines.push(`Platform: ${entry.platform}`);
  lines.push(`Quality: ${entry.qualityTier} (${entry.qualityScore}/3)`);
  if (entry.categories.length > 0) lines.push(`Categories: ${entry.categories.join(", ")}`);
  if (entry.styleTags.length > 0) lines.push(`Styles: ${entry.styleTags.join(", ")}`);
  lines.push("");
  lines.push("Decision:");
  lines.push(entry.critiqueExcerpt ?? firstSentence(entry.critique));
  lines.push("");
  lines.push("Steal:");
  for (const item of entry.whatToSteal) lines.push(`- ${item}`);
  lines.push("");
  lines.push("Avoid:");
  for (const item of entry.antiPatterns) lines.push(`- ${item}`);
  return lines.join("\n");
}

/**
 * Accessibility summary derived from the entry's structured fields. The public
 * snapshot does not carry a dedicated accessibility array today, so we surface
 * the contrast-relevant color roles and any quality cautions deterministically.
 * This never invents metrics — it only restates fields the entry already has.
 */
function summarizeAccessibility(entry: PublicEntry): string[] {
  const out: string[] = [];
  const roles = entry.colorRoles;
  if (roles) {
    if (roles.canvas && roles.ink) {
      out.push(`Canvas ${roles.canvas} against ink ${roles.ink} defines the base contrast pair.`);
    }
    if (roles.accent) {
      out.push(`Accent ${roles.accent} is reserved for emphasis, not body color.`);
    }
  }
  if (entry.qualityTier !== "exceptional") {
    out.push(`Quality tier ${entry.qualityTier}: verify contrast and target sizes before reuse.`);
  }
  if (entry.dominantColors.length > 0) {
    out.push(`Dominant palette: ${entry.dominantColors.join(", ")}.`);
  }
  if (out.length === 0) {
    out.push("No accessibility metadata recorded for this entry.");
  }
  return out;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const match = trimmed.match(/^.+?[.!?](\s|$)/);
  return match ? match[0].trim() : trimmed;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
