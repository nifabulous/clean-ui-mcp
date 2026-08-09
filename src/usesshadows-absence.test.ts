// src/usesshadows-absence.test.ts
//
// Task 1 of docs/superpowers/specs/2026-08-09-corpus-tag-provenance-design.md:
// `visual.usesShadows` becomes nullable so authoring can express "not known"
// instead of guessing `false`.
//
// The governing corollary these tests enforce: ABSENCE MUST NEVER RENDER AS A
// NEGATIVE CLAIM. A null `usesShadows` surfacing as "No shadows" fabricates
// exactly the claim the change exists to remove — so every reader that turns the
// value into prose is asserted individually, not once.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CorpusEntry } from "./schema.js";
import { entryToDocument } from "./embeddings.js";
import { boolLabel } from "./server-factory.js";
import { claimForField } from "./scripts/verify-corpus.js";
import { sanitizeTaggerPayload } from "./tagger.js";
import { detect as detectShadows } from "./verify/detectors/uses-shadows.js";
import { fixtures } from "./scripts/__fixtures__/corpus-fixtures.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/**
 * A parseable entry to mutate. `fixtures[0].image.path` is not corpus-relative,
 * so the raw fixture fails `CorpusEntry` on the image-path regex — nothing to do
 * with this task, but it would make every schema assertion below pass or fail for
 * the wrong reason.
 */
const makeEntry = (over: Partial<(typeof fixtures)[number]> = {}) => ({
  ...fixtures[0],
  image: { ...fixtures[0].image, path: "images-private/sample-5.png" },
  ...over,
});

describe("schema: usesShadows can express absence", () => {
  it("accepts null", () => {
    const entry = makeEntry({ id: "shadow-null" });
    const parsed = CorpusEntry.safeParse({
      ...entry,
      visual: { ...entry.visual, usesShadows: null },
    });
    expect(parsed.success).toBe(true);
  });

  it("still accepts booleans", () => {
    const entry = makeEntry({ id: "shadow-bool" });
    for (const v of [true, false]) {
      expect(CorpusEntry.safeParse({ ...entry, visual: { ...entry.visual, usesShadows: v } }).success).toBe(true);
    }
  });

  it("rejects a non-boolean, non-null value", () => {
    const entry = makeEntry({ id: "shadow-bad" });
    expect(CorpusEntry.safeParse({ ...entry, visual: { ...entry.visual, usesShadows: "yes" } }).success).toBe(false);
  });
});

describe("embeddings: absence is omitted, never negated", () => {
  const docFor = (usesShadows: boolean | null) => {
    const e = makeEntry({ id: "emb" });
    return entryToDocument({ ...e, visual: { ...e.visual, usesShadows } } as never);
  };

  it("null emits no shadow sentence at all", () => {
    const doc = docFor(null);
    expect(doc).not.toContain("No shadows");
    expect(doc).not.toContain("Uses shadows");
  });

  it("false still emits the negative sentence — it is a real claim", () => {
    expect(docFor(false)).toContain("No shadows; depth via other means.");
  });

  it("true still emits the positive sentence", () => {
    expect(docFor(true)).toContain("Uses shadows for depth.");
  });

  it("omitting the sentence does not leave a double space", () => {
    expect(docFor(null)).not.toMatch(/ {2}/);
  });
});

describe("verifier claim: absence yields no claim", () => {
  it("returns null for a null value rather than 'no shadows are used'", () => {
    expect(claimForField({ visual: { usesShadows: null } }, "visual.usesShadows")).toBeNull();
  });

  it("returns null when visual is missing entirely", () => {
    expect(claimForField({}, "visual.usesShadows")).toBeNull();
  });

  it("still claims for real booleans", () => {
    expect(claimForField({ visual: { usesShadows: true } }, "visual.usesShadows")).toBe("soft shadows are used");
    expect(claimForField({ visual: { usesShadows: false } }, "visual.usesShadows")).toBe("no shadows are used");
  });
});

describe("served rendering: absence is not 'no'", () => {
  it("renders null as an explicit unknown marker", () => {
    expect(boolLabel(null)).toBe("—");
    expect(boolLabel(undefined)).toBe("—");
  });

  it("renders booleans unchanged", () => {
    expect(boolLabel(true)).toBe("yes");
    expect(boolLabel(false)).toBe("no");
  });
});

// Both declarations sit inside module-private schemas (`FullReference` in
// tool-contracts, the visual block in create-ui-spec-contracts), so there is no
// exported handle to parse through. Assert the declaration mechanically; `tsc`
// carries the type proof, and the served-path tests above carry the behaviour.
describe("output contracts accept absence", () => {
  it.each([
    "src/tool-contracts.ts",
    "src/create-ui-spec-contracts.ts",
  ])("%s declares usesShadows nullable", (file) => {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    const decl = src.split("\n").find((l) => l.trimStart().startsWith("usesShadows:"));
    expect(decl).toBeDefined();
    expect(decl).toContain(".nullable()");
  });
});

describe("tagger: an absent model answer stays absent", () => {
  it("does not coalesce a missing usesShadows to false", () => {
    const out = sanitizeTaggerPayload({});
    expect(out.usesShadows).toBeNull();
  });

  it("keeps an explicit false", () => {
    expect(sanitizeTaggerPayload({ usesShadows: false }).usesShadows).toBe(false);
  });

  it("keeps an explicit true", () => {
    expect(sanitizeTaggerPayload({ usesShadows: true }).usesShadows).toBe(true);
  });
});

// The shadow DETECTOR is a reader too, and the one the classification map got
// wrong: it contains `recorded === true`, so a substring guard check passed it
// while its fallthrough branch said "though no shadows are recorded" for a null
// and returned `contradicted`. A contradiction deletes the field's verification
// record, so absence would have revoked trust over a claim never made.
describe("the shadow detector does not contradict an absent claim", () => {
  const entryWith = (usesShadows: boolean | null) => {
    const e = makeEntry({ id: "det" });
    return { ...e, visual: { ...e.visual, usesShadows } };
  };
  // A synthetic 2x2 buffer is enough: the assertion is about which BRANCH the
  // recorded value selects, not about the pixel measurement.
  const ctx = { width: 2, height: 2, raw: Buffer.alloc(2 * 2 * 4, 255), channels: 4 as const };

  it("abstains on a null recorded value instead of contradicting", async () => {
    const r = await detectShadows(entryWith(null) as never, ctx as never);
    expect(r.verdict).toBe("abstain");
    expect(r.reason).not.toContain("though no shadows are recorded");
  });

  it("never emits a contradiction for an absent value, whatever the pixels say", async () => {
    const r = await detectShadows(entryWith(null) as never, ctx as never);
    expect(r.verdict).not.toBe("contradicted");
  });

  it("still reaches a real branch for a recorded boolean", async () => {
    const r = await detectShadows(entryWith(false) as never, ctx as never);
    expect(["pass", "contradicted", "abstain"]).toContain(r.verdict);
    expect(r.reason).not.toContain("nothing to verify");
  });
});

// ── Corollary 4: no stored value changes ────────────────────────────────────
// The migration's byte-neutrality was verified once, directly: HEAD's
// `entryToDocument` and this one were imported side by side in a single vitest
// run and compared across all 787 real entries — 0 differed, so
// `corpus/embeddings.json` needs no rebuild.
//
// That check is NOT pinned as a content hash here on purpose. A sha256 over
// corpus-derived text fails on any unrelated corpus edit, which trains people to
// re-baseline it — and a re-baselined hash proves nothing. (It also disagreed
// between `node dist/` and vitest during development, because `dist/` and `src/`
// were out of sync; the property assertions below cannot drift that way.)
describe("the existing corpus is untouched by a type-only migration", () => {
  // `corpus/entries.json` is NOT tracked (excluded via .git/info/exclude), so it
  // is absent on a clean checkout and in CI. These assertions describe the local
  // private corpus; skipping when it is missing is correct, and is why the
  // guarantees this task actually ships live in the behavioural tests above.
  const corpusPath = join(REPO_ROOT, "corpus/entries.json");
  const hasCorpus = existsSync(corpusPath);
  const maybe = hasCorpus ? it : it.skip;
  const corpus = hasCorpus ? JSON.parse(readFileSync(corpusPath, "utf8")) as unknown : { entries: [] };
  const entries = (Array.isArray(corpus) ? corpus : (corpus as { entries: unknown[] }).entries) as Array<{
    id: string; visual?: { usesShadows?: boolean | null };
  }>;

  maybe("has 787 entries, every one carrying a boolean usesShadows", () => {
    expect(entries.length).toBe(787);
    const nonBoolean = entries.filter((e) => typeof e.visual?.usesShadows !== "boolean").map((e) => e.id);
    expect(nonBoolean).toEqual([]);
  });

  // The invariant the byte-identity check was really about: a boolean still
  // produces exactly one shadow sentence, so no stored entry's embedding text
  // moves. Holds for any corpus, not just today's.
  maybe("every real entry still emits exactly one shadow sentence", () => {
    const wrong = entries.filter((e) => {
      const doc = entryToDocument(e as never);
      const positive = doc.includes("Uses shadows for depth.");
      const negative = doc.includes("No shadows; depth via other means.");
      return positive === negative || positive !== (e.visual?.usesShadows === true);
    }).map((e) => e.id);
    expect(wrong).toEqual([]);
  });

  maybe("and no real entry's document leaves a double space", () => {
    const spaced = entries.filter((e) => / {2}/.test(entryToDocument(e as never))).map((e) => e.id);
    expect(spaced).toEqual([]);
  });
});

// ── AC 6: mechanical enumeration, with each reader CLASSIFIED ────────────────
// Round 2 of review shipped a hand-written consumer list that missed 7 readers
// and named one that needed no change. The lesson: an allowlist entry must not
// be able to stand in for a fix. So `already-safe` entries carry the guard they
// claim, and the test asserts the guard is present in the file.
describe("every production reader of usesShadows is classified", () => {
  type Class = "fix" | "already-safe" | "pass-through" | "authoring" | "display-only" | "declaration" | "fixture";

  const CLASSIFIED: Record<string, Class> = {
    "src/schema.ts": "declaration",

    // Turned absence into a claim before this task; each now has a null branch.
    "src/embeddings.ts": "fix",
    "src/server-factory.ts": "fix",
    "src/scripts/verify-corpus.ts": "fix",
    "src/tagger.ts": "fix",
    "src/tool-contracts.ts": "fix",
    "src/create-ui-spec-contracts.ts": "fix",

    // Raw interpolation — renders "null", not a false claim. Still tidied.
    "src/scripts/review-draft.ts": "display-only",

    // Guarded before this task; the guard is asserted below.
    "src/md3-classifier.ts": "already-safe",
    "src/synthesis/context.ts": "already-safe",
    "src/create-ui-spec-deterministic.ts": "already-safe",
    "src/c3/safe-aggregator.ts": "already-safe",
    "src/create-ui-spec.ts": "already-safe",
    "src/verify/detector-types.ts": "already-safe",
    "src/verify/detectors/uses-shadows.ts": "already-safe",

    // Forwards the value to the critique model without branching on it.
    "src/critique-ui.ts": "pass-through",

    // Field-key strings or record plumbing only — never read the value.
    "src/decision-lab.ts": "already-safe",
    "src/scripts/doctor-helpers.ts": "already-safe",
    "src/verify/detector-registry.ts": "already-safe",
    "src/corpus-trust.ts": "already-safe",

    // AUTHORS the value: the wizard asks a human `askBool("Uses shadows?")` and
    // writes whatever comes back. Not null-safe, and deliberately not called one
    // — Task 2 removes the prompt and clears the field. Classified so this test
    // cannot be read as blessing it.
    "src/scripts/add-entry.ts": "authoring",

    "src/verify/calibration.ts": "fixture",
    "src/__fixtures__/tool-contract-fixtures.ts": "fixture",
    "src/scripts/__fixtures__/corpus-fixtures.ts": "fixture",
    "src/verify/__fixtures__/generate-detector-fixtures.ts": "fixture",
  };

  // Two patterns make a reader null-safe, and the test accepts only these:
  //
  // 1. NULL-AWARE: the usesShadows line itself tests for null (`!= null`,
  //    `typeof`, `?? null`), or references the field only as a key string.
  // 2. EXHAUSTIVE POSITIVE MATCHING: separate `=== true` and `=== false` guards
  //    with no shared else. A null matches neither, so nothing is emitted. This is
  //    what `md3-classifier.ts` and `c3/safe-aggregator.ts` do, and it is genuinely
  //    correct — `if (v === false) push("no shadows")` only fires on a real false.
  //
  // `=== true` ALONE is deliberately NOT accepted. The shadow detector had exactly
  // that plus a negating else, so a substring check passed it while it rendered
  // "though no shadows are recorded" for a null and returned `contradicted`. That
  // is the bug this list previously allowlisted, and the reason the rule is now a
  // predicate rather than a substring set.
  const NULL_AWARE = ["!= null", "!== null", "== null", "=== null", "typeof", "?? null", '?? "'];
  const KEY_ONLY = ['usesShadows"', "'usesShadows'"];

  const isNullSafe = (src: string): boolean => {
    const lines = src.split("\n").filter((l) => l.includes("usesShadows"));
    if (lines.some((l) => [...NULL_AWARE, ...KEY_ONLY].some((g) => l.includes(g)))) return true;
    const exhaustive = src.includes("usesShadows === true") && src.includes("usesShadows === false");
    return exhaustive;
  };

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === "node_modules" ? [] : walk(full);
      return full.endsWith(".ts") ? [full] : [];
    });

  const readers = walk(join(REPO_ROOT, "src"))
    .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.mts"))
    .filter((f) => readFileSync(f, "utf8").includes("usesShadows"))
    .map((f) => relative(REPO_ROOT, f))
    .sort();

  it("classifies every reader — a new one fails this test until classified", () => {
    const unclassified = readers.filter((f) => !(f in CLASSIFIED));
    expect(unclassified).toEqual([]);
  });

  it("lists no reader that no longer exists", () => {
    const stale = Object.keys(CLASSIFIED).filter((f) => !readers.includes(f));
    expect(stale).toEqual([]);
  });

  it("every pass-through reader only forwards the value, never branches on it", () => {
    const branching = readers
      .filter((f) => CLASSIFIED[f] === "pass-through")
      .filter((f) => readFileSync(join(REPO_ROOT, f), "utf8")
        .split("\n")
        .filter((l) => l.includes("usesShadows"))
        .some((l) => l.includes("?") || l.includes("if ")));
    expect(branching).toEqual([]);
  });

  it("every already-safe reader is null-safe by one of the two accepted patterns", () => {
    const unguarded = readers
      .filter((f) => CLASSIFIED[f] === "already-safe")
      .filter((f) => !isNullSafe(readFileSync(join(REPO_ROOT, f), "utf8")));
    expect(unguarded).toEqual([]);
  });

  // The classification map is an INVENTORY: it catches a reader nobody looked at.
  // It is not the safety proof — this assertion pins that every `fix` file has a
  // behavioural test above, so a future edit cannot regress one back to rendering
  // absence as a claim and still pass by staying in the map.
  it("every fixed reader is covered by a behavioural assertion in this file", () => {
    const self = readFileSync(new URL(import.meta.url).pathname, "utf8");
    const COVERED_BY: Record<string, string> = {
      "src/embeddings.ts": "entryToDocument",
      "src/server-factory.ts": "boolLabel",
      "src/scripts/verify-corpus.ts": "claimForField",
      "src/tagger.ts": "sanitizeTaggerPayload",
      "src/tool-contracts.ts": "declares usesShadows nullable",
      "src/create-ui-spec-contracts.ts": "declares usesShadows nullable",
    };
    const fixFiles = readers.filter((f) => CLASSIFIED[f] === "fix");
    expect(Object.keys(COVERED_BY).sort()).toEqual(fixFiles.sort());
    const uncovered = fixFiles.filter((f) => !self.includes(COVERED_BY[f]));
    expect(uncovered).toEqual([]);
  });
});
