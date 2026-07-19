import { useEffect, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { ArchitecturalBackdrop } from "../components/ArchitecturalBackdrop";
import { ProductPreview } from "../components/ProductPreview";
import { loadPublicSnapshot } from "../data/load-snapshot";
import type { PublicSnapshot } from "../data/public-entry";
import { repoMeta } from "../data/repo-meta";
import "../styles/home.css";

/**
 * Proof-led homepage (spec §6.2).
 *
 * The hero promises design judgment grounded in real interfaces, then proves it
 * with a live corpus preview and quantified proof derived from the snapshot
 * (NOT fabricated adoption metrics). Subsequent sections each communicate one
 * message. See {@link renderSection} for the canonical 8-section order.
 *
 * Metrics contract: the proof count and the corpus size shown in the preview are
 * read from {@link PublicSnapshot.count} / {@link PublicSnapshot.entries}. The
 * repository metadata (license, MCP tool count) is sourced from verifiable repo
 * facts via {@link repoMeta}. No adoption/customer numbers appear anywhere.
 */

type LoadState =
  | { status: "loading" }
  | { status: "ready"; snapshot: PublicSnapshot }
  | { status: "error"; message: string };

export function HomePage(): ReactElement {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    loadPublicSnapshot()
      .then((snapshot) => {
        if (!cancelled) setState({ status: "ready", snapshot });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="home">
      {/* 1. Hero: promise + support + primary/secondary actions + product preview + proof */}
      <section className="home__hero" aria-labelledby="home-hero-title">
        <ArchitecturalBackdrop />
        <div className="home__hero-inner">
          <p className="home__hero-eyebrow">clean-ui-mcp</p>
          <h1 id="home-hero-title">
            Design judgment for AI agents, grounded in <em>real interfaces</em>.
          </h1>
          <p className="home__hero-lede">
            Instead of scrolling screenshot galleries, your agent searches a curated, critiqued
            corpus and gets back a decision, the evidence behind it, what to steal, what to avoid,
            and where it came from.
          </p>
          <div className="home__actions">
            <Link className="home__action home__action--primary" to="/playground">
              Try Playground
            </Link>
            <Link className="home__action home__action--secondary" to="/install">
              Install MCP
            </Link>
          </div>
        </div>

        {/* Product preview uses the real corpus search/results UI. It renders
            after the primary actions in DOM order, so the actions stay dominant. */}
        <div className="home__preview">
          <SnapshotPreview state={state} />
        </div>
      </section>

      {/* Quantified proof derived from the snapshot (never fabricated adoption). */}
      <section className="home__proof" aria-labelledby="home-proof-title">
        <h2 id="home-proof-title" className="visually-hidden">
          Proof from the corpus
        </h2>
        <ProofRegion state={state} />
      </section>

      {/* 2. Why screenshot galleries are insufficient */}
      <section className="home__section" aria-labelledby="home-galleries-title">
        <h2 id="home-galleries-title">
          Screenshot galleries <em>show</em> — they don&rsquo;t <em>decide</em>.
        </h2>
        <p>
          A gallery hands your agent pixels. It still has to guess why a layout works, which part to
          copy, and which choices to avoid. clean-ui ships the judgment behind each example: a
          written decision, the specific evidence that supports it, and the anti-patterns to refuse.
        </p>
      </section>

      {/* 3. The evidence model */}
      <section className="home__section" aria-labelledby="home-evidence-title">
        <h2 id="home-evidence-title">The evidence model</h2>
        <p>
          Every entry in the corpus is structured the same way, so an agent can reason over it
          instead of paraphrasing an image.
        </p>
        <div className="home__evidence-model">
          <article className="home__evidence-card">
            <h3>Decision</h3>
            <p>The recommendation the agent should act on, stated plainly.</p>
          </article>
          <article className="home__evidence-card">
            <h3>Evidence</h3>
            <p>The specific observations from the real interface that justify the decision.</p>
          </article>
          <article className="home__evidence-card">
            <h3>Steal</h3>
            <p>Concrete, copyable techniques worth carrying into your own UI.</p>
          </article>
          <article className="home__evidence-card">
            <h3>Avoid</h3>
            <p>The anti-patterns to refuse, so your agent doesn&rsquo;t repeat them.</p>
          </article>
          <article className="home__evidence-card">
            <h3>Provenance</h3>
            <p>The source product and URL each decision traces back to.</p>
          </article>
        </div>
      </section>

      {/* 4. How clean-ui connects to an agent */}
      <section className="home__section" aria-labelledby="home-connect-title">
        <h2 id="home-connect-title">How it connects to your agent</h2>
        <p>
          clean-ui is a Model Context Protocol server. Your agent calls it like any other tool — no
          browser, no scraping, no screenshot pipeline on your side.
        </p>
        <ol className="home__steps">
          <li>
            <h3>Install</h3>
            <p>
              <code>npm i clean-ui-mcp</code>, then build once with <code>npm run build</code>.
            </p>
          </li>
          <li>
            <h3>Register</h3>
            <p>
              Point your MCP client at <code>dist/server.js</code>. See the{" "}
              <Link to="/install">install guide</Link> for the exact config.
            </p>
          </li>
          <li>
            <h3>Search</h3>
            <p>
              Your agent calls <code>search_ui_examples</code> and reads structured results — a
              decision, evidence, steal/avoid, and provenance.
            </p>
          </li>
        </ol>
      </section>

      {/* 5. Representative use cases */}
      <section className="home__section home__section--wide" aria-labelledby="home-usecases-title">
        <h2 id="home-usecases-title">Who it&rsquo;s for</h2>
        <div className="home__use-cases">
          <article className="home__use-case">
            <h3>AI &amp; frontend developers</h3>
            <ul>
              <li>Give an agent design judgment instead of generic &ldquo;make it modern&rdquo; prompts.</li>
              <li>Ship a defensible layout decision with cited evidence.</li>
              <li>Copy paste-ready techniques, not vague inspiration.</li>
            </ul>
          </article>
          <article className="home__use-case">
            <h3>Design &amp; product teams</h3>
            <ul>
              <li>Reference critiqued examples when reviewing a proposal.</li>
              <li>Surface anti-patterns before a build starts.</li>
              <li>Share a canonical, searchable library instead of scattered screenshots.</li>
            </ul>
          </article>
        </div>
      </section>

      {/* 6. Open-source and reliability proof */}
      <section className="home__section" aria-labelledby="home-reliability-title">
        <h2 id="home-reliability-title">Open-source and reliable by design</h2>
        <div className="home__reliability">
          <article className="home__reliability-item">
            <h3>{repoMeta.license} licensed</h3>
            <p>
              The server and corpus tooling are open-source under the {repoMeta.license} license.
            </p>
          </article>
          <article className="home__reliability-item">
            <h3>{repoMeta.mcpToolCount} MCP tools</h3>
            <p>
              Search, similar examples, anti-patterns, color palettes, and stealable techniques —
              each a documented tool your agent can call.
            </p>
          </article>
          <article className="home__reliability-item">
            <h3>Publication-safe corpus</h3>
            <p>
              The public site reads only the tracked, validated snapshot. No private assets ever
              reach a generated image tag.
            </p>
          </article>
        </div>
      </section>

      {/* 7. FAQ */}
      <section className="home__section" aria-labelledby="home-faq-title">
        <h2 id="home-faq-title">FAQ</h2>
        <div className="home__faq">
          <article className="home__faq-item">
            <h3>Do I need API keys to use the MCP server?</h3>
            <p>
              No. With no keys at all, the server starts and serves keyword search over the shipped
              corpus. Vision keys enable Auto-fill; a Voyage key enables semantic vector search.
            </p>
          </article>
          <article className="home__faq-item">
            <h3>Does the Playground send my queries anywhere?</h3>
            <p>
              No. The public Playground searches the tracked snapshot entirely in your browser. The
              MCP server runs locally over stdio when you install it.
            </p>
          </article>
          <article className="home__faq-item">
            <h3>Where do the examples come from?</h3>
            <p>
              Each entry is captured from a real, public product interface and carries provenance —
              the product name and source URL — so every decision is traceable.
            </p>
          </article>
        </div>
      </section>

      {/* 8. Final Playground/install CTA */}
      <section className="home__cta" aria-labelledby="home-cta-title">
        <h2 id="home-cta-title">Give your agent design judgment</h2>
        <p>
          Try the Playground now, or install the MCP server and let your agent call clean-ui
          directly.
        </p>
        <div className="home__cta-actions">
          <Link className="home__action home__action--primary" to="/playground">
            Try Playground
          </Link>
          <Link className="home__action home__action--secondary" to="/install">
            Install MCP
          </Link>
        </div>
      </section>
    </div>
  );
}

/** Live corpus preview that adapts to the snapshot load state. */
function SnapshotPreview({ state }: { readonly state: LoadState }): ReactElement {
  if (state.status === "loading") {
    return (
      <p className="home__state" role="status" aria-live="polite">
        Loading the live corpus preview…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="home__state" role="status">
        The corpus preview could not load.{" "}
        <Link to="/playground">Open the Playground</Link> to search instead.
      </p>
    );
  }
  return <ProductPreview snapshot={state.snapshot} />;
}

/**
 * Proof region. The headline corpus count is read directly from
 * {@link PublicSnapshot.count} so it is always derived from the publication-safe
 * snapshot — never a hard-coded adoption figure. A live region announces the
 * ready state so the test (and screen readers) can observe the resolved count.
 */
function ProofRegion({ state }: { readonly state: LoadState }): ReactElement {
  if (state.status === "loading") {
    return (
      <div className="home__proof-grid" data-testid="proof">
        <div className="home__proof-item">
          <span className="home__proof-value">—</span>
          <span className="home__proof-label">Loading the corpus…</span>
        </div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="home__proof-grid" data-testid="proof">
        <div className="home__proof-item">
          <span className="home__proof-value">—</span>
          <span className="home__proof-label">Proof unavailable. Reload to retry.</span>
        </div>
      </div>
    );
  }
  const { snapshot } = state;
  const categoryCount = snapshot.categories.length;
  const styleCount = snapshot.styleTags.length;
  return (
    <div data-testid="proof">
      {/* Announce readiness + the resolved count. role=status makes the resolved
          value observable to assistive tech and to the contract test. */}
      <span className="visually-hidden" role="status">
        Corpus ready: {snapshot.count} critiqued interfaces.
      </span>
      <div className="home__proof-grid">
        <div className="home__proof-item">
          <span className="home__proof-value">{snapshot.count}</span>
          <span className="home__proof-label">critiqued interfaces in the corpus</span>
        </div>
        <div className="home__proof-item">
          <span className="home__proof-value">{categoryCount}</span>
          <span className="home__proof-label">pattern categories to filter by</span>
        </div>
        <div className="home__proof-item">
          <span className="home__proof-value">{styleCount}</span>
          <span className="home__proof-label">style tags to narrow results</span>
        </div>
        <div className="home__proof-item">
          <span className="home__proof-value">{repoMeta.mcpToolCount}</span>
          <span className="home__proof-label">MCP tools the agent can call</span>
        </div>
      </div>
      <p className="home__proof-note">
        Counts are derived from the publication-safe snapshot. No adoption metrics are shown.
      </p>
    </div>
  );
}
