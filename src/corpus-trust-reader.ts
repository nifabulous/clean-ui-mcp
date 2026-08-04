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
 * a CorpusReader and filters every content-bearing method through the SAME
 * `isVerified` predicate the deterministic gate uses. A tool added later is
 * gated because it reads through this reader, not because someone remembered.
 *
 * ONE METHOD IS DELIBERATELY UNGATED: {@link allEntriesForScreening}. The
 * identity screen derives its denied-name set from the whole corpus, and
 * narrowing that set would let an unverified entry's product name stop being
 * screened out of served prose. Trust and identity are independent concerns —
 * the trust gate decides WHETHER a value may be served, the identity screen
 * decides whether a servable string carries a name it must not. Gating the
 * screening corpus would weaken the second in the name of the first.
 */
import type { CorpusReader, ReaderImageIndex } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";
import { isVerified } from "./corpus-trust.js";

export class TrustGatedCorpusReader implements CorpusReader {
  constructor(private readonly inner: CorpusReader) {}

  // ----- Gated: every method whose result becomes served content -------------

  async search(...args: Parameters<CorpusReader["search"]>): ReturnType<CorpusReader["search"]> {
    return (await this.inner.search(...args)).filter((e) => isVerified(e));
  }

  async searchRanked(
    ...args: Parameters<CorpusReader["searchRanked"]>
  ): ReturnType<CorpusReader["searchRanked"]> {
    return (await this.inner.searchRanked(...args)).filter((r) => isVerified(r.entry));
  }

  getById(id: string): CorpusEntryT | undefined {
    const entry = this.inner.getById(id);
    // Refusing by id is the same answer as "no such entry" ON PURPOSE: a distinct
    // "exists but unverified" reply would confirm the entry's existence, which is
    // itself corpus information the caller has not earned.
    return entry !== undefined && isVerified(entry) ? entry : undefined;
  }

  findSimilar(...args: Parameters<CorpusReader["findSimilar"]>): ReturnType<CorpusReader["findSimilar"]> {
    return this.inner.findSimilar(...args).filter((r) => isVerified(r.entry)) as ReturnType<
      CorpusReader["findSimilar"]
    >;
  }

  entriesForAggregation(): readonly CorpusEntryT[] {
    return this.inner.entriesForAggregation().filter((e) => isVerified(e));
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
      if (entry !== undefined && isVerified(entry)) entries[id] = vector;
    }
    return { dimension: index.dimension, entries };
  }

  // ----- Ungated ------------------------------------------------------------

  /**
   * The FULL corpus, for identity screening only (`buildDeniedNames`). Never for
   * serving. See the module docblock for why this one is not gated.
   */
  allEntriesForScreening(): readonly CorpusEntryT[] {
    return this.inner.entriesForAggregation();
  }

  /**
   * How much of the corpus is servable, so a caller can tell "gated" from
   * "genuinely empty" — the same distinction `create_ui_spec` discloses through
   * its `insufficientCorpusEvidence` warning.
   */
  trustPosture(): { verified: number; total: number } {
    const all = this.inner.entriesForAggregation();
    return { verified: all.filter((e) => isVerified(e)).length, total: all.length };
  }

  // These carry no corpus judgment: taxonomy labels and index counters. They are
  // derived from entries, so a label that only unverified entries carry still
  // narrows through `entriesForAggregation` wherever a handler recomputes it.
  listCategories(...a: Parameters<CorpusReader["listCategories"]>): ReturnType<CorpusReader["listCategories"]> {
    return this.inner.listCategories(...a);
  }

  listStyleTags(...a: Parameters<CorpusReader["listStyleTags"]>): ReturnType<CorpusReader["listStyleTags"]> {
    return this.inner.listStyleTags(...a);
  }

  listDomainTags(...a: Parameters<CorpusReader["listDomainTags"]>): ReturnType<CorpusReader["listDomainTags"]> {
    return this.inner.listDomainTags(...a);
  }

  indexStatus(...a: Parameters<CorpusReader["indexStatus"]>): ReturnType<CorpusReader["indexStatus"]> {
    return this.inner.indexStatus(...a);
  }

  resolveImagePath(...a: Parameters<CorpusReader["resolveImagePath"]>): ReturnType<CorpusReader["resolveImagePath"]> {
    return this.inner.resolveImagePath(...a);
  }
}
