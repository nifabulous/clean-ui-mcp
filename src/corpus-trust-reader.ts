/**
 * corpus-trust-reader.ts — the trust gate for every corpus-reading MCP tool.
 *
 * `create_ui_spec` gates itself (see `create-ui-spec-deterministic.ts`), but a
 * review found the same corpus fabrications flowing out of its siblings
 * untouched: `get_stealable_techniques` served an entry's `whatToSteal` prose
 * verbatim — describing a left navigation rail on a 1179x2556 portrait phone
 * screenshot — alongside `source.product` and `source.id`, the exact identity
 * every other served path is built to withhold. `recommend_ui_direction` and
 * `get_color_palette` invented hex values outright. The spec's invariant ("an
 * unverifiable assertion is never served") held for 1 tool of 12.
 *
 * This decorator closes that by construction rather than by discipline: it wraps
 * a CorpusReader and filters every content-bearing method through the per-field
 * `isVerified` predicate, against the CORE fields the tool hard-gates on
 * (enrichment is projected at the render boundary). An entry is returned only
 * when EVERY core field in the set is verified — the conservative reading, and
 * the one that cannot over-serve. The core set is declared at wiring time in
 * `createServer`, so a tool added later is gated by construction, not because
 * someone remembered.
 *
 * ONE CONSUMER DELIBERATELY DOES NOT READ THROUGH THIS CLASS: `create_ui_spec`
 * keeps the raw reader (`server-factory.ts`). It gates itself, and it needs the
 * CORPUS-WIDE entry list to build the identity screen's denied-name set —
 * narrowing that set would let an unverified entry's product name stop being
 * screened out of served prose. Trust and identity are independent concerns: the
 * trust gate decides WHETHER a value may be served, the identity screen decides
 * whether a servable string carries a name it must not. Gating the screening
 * corpus would weaken the second in the name of the first.
 */
import type { CorpusReader, ReaderImageIndex } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";
import { isVerified } from "./corpus-trust.js";

export class TrustGatedCorpusReader implements CorpusReader {
  private readonly _core: readonly string[];
  private readonly _enrichment: readonly string[];

  constructor(
    private readonly inner: CorpusReader,
    /** The exact keys of the fields this tool hard-gates on (wiring-time declaration). */
    core: readonly string[],
    /** The exact keys of the fields this tool renders only when verified; omitted+disclosed otherwise. */
    enrichment: readonly string[] = [],
  ) {
    // Double-wrapping would make `trustPosture()` report verified === total (the
    // inner gate already filtered), so every honest "0 of 787" message would
    // silently revert to "No X found for those filters". Refuse it outright rather
    // than degrade quietly.
    if (inner instanceof TrustGatedCorpusReader) {
      throw new Error(
        "TrustGatedCorpusReader is already gating this reader; double-wrapping "
        + "would make trustPosture() report everything as verified.",
      );
    }
    // An empty core would make `core.every(...)` vacuously true and un-gate
    // the whole corpus — the exact failure this class exists to prevent.
    if (core.length === 0) {
      throw new Error(
        "TrustGatedCorpusReader requires at least one core field; an empty core "
        + "set would let every entry pass (every() over [] is true).",
      );
    }
    this._core = core;
    this._enrichment = enrichment;
  }

  /** The fields an entry must verify to appear in the tool at all. */
  get core(): readonly string[] {
    return this._core;
  }

  /** The fields rendered only when verified for the entry; omitted+disclosed otherwise. */
  get enrichment(): readonly string[] {
    return this._enrichment;
  }

  private passes(entry: CorpusEntryT): boolean {
    return this._core.every((field) => isVerified(entry, field));
  }

  // ----- Gated: every method whose result becomes served content -------------

  async search(...args: Parameters<CorpusReader["search"]>): ReturnType<CorpusReader["search"]> {
    return (await this.inner.search(...args)).filter((e) => this.passes(e));
  }

  async searchRanked(
    ...args: Parameters<CorpusReader["searchRanked"]>
  ): ReturnType<CorpusReader["searchRanked"]> {
    return (await this.inner.searchRanked(...args)).filter((r) => this.passes(r.entry));
  }

  getById(id: string): CorpusEntryT | undefined {
    const entry = this.inner.getById(id);
    // Refusing by id is the same answer as "no such entry" ON PURPOSE: a distinct
    // "exists but unverified" reply would confirm the entry's existence, which is
    // itself corpus information the caller has not earned.
    return entry !== undefined && this.passes(entry) ? entry : undefined;
  }

  findSimilar(...args: Parameters<CorpusReader["findSimilar"]>): ReturnType<CorpusReader["findSimilar"]> {
    return this.inner.findSimilar(...args).filter((r) => this.passes(r.entry)) as ReturnType<
      CorpusReader["findSimilar"]
    >;
  }

  entriesForAggregation(): readonly CorpusEntryT[] {
    return this.inner.entriesForAggregation().filter((e) => this.passes(e));
  }

  /**
   * The image-embedding index, narrowed to verified entries. `critique_ui` ranks
   * visual similarity through this, so leaving it whole would let an unverified
   * entry become cited critique evidence by the vector route even though every
   * text route refuses it — the gate would hold for prose and leak through pixels.
   */
  async getImageIndex(providerModel?: string): Promise<ReaderImageIndex | null> {
    const index = await this.inner.getImageIndex(providerModel);
    if (index === null) return null;
    const entries: ReaderImageIndex["entries"] = {};
    for (const [id, vector] of Object.entries(index.entries)) {
      const entry = this.inner.getById(id);
      if (entry !== undefined && this.passes(entry)) entries[id] = vector;
    }
    return { dimension: index.dimension, entries };
  }

  // ----- Ungated ------------------------------------------------------------

  /**
   * True when an entry EXISTS but the gate refused it — as opposed to not
   * existing at all.
   *
   * Callers need this to avoid asserting a falsehood. `getById` deliberately
   * answers `undefined` for a refused entry, and four tools turned that into
   * "No entry found with id X" about an entry that is right there. Withholding
   * an entry is correct; claiming it does not exist is a different statement and
   * an untrue one.
   */
  refusedForTrust(id: string): boolean {
    const entry = this.inner.getById(id);
    return entry !== undefined && !this.passes(entry);
  }

  /**
   * How much of the corpus is servable, so a caller can tell "gated" from
   * "genuinely empty" — the same distinction `create_ui_spec` discloses through
   * its `insufficientCorpusEvidence` warning.
   */
  trustPosture(): { verified: number; total: number } {
    const all = this.inner.entriesForAggregation();
    return { verified: all.filter((e) => this.passes(e)).length, total: all.length };
  }

  // Taxonomy labels ARE gated, like every content-bearing method: the list tools
  // are registered with this reader, so a pass-through would let a label that
  // only unverified entries carry seed filters. Recompute each vocabulary from
  // the VERIFIED entries only. (Index counters below are ungated — they count
  // entries, they do not expose them.)
  listCategories(...a: Parameters<CorpusReader["listCategories"]>): ReturnType<CorpusReader["listCategories"]> {
    void a;
    return [...new Set(
      this.inner.entriesForAggregation()
        .filter((e) => this.passes(e) && isVerified(e, "categories"))
        .flatMap((e) => e.categories ?? []),
    )];
  }

  listStyleTags(...a: Parameters<CorpusReader["listStyleTags"]>): ReturnType<CorpusReader["listStyleTags"]> {
    void a;
    return [...new Set(
      this.inner.entriesForAggregation()
        .filter((e) => this.passes(e) && isVerified(e, "styleTags"))
        .flatMap((e) => e.styleTags ?? []),
    )];
  }

  listDomainTags(...a: Parameters<CorpusReader["listDomainTags"]>): ReturnType<CorpusReader["listDomainTags"]> {
    void a;
    return [...new Set(
      this.inner.entriesForAggregation()
        .filter((e) => this.passes(e) && isVerified(e, "domainTags"))
        .flatMap((e) => e.domainTags ?? []),
    )];
  }

  indexStatus(...a: Parameters<CorpusReader["indexStatus"]>): ReturnType<CorpusReader["indexStatus"]> {
    return this.inner.indexStatus(...a);
  }

  resolveImagePath(...a: Parameters<CorpusReader["resolveImagePath"]>): ReturnType<CorpusReader["resolveImagePath"]> {
    return this.inner.resolveImagePath(...a);
  }
}
