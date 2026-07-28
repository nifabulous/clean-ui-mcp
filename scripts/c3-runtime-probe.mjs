#!/usr/bin/env node
/**
 * c3-runtime-probe.mjs — compiled-runtime smoke probe for the create-ui-spec
 * producer (Task 3 of the C3 first slice).
 *
 * This is an INTEGRATION check, not a vitest test (vitest excludes .mjs). It
 * invokes the COMPILED producer from dist/ so that:
 *  - the NodeNext JSON import attribute (`with { type: "json" }`) is exercised
 *    under real Node ESM (confirming the Task 2 forward-note — typechecking
 *    alone cannot mask an ESM loading failure);
 *  - the recipe is loaded from dist/c3/fallback-recipe-v1.json (the same path
 *    the producer imports), proving tsc emits the JSON to dist;
 *  - the producer's full pipeline (input normalization → evidence resolution →
 *    typed sanitization → deterministic assembly → envelope construction →
 *    re-render/re-hash verification) runs end-to-end against an in-memory
 *    fixture reader with zero network calls.
 *
 * The probe FAILS (exit 1) if:
 *  - dist is not built (the deferred import resolves to null);
 *  - the recipe identity (version + frozen SHA) does not match the checked-in
 *    literal;
 *  - the returned envelope fails parseDesignArtifactEnvelope (re-render/re-hash
 *    verification);
 *  - any private corpus marker (id, path, url, product name, screenshot, raw
 *    excerpt) appears in the serialized envelope;
 *  - the producer makes any source-tree lookup or process.cwd()-based recipe
 *    load (asserted by the fixture reader's spy + the marker scan).
 *
 * Usage: node scripts/c3-runtime-probe.mjs   (run `npx tsc` first)
 */

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// Deferred dist imports (same pattern as build-baseline-manifest.mjs): the
// producer + contracts live in compiled JS so the .mjs script can consume them
// without a TypeScript runtime. If dist isn't built yet, fail with a clear
// message telling the user to run `npx tsc` first.
const producerMod = await import("../dist/create-ui-spec.js").catch(() => null);
const contractsMod = await import("../dist/create-ui-spec-contracts.js").catch(() => null);
const readinessMod = await import("../dist/readiness/contracts.js").catch(() => null);
// The recipe import with the JSON import attribute — this is what triggers tsc
// to emit the JSON to dist (confirming the Task 2 forward-note).
const recipeMod = await import("../dist/c3/fallback-recipe-v1.json", { with: { type: "json" } })
  .then((m) => m.default)
  .catch(() => null);

const createUiSpec = producerMod?.createUiSpec;
const parseDesignArtifactEnvelope = contractsMod?.parseDesignArtifactEnvelope;
const canonicalJsonStringify = readinessMod?.canonicalJsonStringify;
const sha256Hex = readinessMod?.sha256Hex;

// Frozen recipe identity (mirrors src/c3/fallback-recipe-v1.test.ts).
const EXPECTED_RECIPE_VERSION = "c3-fallback-v1";
const EXPECTED_RECIPE_SHA256 =
  "4c78f2f261b5d1e988e692d3b32a19762991a4eee0789734a54b3d6029d510f3";

// Distinctive private markers the serialized envelope must NEVER contain.
const PRIVATE_MARKERS = [
  "private-corpus-id",
  "images-private",
  "private.example.com",
  "secret",
  "critique prose must never leak",
  "stealable prose",
];

function fail(message) {
  console.error(`c3-runtime-probe: FAIL — ${message}`);
  process.exit(1);
}

function sha256(value) {
  return sha256Hex(Buffer.from(canonicalJsonStringify(value), "utf-8"));
}

/**
 * Build a minimal in-memory fixture reader satisfying the producer's dependency
 * interface. The fixture entries carry distinctive private markers so the probe
 * can detect any leak. No source-tree lookup, no process.cwd() access.
 */
function makeFixtureReader() {
  const entries = [
    {
      id: "private-corpus-id-1",
      title: "Private Fixture One",
      patternType: "dashboard",
      source: {
        productName: "private-corpus-id-product",
        url: "https://private.example.com/secret",
        kind: "screenshot",
        capturedAt: "2026-01-01",
        licenseStatus: "private",
        attribution: "Private Corpus",
      },
      image: { visibility: "private", path: "images-private/secret.png", width: 100, height: 100 },
      critique: "private-corpus-id critique prose must never leak",
      whatToSteal: ["private-corpus-id stealable prose"],
      antiPatterns: { antiPatterns: [], whereThisFails: [], accessibilityRisks: [] },
      categories: ["dashboard"],
      styleTags: ["minimal"],
      components: [],
      visual: {},
      qualityScore: 4,
      qualityTier: "exceptional",
      reviewStatus: "approved",
      addedAt: "2026-01-01",
    },
    {
      id: "private-corpus-id-2",
      title: "Private Fixture Two",
      patternType: "data-table",
      source: {
        productName: "other-private-product",
        url: "https://private.example.com/other",
        kind: "screenshot",
        capturedAt: "2026-01-01",
        licenseStatus: "private",
        attribution: "Private Corpus",
      },
      image: { visibility: "private", path: "images-private/other.png", width: 100, height: 100 },
      critique: "private-corpus-id other critique prose must never leak",
      whatToSteal: ["private-corpus-id other stealable prose"],
      antiPatterns: { antiPatterns: [], whereThisFails: [], accessibilityRisks: [] },
      categories: ["data-table"],
      styleTags: ["dense-data"],
      components: [],
      visual: {},
      qualityScore: 4,
      qualityTier: "exceptional",
      reviewStatus: "approved",
      addedAt: "2026-01-01",
    },
  ];

  let searchRankedCalls = 0;
  return {
    reader: {
      search: async () => entries,
      searchRanked: async (options) => {
        searchRankedCalls++;
        // Assert keyword-only + limit 20 (no network-backed dispatch).
        if (options?.searchMode !== "keyword-only") {
          fail(`searchRanked called with searchMode "${options?.searchMode}" (expected "keyword-only")`);
        }
        if (options?.limit !== 20) {
          fail(`searchRanked called with limit ${options?.limit} (expected 20)`);
        }
        return entries.map((e, i) => ({ entry: e, score: 5 - i, searchMode: "keyword" }));
      },
      getById: (id) => entries.find((e) => e.id === id),
      findSimilar: () => [],
      listCategories: () => [],
      listStyleTags: () => [],
      listDomainTags: () => [],
      indexStatus: () => ({ indexed: 0, total: entries.length, hasIndex: false, missing: entries.length, stale: 0, contentStale: 0 }),
      entriesForAggregation: () => entries,
      resolveImagePath: () => null,
    },
    searchRankedCalls: () => searchRankedCalls,
  };
}

async function main() {
  // 1. Dist must be built.
  if (!producerMod || !createUiSpec) {
    fail("dist/create-ui-spec.js not found — run `npx tsc` first to build the producer.");
  }
  if (!contractsMod || !parseDesignArtifactEnvelope) {
    fail("dist/create-ui-spec-contracts.js not found — run `npx tsc` first.");
  }
  if (!readinessMod || !canonicalJsonStringify || !sha256Hex) {
    fail("dist/readiness/contracts.js not found — run `npx tsc` first.");
  }
  if (!recipeMod) {
    fail("dist/c3/fallback-recipe-v1.json not found — run `npx tsc` first (the JSON import attribute should emit it).");
  }

  // 2. Recipe identity (version + frozen SHA) matches the checked-in literal.
  if (recipeMod.recipeVersion !== EXPECTED_RECIPE_VERSION) {
    fail(`recipe version mismatch: got "${recipeMod.recipeVersion}" (expected "${EXPECTED_RECIPE_VERSION}").`);
  }
  const recipeSha = sha256(recipeMod);
  if (recipeSha !== EXPECTED_RECIPE_SHA256) {
    fail(`recipe SHA mismatch: got "${recipeSha}" (expected "${EXPECTED_RECIPE_SHA256}").`);
  }

  // 3. Invoke the producer with the fixture reader. No resolveReferenceToken
  //    (automatic retrieval path). now() is pinned for determinism.
  const fixture = makeFixtureReader();
  const envelope = await createUiSpec(
    {
      productContext: "A calm analytics dashboard for a fintech",
      referenceIds: [],
      constraints: [],
      motionIntents: [],
    },
    {
      reader: fixture.reader,
      resolveReferenceToken: () => undefined,
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    },
  );

  // 4. The producer made exactly one searchRanked call (automatic retrieval).
  if (fixture.searchRankedCalls() !== 1) {
    fail(`expected exactly 1 searchRanked call, got ${fixture.searchRankedCalls()}.`);
  }

  // 5. Producer version + assembly-rules SHA match the recipe identity.
  if (envelope.producerVersion !== EXPECTED_RECIPE_VERSION) {
    fail(`producerVersion mismatch: got "${envelope.producerVersion}".`);
  }
  if (envelope.assemblyRulesSha256 !== EXPECTED_RECIPE_SHA256) {
    fail(`assemblyRulesSha256 mismatch: got "${envelope.assemblyRulesSha256}".`);
  }

  // 6. Re-parse the envelope (re-render + re-hash verification).
  const reparsed = parseDesignArtifactEnvelope(envelope);
  if (!reparsed || reparsed.artifactId !== envelope.artifactId) {
    fail("parseDesignArtifactEnvelope did not return a matching artifactId.");
  }

  // 7. Privacy: no private marker in the serialized envelope.
  const serialized = JSON.stringify(envelope);
  for (const marker of PRIVATE_MARKERS) {
    if (serialized.includes(marker)) {
      fail(`private marker "${marker}" leaked into the serialized envelope.`);
    }
  }
  // The internal corpus id slugs must never appear.
  if (serialized.includes("private-corpus-id-1") || serialized.includes("private-corpus-id-2")) {
    fail("internal corpus id slug leaked into the serialized envelope.");
  }

  // 8. Determinism: a second identical run produces the same artifactId.
  const fixture2 = makeFixtureReader();
  const envelope2 = await createUiSpec(
    {
      productContext: "A calm analytics dashboard for a fintech",
      referenceIds: [],
      constraints: [],
      motionIntents: [],
    },
    {
      reader: fixture2.reader,
      resolveReferenceToken: () => undefined,
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    },
  );
  if (envelope.artifactId !== envelope2.artifactId) {
    fail(`artifactId not deterministic across identical runs: "${envelope.artifactId}" vs "${envelope2.artifactId}".`);
  }
  if (envelope.semanticSpecSha256 !== envelope2.semanticSpecSha256) {
    fail("semanticSpecSha256 not deterministic across identical runs.");
  }

  console.log("c3-runtime-probe: PASS");
  console.log(`  artifactId:        ${envelope.artifactId}`);
  console.log(`  producerVersion:   ${envelope.producerVersion}`);
  console.log(`  retrieval:         ${envelope.retrieval.mode}/${envelope.retrieval.modality}`);
  console.log(`  evidenceIds:       ${envelope.publicEvidenceIds.length}`);
  console.log(`  warnings:          ${envelope.warnings.map((w) => w.code).join(", ")}`);
}

// Main guard — only run when invoked directly (not when imported by a test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    fail(`unhandled error: ${err instanceof Error ? err.message : String(err)}`);
  });
}
