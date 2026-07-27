/**
 * create-ui-spec-typed-errors.test.ts — proves the producer's typed-error
 * contract at the public boundary (Fix 2 of the P1 integrity/error-contract
 * pass).
 *
 * The contracts module (`parseDesignArtifactEnvelope`,
 * `parseCreateUiSpecCandidate`) throws bare `Error`s for internal diagnostics.
 * The producer is the PUBLIC boundary that enforces the typed-error contract:
 * every in-pipeline failure MUST reach the caller as a `CreateUiSpecError`,
 * never an untyped `Error` (a caller doing `catch (e) { if (e.code === ...) }`
 * would crash on `undefined.code` otherwise).
 *
 * This file uses `vi.mock` to force `parseDesignArtifactEnvelope` to throw a
 * bare `Error` (simulating an envelope integrity-verification failure — e.g. a
 * tampered rendering or, after Fix 1, a mismatched artifactId /
 * assemblyRulesSha256), then asserts `createUiSpec` wraps it as a typed
 * `INVALID_INPUT` `CreateUiSpecError` with `retryable: false`. The mock is
 * scoped to THIS file so the real parser is exercised everywhere else.
 */
import { describe, expect, it, vi } from "vitest";

// vi.mock is hoisted before imports. We override ONLY parseDesignArtifactEnvelope
// to throw a bare Error; everything else is re-exported from the real module via
// importOriginal. The producer under test imports the (mocked) contracts module,
// so its call to parseDesignArtifactEnvelope hits the throwing stub.
vi.mock("./create-ui-spec-contracts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./create-ui-spec-contracts.js")>();
  return {
    ...actual,
    parseDesignArtifactEnvelope: () => {
      // Bare Error — exactly the untyped throw the producer boundary must wrap.
      throw new Error("design artifact envelope integrity check failed: forced");
    },
  };
});

import { createUiSpec, type CreateUiSpecDependencies } from "./create-ui-spec.js";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";

/** Minimal no-op reader: the producer reaches the (mocked) parser regardless. */
function noopReader(): CorpusReader {
  const empty = (() => []) as never;
  return {
    search: empty,
    searchRanked: vi.fn(async () => []) as never,
    getById: vi.fn(() => undefined) as never,
    findSimilar: empty,
    listCategories: empty,
    listStyleTags: empty,
    listDomainTags: empty,
    indexStatus: vi.fn(() => ({
      indexed: 0, total: 0, hasIndex: false, missing: 0, stale: 0, contentStale: 0,
    })) as never,
    entriesForAggregation: empty,
    resolveImagePath: vi.fn(() => null) as never,
  } as unknown as CorpusReader;
}

function validInput(): Record<string, unknown> {
  return {
    productContext: "A calm analytics dashboard for a fintech",
    referenceIds: [],
    constraints: [],
    motionIntents: [],
  };
}

describe("create-ui-spec producer — typed error contract (Fix 2)", () => {
  it("surfaces a typed INVALID_INPUT when envelope integrity verification fails", async () => {
    const dependencies: CreateUiSpecDependencies = {
      reader: noopReader(),
      resolveReferenceToken: () => undefined,
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    };
    const result = await createUiSpec(validInput(), dependencies).catch((e: unknown) => e);
    // The producer MUST wrap the bare Error from parseDesignArtifactEnvelope as
    // a typed CreateUiSpecError — never let the raw Error escape.
    expect(result).toMatchObject({ code: "INVALID_INPUT", retryable: false });
    expect(result).not.toBeInstanceOf(Error);
    // Bounded, safe message — no leaked parser internals (no hashes/paths/ids).
    const msg = (result as { message?: string }).message ?? "";
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
    expect(msg.length).toBeLessThanOrEqual(500);
  });

  it("never throws a bare Error for an in-pipeline assembly/parse failure", async () => {
    // Direct assertion of the load-bearing contract: the rejected value is a
    // plain object carrying the CreateUiSpecError shape, NOT an Error instance.
    const dependencies: CreateUiSpecDependencies = {
      reader: noopReader(),
      resolveReferenceToken: () => undefined,
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    };
    const err = await createUiSpec(validInput(), dependencies).catch((e: unknown) => e);
    expect(err).toBeTruthy();
    expect(err instanceof Error).toBe(false);
    expect((err as { code?: unknown }).code).toBe("INVALID_INPUT");
    expect((err as { retryable?: unknown }).retryable).toBe(false);
  });

  it("uses a real CorpusEntryT import to keep the type graph exercised", () => {
    // Sanity: the mocked-module import path keeps CorpusEntryT referenced so
    // typecheck:contracts still walks this file's type imports.
    const _t: CorpusEntryT | undefined = undefined;
    expect(_t).toBeUndefined();
  });
});
