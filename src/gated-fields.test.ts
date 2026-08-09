// src/gated-fields.test.ts
//
// Task 2 of docs/superpowers/specs/2026-08-09-corpus-tag-provenance-design.md:
// authoring writes ABSENCE on gated fields instead of a guess, and no entry
// arrives already claiming to be verified.
//
// Two derivations, no hand-maintained tables — gate a field in future and both
// the strip set and its clear mode follow automatically. The tests below pin
// that property, not a snapshot of today's four fields.
import { describe, expect, it } from "vitest";
import { CorpusEntry } from "./schema.js";
import { GATED_FIELDS, TIER_BY_FIELD, tierForField, gatedFieldsFrom } from "./corpus-trust.js";
import { persistEntries, setCorpusRootForTesting, writableLoadedCorpus } from "./persistence.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import {
  clearModeFor,
  stripGatedFields,
  assertNoIncomingVerification,
  gatedFieldsCanExpressAbsence,
  preserveGatedFields,
} from "./gated-fields.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { prepareNewEntryPayload } from "./scripts/ui-server.js";
import { fixtures } from "./scripts/__fixtures__/corpus-fixtures.js";

const makeEntry = (over: Record<string, unknown> = {}) => ({
  ...fixtures[0],
  image: { ...fixtures[0].image, path: "images-private/sample-5.png" },
  ...over,
});

describe("GATED_FIELDS derives from the tier table", () => {
  // Deliberately NOT `expected = Object.entries(TIER_BY_FIELD).filter(...)` — that
  // recomputes the implementation and would pass against a hardcoded set. These
  // exercise the derivation with tables it does not own.
  it("selects gated entries and nothing else", () => {
    const set = gatedFieldsFrom({
      "a.gated": "gated",
      "b.soft": "soft",
      "c.mechanical": "mechanical",
      "d.gated": "gated",
      "e.prose": "prose",
    });
    expect([...set].sort()).toEqual(["a.gated", "d.gated"]);
  });

  it("is empty when nothing is gated", () => {
    expect([...gatedFieldsFrom({ x: "soft", y: "mechanical" })]).toEqual([]);
  });

  it("is what the production constant is built from", () => {
    expect(GATED_FIELDS).toEqual(gatedFieldsFrom(TIER_BY_FIELD));
  });

  it("today that is the four the abstain diagnosis closed", () => {
    expect([...GATED_FIELDS].sort()).toEqual([
      "responsiveBehavior",
      "visual.accentColor",
      "visual.colorRoles",
      "visual.usesShadows",
    ]);
  });

  // tierForField defaults UNCLASSIFIED fields to "gated". Deriving the strip set
  // from it would clear every field not yet in the table — including fields the
  // tagger is supposed to author.
  it("does NOT include an unclassified field, even though tierForField calls it gated", () => {
    expect(tierForField("visual.somethingNobodyClassified")).toBe("gated");
    expect(GATED_FIELDS.has("visual.somethingNobodyClassified")).toBe(false);
  });

  it("excludes fields that are verifiable", () => {
    for (const f of ["visual.usesBorders", "visual.cornerStyle", "components", "critique"]) {
      expect(GATED_FIELDS.has(f)).toBe(false);
    }
  });
});

describe("clearModeFor derives the clear mode from the schema", () => {
  it("nullable fields clear to null", () => {
    expect(clearModeFor("visual.accentColor")).toBe("null");
    expect(clearModeFor("visual.usesShadows")).toBe("null"); // Task 1 made this possible
  });

  it("optional-only fields clear by omission", () => {
    expect(clearModeFor("visual.colorRoles")).toBe("omit");
    expect(clearModeFor("responsiveBehavior")).toBe("omit");
  });

  it("refuses a field that can express neither", () => {
    // visual.typePairing is a required object: not nullable, not optional. If it
    // is ever gated, this is the failure that must fire — loudly, at init —
    // rather than an entry being written that cannot parse.
    expect(() => clearModeFor("visual.typePairing")).toThrow(/cannot express absence/i);
  });
});

describe("the init guard", () => {
  it("passes for the current gated set", () => {
    expect(() => gatedFieldsCanExpressAbsence()).not.toThrow();
  });

  it("names the offending field when a gated field cannot express absence", () => {
    expect(() => gatedFieldsCanExpressAbsence(new Set(["visual.typePairing"])))
      .toThrow(/visual\.typePairing/);
  });
});

describe("stripGatedFields", () => {
  const authored = () => makeEntry({
    visual: {
      ...fixtures[0].visual,
      usesShadows: true,
      accentColor: "#3d1ae0",
      colorRoles: { canvas: "#ffffff", surface: "#f5f5f5", ink: "#111111", muted: null, accent: "#3d1ae0" },
    },
    responsiveBehavior: "responsive",
  });

  it("clears nullable gated fields to null", () => {
    const out = stripGatedFields(authored() as never);
    expect(out.visual.usesShadows).toBeNull();
    expect(out.visual.accentColor).toBeNull();
  });

  it("removes optional-only gated fields entirely", () => {
    const out = stripGatedFields(authored() as never) as Record<string, unknown>;
    expect("colorRoles" in (out.visual as object)).toBe(false);
    expect("responsiveBehavior" in out).toBe(false);
  });

  it("leaves every non-gated field untouched", () => {
    const before = authored();
    const out = stripGatedFields(before as never);
    expect(out.visual.usesBorders).toBe(before.visual.usesBorders);
    expect(out.visual.cornerStyle).toBe(before.visual.cornerStyle);
    expect(out.critique).toBe(before.critique);
    expect(out.categories).toEqual(before.categories);
  });

  it("returns an entry that still parses", () => {
    const parsed = CorpusEntry.safeParse(stripGatedFields(authored() as never));
    expect(parsed.success).toBe(true);
  });

  it("does not mutate its input", () => {
    const before = authored();
    stripGatedFields(before as never);
    expect(before.visual.usesShadows).toBe(true);
    expect(before.visual.accentColor).toBe("#3d1ae0");
  });

  it("is idempotent", () => {
    const once = stripGatedFields(authored() as never);
    expect(stripGatedFields(once)).toEqual(once);
  });
});

describe("no entry arrives pre-verified", () => {
  it("refuses an incoming provenance.verification, naming the keys", () => {
    const e = makeEntry({
      provenance: {
        taggedBy: "auto",
        verification: {
          "visual.usesBorders": { method: "image-confirmed", verifiedAt: "2026-08-09", verifierVersion: "verifier-v1", imageSha256: "a".repeat(64) },
          critique: { method: "image-confirmed", verifiedAt: "2026-08-09", verifierVersion: "verifier-v1", imageSha256: "b".repeat(64) },
        },
      },
    });
    expect(() => assertNoIncomingVerification(e as never)).toThrow(/critique/);
    expect(() => assertNoIncomingVerification(e as never)).toThrow(/visual\.usesBorders/);
  });

  it("accepts an entry with no verification map", () => {
    expect(() => assertNoIncomingVerification(makeEntry({ provenance: { taggedBy: "auto" } }) as never)).not.toThrow();
  });

  it("accepts an entry with no provenance at all", () => {
    const e = makeEntry() as Record<string, unknown>;
    delete e.provenance;
    expect(() => assertNoIncomingVerification(e as never)).not.toThrow();
  });

  it("accepts an empty verification map — nothing is being claimed", () => {
    expect(() => assertNoIncomingVerification(
      makeEntry({ provenance: { taggedBy: "auto", verification: {} } }) as never,
    )).not.toThrow();
  });
});

describe("preserveGatedFields — the retag path", () => {
  const prior = () => makeEntry({
    visual: { ...fixtures[0].visual, usesShadows: true, accentColor: "#3d1ae0" },
    responsiveBehavior: "responsive",
  });

  it("a retag cannot change a gated value", () => {
    const retagged = makeEntry({
      visual: { ...fixtures[0].visual, usesShadows: false, accentColor: "#ff0000" },
      responsiveBehavior: "fixed-width",
    });
    const out = preserveGatedFields(retagged as never, prior() as never) as unknown as Record<string, unknown>;
    expect((out.visual as Record<string, unknown>).usesShadows).toBe(true);
    expect((out.visual as Record<string, unknown>).accentColor).toBe("#3d1ae0");
    expect(out.responsiveBehavior).toBe("responsive");
  });

  it("does NOT clear a prior value — that is the spec's open decision", () => {
    const out = preserveGatedFields(prior() as never, prior() as never);
    expect(out.visual.usesShadows).toBe(true);
  });

  it("drops a retag-invented value when the prior entry had none", () => {
    const bare = makeEntry() as Record<string, unknown>;
    delete bare.responsiveBehavior;
    const retagged = makeEntry({ responsiveBehavior: "adaptive" });
    const out = preserveGatedFields(retagged as never, bare as never) as unknown as Record<string, unknown>;
    expect("responsiveBehavior" in out).toBe(false);
  });

  it("leaves non-gated fields at their retagged values", () => {
    const retagged = makeEntry({ critique: "Freshly re-extracted critique text that is long enough to pass." });
    const out = preserveGatedFields(retagged as never, prior() as never);
    expect(out.critique).toBe("Freshly re-extracted critique text that is long enough to pass.");
  });
});

describe("the UI create funnel applies both guards", () => {
  const payload = () => ({
    ...makeEntry({ id: "ui-created" }),
    visual: { ...fixtures[0].visual, usesShadows: true, accentColor: "#3d1ae0" },
  });

  it("clears gated fields on create", () => {
    const out = prepareNewEntryPayload(payload(), []);
    expect(out.visual.usesShadows).toBeNull();
    expect(out.visual.accentColor).toBeNull();
  });

  it("refuses a create that arrives pre-verified", () => {
    const p = {
      ...payload(),
      provenance: {
        taggedBy: "auto",
        verification: { critique: { method: "image-confirmed", verifiedAt: "2026-08-09", verifierVersion: "verifier-v1", imageSha256: "c".repeat(64) } },
      },
    };
    expect(() => prepareNewEntryPayload(p, [])).toThrow(/cannot already be verified/);
  });
});

// Corollary 4. The strip must NOT live on the shared write path: persistEntries
// also serves the verifier's record writes, dedup-cleanup and restore-corpus, so a
// strip there would clear the existing 787's stored values on the next unrelated
// write. This asserts the boundary structurally rather than trusting the comment.
describe("the strip is at creation only, never on the shared write path", () => {
  // The source checks below are a smoke test — an aliased helper would defeat
  // them. This one is the real assertion: run the shared write path against an
  // isolated temp root and prove a stored gated value survives byte-identically.
  it("persistEntries preserves gated values on a real write", () => {
    const root = mkdtempSync(pathJoin(tmpdir(), "gated-persist-"));
    try {
      mkdirSync(pathJoin(root, "corpus"), { recursive: true });
      setCorpusRootForTesting(root);
      const stored = makeEntry({
        id: "stored-with-gated-values",
        visual: { ...fixtures[0].visual, usesShadows: true, accentColor: "#3d1ae0" },
        responsiveBehavior: "responsive",
      }) as never;
      // persistEntries returns the SERIALIZED corpus it wrote, so this asserts the
      // exact bytes that landed — not a re-read that could mask a transform.
      const written = persistEntries(writableLoadedCorpus([stored]), [stored]);
      const readBack = JSON.parse(written) as { entries: Array<Record<string, unknown>> };
      const e = readBack.entries[0];
      expect((e.visual as Record<string, unknown>).usesShadows).toBe(true);
      expect((e.visual as Record<string, unknown>).accentColor).toBe("#3d1ae0");
      expect(e.responsiveBehavior).toBe("responsive");
    } finally {
      setCorpusRootForTesting(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persistence.ts does not import the strip", () => {
    expect(readFileSync(new URL("./persistence.ts", import.meta.url).pathname, "utf8"))
      .not.toContain("gated-fields");
  });

  it.each([
    ["src/scripts/dedup-cleanup.ts", "dedup"],
    ["src/scripts/restore-corpus.ts", "restore"],
    ["src/scripts/verify-corpus.ts", "the verifier"],
  ])("%s does not strip gated fields", (file) => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url).pathname, "utf8");
    expect(src).not.toContain("stripGatedFields");
  });

  it.each([
    "src/scripts/add-entry.ts",
    "src/scripts/commit-draft.ts",
    "src/scripts/ui-server.ts",
  ])("%s DOES apply both guards", (file) => {
    const src = readFileSync(new URL(`../${file}`, import.meta.url).pathname, "utf8");
    expect(src).toContain("stripGatedFields");
    expect(src).toContain("assertNoIncomingVerification");
  });
});

// Corollary 3: only the verifier writes verification records.
//
// A SMOKE CHECK, not a proof. It matches `verification: {` in source, so it would
// miss `provenance.verification = map`, a computed key, a spread, a helper, or a
// non-.ts writer. It catches the realistic regression — someone adding a literal
// record block to an authoring path — and nothing stronger is claimed for it.
describe("only the verifier writes verification records", () => {
  it("no other production module assigns provenance.verification", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = `${dir}/${name}`;
        if (statSync(full).isDirectory()) return name === "node_modules" ? [] : walk(full);
        return full.endsWith(".ts") ? [full] : [];
      });
    const root = new URL("../src", import.meta.url).pathname;
    const offenders = walk(root)
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.mts") && !f.includes("__fixtures__"))
      .filter((f) => !f.endsWith("/verify-corpus.ts"))
      .filter((f) => /verification\s*[:=]\s*\{/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1));
    expect(offenders).toEqual([]);
  });
});
