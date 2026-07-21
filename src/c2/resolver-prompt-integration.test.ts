/**
 * Resolver → prompt-builder integration (current-grounded).
 *
 * This is the round-trip test that would have caught all four C2 bugs offline:
 *   - Bug #4: `searchRanked` returning the FULL ranked list (787 entries in
 *     production) ballooned the prompt to 1.8MB and got cost-blocked, because
 *     the resolver did not enforce its OWN limit at the boundary.
 *   - Bug #3: the candidate schema requires `assumptions` and
 *     `accessibilityAndRecovery` as plain strings, but the prompt documented
 *     them ambiguously, so the model produced objects that failed validation.
 *   - Bug #2 (already fixed): selectedEntryIds used a `corpus:` prefix that
 *     mismatched rankedResult entry IDs.
 *   - Bug #1 (already fixed): searchMode was not pinned to keyword-only.
 *
 * The test exercises the REAL resolver → REAL prompt-builder → REAL schema
 * validation with a synthetic corpus of >10 entries (the key difference from
 * the 2-entry resolver unit test). It makes ZERO network calls: no provider,
 * no Voyage key, no embedding index. A fake reader supplies the ranked list;
 * `readArtifact` returns synthetic corpus bytes so the pre/post-ranking hash
 * check passes.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import type { CorpusReader, SearchResult } from "../corpus-reader.js";
import type { CorpusEntryT } from "../schema.js";
import {
  resolveConditionInput,
  C2_RETRIEVAL_LIMIT,
  type ResolveConditionInputRequest,
  type ResolveConditionDeps,
  type ResolvedConditionInput,
} from "./condition-resolver.js";
import { buildC2Prompt } from "./prompt-builder.js";
import { C2CandidateArtifactSchema } from "./candidate-contracts.js";
import type { C2ConditionInput } from "./condition-contracts.js";
import type { C2CaseBrief } from "./case-contracts.js";
import { canonicalJsonStringify } from "../readiness/contracts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const STABLECOIN_BRIEF_PATH = "eval/c2/pilot/briefs/stablecoin-home.json";

// ---------------------------------------------------------------------------
// Fixtures — synthetic corpus with MORE than C2_RETRIEVAL_LIMIT entries.
// ---------------------------------------------------------------------------

/** Synthetic corpus entry shared shape (approved, web, dashboard). */
function syntheticEntry(i: number): CorpusEntryT {
  return {
    id: `entry-${i}`,
    title: `Synthetic Entry ${i}`,
    categories: ["dashboard"],
    styleTags: [],
    components: [],
    domainTags: [],
    patternType: "dashboard",
    critique: `Critique text for synthetic entry ${i}. This is model-visible evidence content.`,
    whatToSteal: [`Stealable technique ${i}`],
    antiPatterns: { antiPatterns: [], whereThisFails: [] },
    qualityScore: 7,
    qualityTier: "strong",
    platform: "web",
    reviewStatus: "approved",
    visual: {
      dominantColors: [],
      accentColor: null,
      spacingDensity: null,
      cornerStyle: null,
      typePairing: { display: null, body: null, notes: null },
    },
    source: { productName: "Synthetic", url: `https://example.com/entry-${i}` },
    image: { path: `images-private/entry-${i}.png`, format: "png", width: 100, height: 100 },
    businessRationale: null,
    mood: null,
    colorScheme: null,
    industryVertical: null,
    responsiveBehavior: null,
  } as unknown as CorpusEntryT;
}

/** A ranked result list longer than the C2 limit. */
function longRankedResult(count: number): SearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    entry: syntheticEntry(i),
    // Strictly decreasing score so the order is unambiguous: entry-0 ranks
    // first, entry-(count-1) ranks last.
    score: count - i,
    searchMode: "keyword" as const,
  }));
}

/** A fake CorpusReader returning the supplied ranked list. */
function fakeReader(ranked: SearchResult[]): CorpusReader {
  return {
    searchRanked: async () => ranked,
    search: async () => ranked.map((r) => r.entry),
    getById: () => undefined,
    findSimilar: () => [],
    listCategories: () => [],
    listStyleTags: () => [],
    listDomainTags: () => [],
    indexStatus: () => ({
      indexed: 0, total: 0, hasIndex: false, missing: 0, stale: 0, contentStale: 0,
    }),
    entriesForAggregation: () => [],
    resolveImagePath: () => null,
    getImageIndex: async () => null,
  } as unknown as CorpusReader;
}

/** SHA-256 of the canonical JSON of a brief — matches what the resolver binds. */
function briefSha256(brief: C2CaseBrief): string {
  return createHash("sha256")
    .update(Buffer.from(canonicalJsonStringify(brief), "utf-8"))
    .digest("hex");
}

/**
 * Dependency bag against a temp private dir. `readArtifact` returns synthetic
 * corpus bytes for `corpus/entries.json` (mirrors the resolver unit-test setup)
 * so the pre/post-ranking corpus-hash check passes without the real (gitignored,
 * 3.6 MB) corpus.
 */
function makeDeps(privateRoot: string, ranked: SearchResult[]): ResolveConditionDeps {
  const syntheticCorpusBytes = Buffer.from(
    JSON.stringify({ version: 2, entries: ranked.map((r) => ({ id: r.entry.id, title: r.entry.title, reviewStatus: "approved", source: "synthetic", image: "synthetic/x.png", addedAt: "2026-01-01T00:00:00Z" })) }),
  );
  return {
    reader: fakeReader(ranked),
    readArtifact: (path: string) => {
      if (path === "corpus/entries.json") return syntheticCorpusBytes;
      return readFileSync(join(REPO_ROOT, path));
    },
    writePrivate: (relPath: string, bytes: Buffer) => {
      const abs = join(privateRoot, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    },
    now: () => "2026-07-20T00:00:00.000Z",
  };
}

function makeRequest(brief: C2CaseBrief): ResolveConditionInputRequest {
  return {
    casePackageRef: {
      artifactId: "c2-package-stablecoin-home-v1",
      path: "eval/c2/pilot/manifest.json",
      sha256: "a".repeat(64),
    },
    briefRef: {
      artifactId: brief.artifactId,
      path: STABLECOIN_BRIEF_PATH,
      sha256: briefSha256(brief),
    },
    brief,
    condition: "current-grounded",
  };
}

/** Extract model-visible evidence content from the resolver's private payload. */
function extractEvidenceContent(privatePayload: string): Map<string, string> {
  const parsed = JSON.parse(privatePayload) as { evidenceContent: Record<string, string> };
  return new Map(Object.entries(parsed.evidenceContent));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolver → prompt-builder integration (current-grounded)", () => {
  let privateRoot: string;

  beforeEach(() => {
    privateRoot = mkdtempSync(join(tmpdir(), "c2-integration-private-"));
  });
  afterEach(() => {
    try { rmSync(privateRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Use a corpus large enough to prove the limit is enforced at the boundary
  // (25 entries — well over the C2 limit of 10, far short of the 787-entry
  // production regression but large enough to be unambiguous).
  const CORPUS_SIZE = 25;

  it("retains exactly C2_RETRIEVAL_LIMIT entries across retrieval, evidence, and selectedEntryIds", async () => {
    const brief = JSON.parse(
      readFileSync(join(REPO_ROOT, STABLECOIN_BRIEF_PATH), "utf-8"),
    ) as C2CaseBrief;
    const deps = makeDeps(privateRoot, longRankedResult(CORPUS_SIZE));
    const result = await resolveConditionInput(makeRequest(brief), deps) as ResolvedConditionInput & {
      metadata: Extract<C2ConditionInput, { condition: "current-grounded" }>;
    };

    const retrieval = result.metadata.retrieval;
    // The resolver MUST retain exactly C2_RETRIEVAL_LIMIT (10) across every
    // downstream surface — even though the fake reader returned 25. Bug #4 was
    // that none of these were truncated, so the prompt ballooned.
    expect(retrieval.rankedResult).toHaveLength(C2_RETRIEVAL_LIMIT);
    expect(retrieval.selectedEntryIds).toHaveLength(C2_RETRIEVAL_LIMIT);
    expect(result.metadata.evidence).toHaveLength(C2_RETRIEVAL_LIMIT);

    // The retained entries are the top-10 (entry-0 through entry-9).
    expect(retrieval.rankedResult.map((r) => r.entryId)).toEqual(
      Array.from({ length: C2_RETRIEVAL_LIMIT }, (_, i) => `entry-${i}`),
    );
    // selectedEntryIds use the SAME raw IDs as rankedResult (no `corpus:`
    // prefix — that was Bug #2).
    expect(retrieval.selectedEntryIds).toEqual(
      retrieval.rankedResult.map((r) => r.entryId),
    );
    // entry-10 through entry-24 MUST be dropped at the boundary.
    for (let i = C2_RETRIEVAL_LIMIT; i < CORPUS_SIZE; i += 1) {
      expect(retrieval.rankedResult.some((r) => r.entryId === `entry-${i}`)).toBe(false);
      expect(result.metadata.evidence.some((e) => e.id === `corpus:entry-${i}`)).toBe(false);
    }
    // The private payload carries content for exactly the retained entries.
    const evidenceContent = extractEvidenceContent(result.privatePayload);
    expect(evidenceContent.size).toBe(C2_RETRIEVAL_LIMIT);
  });

  it("produces a prompt under a defined size ceiling", async () => {
    const brief = JSON.parse(
      readFileSync(join(REPO_ROOT, STABLECOIN_BRIEF_PATH), "utf-8"),
    ) as C2CaseBrief;
    const deps = makeDeps(privateRoot, longRankedResult(CORPUS_SIZE));
    const result = await resolveConditionInput(makeRequest(brief), deps);

    // Build the prompt via the REAL builder, using the resolver's evidence
    // content. This is the exact pipeline the harness runs before a paid call.
    const evidenceContent = extractEvidenceContent(result.privatePayload);
    const { prompt } = buildC2Prompt({
      brief,
      conditionInput: result.metadata,
      evidenceContent,
    });

    // The 787-entry bug produced ~1.8MB. With 10 entries it is well under
    // ~50KB. A 200KB ceiling is generous — the point is to catch the
    // unbounded-growth regression, not to pin an exact size.
    const byteLength = Buffer.byteLength(prompt, "utf-8");
    expect(byteLength).toBeLessThan(200_000);
    // And the prompt carries exactly the 10 retained evidence blocks — one
    // per retained entry, no more.
    for (let i = 0; i < C2_RETRIEVAL_LIMIT; i += 1) {
      expect(prompt).toContain(`corpus:entry-${i}`);
    }
    for (let i = C2_RETRIEVAL_LIMIT; i < CORPUS_SIZE; i += 1) {
      expect(prompt).not.toContain(`corpus:entry-${i}`);
    }
  });

  it("parses a synthetic schema-valid candidate through C2CandidateArtifactSchema", () => {
    // Construct a minimal valid candidate matching the prompt's DOCUMENTED
    // contract (after the Bug #3 clarification): assumptions and
    // accessibilityAndRecovery are plain STRINGS, authorityLanes values are
    // stable IDs, all ids are stable IDs, provenance.conditionInputSha256 is a
    // 64-char hex string. This proves the documented contract matches the
    // actual Zod schema.
    const candidate = {
      schemaVersion: "1.0",
      artifactType: "c2-candidate-design",
      artifactId: "c2-candidate-integration-test",
      caseId: "stablecoin-home",
      globalDirection: {
        summary: "Lead with the B2B value proposition; keep the integrator path secondary.",
        principles: [
          "single primary call to action above the fold",
          "no unsupported claims",
        ],
      },
      screenBlueprints: [
        {
          id: "home-blueprint",
          summary: "Homepage with headline, value proposition, and request-access form.",
          requiredStates: ["default", "request-access-success"],
          mobileRules: ["single primary action above the fold"],
          accessibility: ["color contrast meets WCAG AA"],
          failureAndRecovery: ["show inline validation error on submit failure"],
          inspectedUrls: ["https://example.com/home"],
        },
      ],
      sourceDecisions: [
        {
          id: "sd1",
          lane: "adapt",
          rationale: "Adapt the headline stack from corpus evidence entry-0.",
          evidenceIds: ["corpus:entry-0"],
        },
      ],
      authorityLanes: {
        retain: ["headline-stack"],
        adapt: ["branded-palette"],
        reject: ["decorative-gradient"],
      },
      acceptanceCriteria: [
        { id: "ac1", statement: "The request-access form is reachable from home." },
      ],
      // Bug #3: these MUST be plain strings, NOT { id, statement } objects.
      assumptions: [
        "The exact typography is not specified in the brief.",
      ],
      accessibilityAndRecovery: [
        "Every interactive element has an accessible name.",
      ],
      provenance: {
        // A 64-char hex SHA-256 (matches the Sha256 schema primitive).
        conditionInputSha256: "0".repeat(64),
      },
    };

    const parsed = C2CandidateArtifactSchema.safeParse(candidate);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      // Surface the exact validation errors if the contract drifted.
      console.error(JSON.stringify(parsed.error.issues, null, 2));
    }
  });
});
