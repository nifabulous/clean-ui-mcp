/**
 * design-target-contracts.test.ts — TDD for the versioned web handoff contract.
 *
 * Task 1 of the web design adapters plan. These contracts are the fail-closed
 * boundary between an untrusted producer input and a trusted DesignHandoffT.
 * The parser is the ONLY constructor for DesignHandoffT; no type assertion may
 * bypass it.
 */
import { describe, expect, it } from "vitest";
import {
  DependencyRefSchema,
  MotionIntentSchema,
  SourceRefSchema,
  VersionedRefSchema,
  WebTargetProfileSchema,
  parseDesignHandoff,
  type DesignHandoffT,
} from "./design-target-contracts.js";
import { UiSpec } from "./tool-contracts.js";

// ---------------------------------------------------------------------------
// Type-level guards (compile-time only). The brand on DesignHandoffT must make
// an ad-hoc object literal WITHOUT `as unknown` fail to assign. If this line
// ever stops erroring, the brand contract has regressed.
// ---------------------------------------------------------------------------
// @ts-expect-error — DesignHandoffT cannot be constructed without the parser.
const _typeGuardBrand: DesignHandoffT = {
  spec: undefined as never,
  target: undefined as never,
  motionIntents: [],
  generatedAt: "",
};
void _typeGuardBrand;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid UiSpec 1.0 object (mirrors the canonical fixture in tool-contracts.test.ts). */
function validUiSpec(): Record<string, unknown> {
  return {
    specVersion: "1.0",
    context: { productContext: "A fintech dashboard" },
    designDirection: "Calm layout",
    rejectedDefaults: [],
    layoutRegions: [],
    responsiveBehavior: [],
    componentInventory: [],
    colorTokens: { primary: "#3b82f6", surface: "#fff", ink: "#1e293b", muted: "#64748b", accent: "#3b82f6" },
    colorTokenAuthority: "corpus-evidence",
    typographyTokens: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
    typographyTokenAuthority: "corpus-evidence",
    interactions: [],
    motionGuidance: { notes: [], evidenceUnavailable: true },
    accessibilityConstraints: [],
    techniques: [],
    antiPatterns: [],
    unavailableDecisions: [{ field: "motion", reason: "no DOM evidence" }],
    acceptanceCriteria: [{
      id: "ac1", subject: "contrast", assertion: "meets-contrast",
      expectedOutcome: "4.5:1", verifier: "axe", priority: "must", evidenceIds: [],
    }],
    citedReferences: [],
    citedDecisions: [],
    authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
    provenance: { generatedAt: "2026-07-15T00:00:00Z", toolVersion: "0.2.0", sourceReferences: [], evidenceIds: [] },
  };
}

function neutralWebTarget(): Record<string, unknown> {
  return {
    id: "neutral-web",
    platform: "web",
    siteFramework: "none",
    runtime: "none",
    styling: "vanilla-css",
    componentSource: "native-html",
    motion: "css",
    islandStrategy: null,
  };
}

function validMotionIntent(): Record<string, unknown> {
  return {
    id: "fade-in",
    trigger: "mount",
    properties: ["opacity"],
    durationToken: "duration-short",
    easingToken: "ease-out",
    interruptible: true,
    reducedMotion: "render final state immediately",
  };
}

// ---------------------------------------------------------------------------
// WebTargetProfileSchema
// ---------------------------------------------------------------------------

describe("WebTargetProfileSchema", () => {
  it("parses a valid neutral-web profile", () => {
    const result = WebTargetProfileSchema.safeParse(neutralWebTarget());
    expect(result.success).toBe(true);
  });

  it("rejects flutter runtime (not in enum)", () => {
    const t = neutralWebTarget();
    t.runtime = "flutter";
    expect(WebTargetProfileSchema.safeParse(t).success).toBe(false);
  });

  it("rejects unknown component source bootstrap (not in enum)", () => {
    const t = neutralWebTarget();
    t.componentSource = "bootstrap";
    expect(WebTargetProfileSchema.safeParse(t).success).toBe(false);
  });

  it("rejects unknown id", () => {
    const t = neutralWebTarget();
    t.id = "next-react";
    expect(WebTargetProfileSchema.safeParse(t).success).toBe(false);
  });

  it("rejects non-web platform", () => {
    const t = neutralWebTarget();
    t.platform = "ios";
    expect(WebTargetProfileSchema.safeParse(t).success).toBe(false);
  });

  it("rejects unknown extra field (strict)", () => {
    const t = neutralWebTarget();
    (t as Record<string, unknown>).extraField = "nope";
    expect(WebTargetProfileSchema.safeParse(t).success).toBe(false);
  });

  it("accepts a non-null islandStrategy for astro targets", () => {
    const t: Record<string, unknown> = {
      id: "astro-react",
      platform: "web",
      siteFramework: "astro",
      runtime: "react",
      styling: "tailwind",
      componentSource: "shadcn",
      motion: "motion",
      islandStrategy: "client:load",
    };
    expect(WebTargetProfileSchema.safeParse(t).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VersionedRefSchema
// ---------------------------------------------------------------------------

describe("VersionedRefSchema", () => {
  it("parses a valid exact ref", () => {
    expect(VersionedRefSchema.safeParse({ id: "react", version: "19.2.0", versionPolicy: "exact" }).success).toBe(true);
  });

  it("parses a valid range ref", () => {
    expect(VersionedRefSchema.safeParse({ id: "astro", version: "5.x", versionPolicy: "range" }).success).toBe(true);
  });

  it("parses a valid unversioned ref", () => {
    expect(VersionedRefSchema.safeParse({ id: "view-transitions-api", version: "unversioned", versionPolicy: "unversioned" }).success).toBe(true);
  });

  it("rejects empty version", () => {
    expect(VersionedRefSchema.safeParse({ id: "react", version: "", versionPolicy: "exact" }).success).toBe(false);
  });

  it("rejects unknown versionPolicy", () => {
    expect(VersionedRefSchema.safeParse({ id: "react", version: "19.2.0", versionPolicy: "latest" }).success).toBe(false);
  });

  it("rejects unknown extra field (strict)", () => {
    expect(VersionedRefSchema.safeParse({ id: "react", version: "19.2.0", versionPolicy: "exact", extra: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DependencyRefSchema
// ---------------------------------------------------------------------------

describe("DependencyRefSchema", () => {
  function valid(): Record<string, unknown> {
    return {
      packageName: "astro",
      version: "5.0.0",
      versionPolicy: "exact",
      required: true,
      purpose: "site framework",
      docsUrl: "https://docs.astro.build/",
    };
  }

  it("parses a valid dependency", () => {
    expect(DependencyRefSchema.safeParse(valid()).success).toBe(true);
  });

  it("accepts nullable docsUrl", () => {
    const d = valid();
    d.docsUrl = null;
    expect(DependencyRefSchema.safeParse(d).success).toBe(true);
  });

  // Task 1 is a shape check; the registry-level "exact-only for packages" rule
  // is enforced in Task 2. The schema still rejects unknown versionPolicy values.
  it("rejects unknown versionPolicy latest (not in enum)", () => {
    const d = valid();
    d.versionPolicy = "latest";
    expect(DependencyRefSchema.safeParse(d).success).toBe(false);
  });

  it("rejects unknown extra field (strict)", () => {
    const d = valid();
    d.extra = "nope";
    expect(DependencyRefSchema.safeParse(d).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SourceRefSchema
// ---------------------------------------------------------------------------

describe("SourceRefSchema", () => {
  function captured(): Record<string, unknown> {
    return {
      sourceId: "astro-official",
      kind: "documentation",
      url: "https://docs.astro.build/",
      snapshotStatus: "captured",
      snapshotSha256: "a".repeat(64),
      snapshotReason: null,
      licenseStatus: "MIT",
      attribution: "Astro Docs",
    };
  }

  function notCaptured(): Record<string, unknown> {
    return {
      sourceId: "astro-official",
      kind: "documentation",
      url: "https://docs.astro.build/",
      snapshotStatus: "not-captured",
      snapshotSha256: null,
      snapshotReason: "source bytes are not vendored",
      licenseStatus: "MIT",
      attribution: "Astro Docs",
    };
  }

  it("parses a captured source with 64-char lowercase hash", () => {
    expect(SourceRefSchema.safeParse(captured()).success).toBe(true);
  });

  it("parses a not-captured source with a reason", () => {
    expect(SourceRefSchema.safeParse(notCaptured()).success).toBe(true);
  });

  it("rejects malformed snapshotSha256 when captured", () => {
    const s = captured();
    s.snapshotSha256 = "not-a-hash";
    expect(SourceRefSchema.safeParse(s).success).toBe(false);
  });

  it("rejects captured source without a hash", () => {
    const s = captured();
    s.snapshotSha256 = null;
    expect(SourceRefSchema.safeParse(s).success).toBe(false);
  });

  it("rejects not-captured source without a reason", () => {
    const s = notCaptured();
    s.snapshotReason = null;
    expect(SourceRefSchema.safeParse(s).success).toBe(false);
  });

  it("rejects uppercase hash", () => {
    const s = captured();
    s.snapshotSha256 = "A".repeat(64);
    expect(SourceRefSchema.safeParse(s).success).toBe(false);
  });

  it("rejects 63-char hash", () => {
    const s = captured();
    s.snapshotSha256 = "a".repeat(63);
    expect(SourceRefSchema.safeParse(s).success).toBe(false);
  });

  it("rejects unknown snapshotStatus", () => {
    const s = notCaptured();
    s.snapshotStatus = "pending";
    expect(SourceRefSchema.safeParse(s).success).toBe(false);
  });

  it("rejects unknown extra field (strict)", () => {
    const s = captured();
    s.extra = "no";
    expect(SourceRefSchema.safeParse(s).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MotionIntentSchema
// ---------------------------------------------------------------------------

describe("MotionIntentSchema", () => {
  it("parses a valid motion intent", () => {
    expect(MotionIntentSchema.safeParse(validMotionIntent()).success).toBe(true);
  });

  it("rejects motion intent with empty reducedMotion", () => {
    const m = validMotionIntent();
    m.reducedMotion = "";
    expect(MotionIntentSchema.safeParse(m).success).toBe(false);
  });

  it("rejects unknown extra field (strict)", () => {
    const m = validMotionIntent();
    m.extra = "no";
    expect(MotionIntentSchema.safeParse(m).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseDesignHandoff
// ---------------------------------------------------------------------------

describe("parseDesignHandoff", () => {
  it("returns a trusted DesignHandoffT for a valid neutral-web input", () => {
    const handoff = parseDesignHandoff({
      spec: validUiSpec(),
      target: neutralWebTarget(),
      motionIntents: [validMotionIntent()],
      generatedAt: "2026-07-21T00:00:00.000Z",
    });

    // The parser is the only constructor: outputs carry validated data.
    expect(UiSpec.safeParse(handoff.spec).success).toBe(true);
    expect(handoff.target.id).toBe("neutral-web");
    expect(handoff.target.platform).toBe("web");
    expect(handoff.motionIntents).toHaveLength(1);
    expect(handoff.motionIntents[0].id).toBe("fade-in");
    expect(handoff.generatedAt).toBe("2026-07-21T00:00:00.000Z");
  });

  it("accepts an empty motion intents array", () => {
    const handoff = parseDesignHandoff({
      spec: validUiSpec(),
      target: neutralWebTarget(),
      motionIntents: [],
      generatedAt: "2026-07-21T00:00:00.000Z",
    });
    expect(handoff.motionIntents).toEqual([]);
  });

  it("throws on an invalid UiSpec", () => {
    expect(() =>
      parseDesignHandoff({
        spec: { garbage: true },
        target: neutralWebTarget(),
        motionIntents: [],
        generatedAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("throws on an invalid target", () => {
    const t = neutralWebTarget();
    t.runtime = "flutter";
    expect(() =>
      parseDesignHandoff({
        spec: validUiSpec(),
        target: t,
        motionIntents: [],
        generatedAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("throws on an invalid motion intent", () => {
    const m = validMotionIntent();
    m.reducedMotion = "";
    expect(() =>
      parseDesignHandoff({
        spec: validUiSpec(),
        target: neutralWebTarget(),
        motionIntents: [m],
        generatedAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("throws on a malformed generatedAt", () => {
    expect(() =>
      parseDesignHandoff({
        spec: validUiSpec(),
        target: neutralWebTarget(),
        motionIntents: [],
        generatedAt: "yesterday",
      }),
    ).toThrow();
  });
});
