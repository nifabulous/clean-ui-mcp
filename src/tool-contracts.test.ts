import { describe, expect, it } from "vitest";
import {
  RetrievalMode,
  RetrievalModality,
  FallbackReason,
  RetrievalState,
  ToolResultEnvelope,
  isAllowedRetrievalState,
  Evidence,
  ToolError,
} from "./tool-contracts.js";

const SHA = "a".repeat(64);

// ---------------------------------------------------------------------------
// Retrieval state matrix
// ---------------------------------------------------------------------------

describe("RetrievalMode", () => {
  it("accepts the five approved modes", () => {
    for (const mode of ["hybrid", "vector", "keyword", "structured-fallback", "none"]) {
      expect(RetrievalMode.safeParse(mode).success).toBe(true);
    }
  });

  it("rejects unknown modes", () => {
    expect(RetrievalMode.safeParse("image-vector").success).toBe(false);
    expect(RetrievalMode.safeParse("semantic").success).toBe(false);
  });
});

describe("RetrievalModality", () => {
  it("accepts the four modalities", () => {
    for (const m of ["text", "image", "metadata", "none"]) {
      expect(RetrievalModality.safeParse(m).success).toBe(true);
    }
  });
});

describe("FallbackReason", () => {
  it("accepts the six reasons", () => {
    for (const r of [
      "missing-index",
      "incompatible-index",
      "missing-provider-key",
      "community-edition",
      "provider-error",
      "no-image-evidence",
    ]) {
      expect(FallbackReason.safeParse(r).success).toBe(true);
    }
  });
});

describe("RetrievalState", () => {
  it("accepts a valid hybrid text retrieval", () => {
    expect(
      RetrievalState.safeParse({
        mode: "hybrid",
        modality: "text",
        fallbackUsed: false,
        attemptedModes: ["vector", "keyword"],
      }).success,
    ).toBe(true);
  });

  it("accepts vector image retrieval (not 'image-vector' mode)", () => {
    expect(
      RetrievalState.safeParse({
        mode: "vector",
        modality: "image",
        fallbackUsed: false,
      }).success,
    ).toBe(true);
  });

  it("accepts keyword fallback with a reason", () => {
    expect(
      RetrievalState.safeParse({
        mode: "keyword",
        modality: "text",
        fallbackUsed: true,
        fallbackReason: "missing-index",
        attemptedModes: ["vector"],
      }).success,
    ).toBe(true);
  });

  it("accepts structured-fallback with a reason", () => {
    expect(
      RetrievalState.safeParse({
        mode: "structured-fallback",
        modality: "metadata",
        fallbackUsed: true,
        fallbackReason: "community-edition",
      }).success,
    ).toBe(true);
  });

  it("accepts none modality with none mode", () => {
    expect(
      RetrievalState.safeParse({
        mode: "none",
        modality: "none",
        fallbackUsed: false,
      }).success,
    ).toBe(true);
  });

  it("rejects 'none' mode with fallbackUsed true", () => {
    expect(
      RetrievalState.safeParse({
        mode: "none",
        modality: "none",
        fallbackUsed: true,
        fallbackReason: "missing-index",
      }).success,
    ).toBe(false);
  });

  it("rejects 'vector' mode with 'missing-index' fallback (contradictory)", () => {
    expect(
      RetrievalState.safeParse({
        mode: "vector",
        modality: "image",
        fallbackUsed: true,
        fallbackReason: "missing-index",
      }).success,
    ).toBe(false);
  });

  it("rejects 'structured-fallback' without a fallbackReason", () => {
    expect(
      RetrievalState.safeParse({
        mode: "structured-fallback",
        modality: "metadata",
        fallbackUsed: true,
      }).success,
    ).toBe(false);
  });

  it("rejects fallbackUsed true without a fallbackReason", () => {
    expect(
      RetrievalState.safeParse({
        mode: "keyword",
        modality: "text",
        fallbackUsed: true,
      }).success,
    ).toBe(false);
  });

  it("rejects fallbackReason without fallbackUsed", () => {
    expect(
      RetrievalState.safeParse({
        mode: "keyword",
        modality: "text",
        fallbackUsed: false,
        fallbackReason: "missing-index",
      }).success,
    ).toBe(false);
  });
});

describe("isAllowedRetrievalState", () => {
  it("allows intentional keyword without fallback", () => {
    expect(
      isAllowedRetrievalState({
        mode: "keyword",
        modality: "text",
        fallbackUsed: false,
      }),
    ).toBe(true);
  });

  it("allows degraded keyword with fallback reason", () => {
    expect(
      isAllowedRetrievalState({
        mode: "keyword",
        modality: "text",
        fallbackUsed: true,
        fallbackReason: "missing-index",
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ToolResultEnvelope
// ---------------------------------------------------------------------------

describe("ToolResultEnvelope", () => {
  it("accepts a valid success envelope", () => {
    const result = ToolResultEnvelope.safeParse({
      tool: "search_ui_references",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Found 5 references",
      data: { results: [] },
      referenceIds: ["ref-1"],
      retrieval: {
        mode: "hybrid",
        modality: "text",
        fallbackUsed: false,
      },
      warnings: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid error envelope", () => {
    const result = ToolResultEnvelope.safeParse({
      tool: "search_ui_references",
      schemaVersion: "1.0",
      status: "error",
      summary: "Not found",
      data: null,
      referenceIds: [],
      retrieval: {
        mode: "none",
        modality: "none",
        fallbackUsed: false,
      },
      warnings: [],
      error: {
        code: "NOT_FOUND",
        message: "No results",
        retryable: false,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects status ok with null data", () => {
    expect(
      ToolResultEnvelope.safeParse({
        tool: "search_ui_references",
        schemaVersion: "1.0",
        status: "ok",
        summary: "x",
        data: null,
        referenceIds: [],
        retrieval: { mode: "none", modality: "none", fallbackUsed: false },
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it("rejects status error with non-null data", () => {
    expect(
      ToolResultEnvelope.safeParse({
        tool: "search_ui_references",
        schemaVersion: "1.0",
        status: "error",
        summary: "x",
        data: { foo: "bar" },
        referenceIds: [],
        retrieval: { mode: "none", modality: "none", fallbackUsed: false },
        warnings: [],
        error: { code: "ERR", message: "x", retryable: false },
      }).success,
    ).toBe(false);
  });

  it("rejects status error without error object", () => {
    expect(
      ToolResultEnvelope.safeParse({
        tool: "search_ui_references",
        schemaVersion: "1.0",
        status: "error",
        summary: "x",
        data: null,
        referenceIds: [],
        retrieval: { mode: "none", modality: "none", fallbackUsed: false },
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it("strict-rejects unknown keys", () => {
    expect(
      ToolResultEnvelope.safeParse({
        tool: "search_ui_references",
        schemaVersion: "1.0",
        status: "ok",
        summary: "x",
        data: {},
        referenceIds: [],
        retrieval: { mode: "none", modality: "none", fallbackUsed: false },
        warnings: [],
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

describe("Evidence", () => {
  it("accepts a valid evidence entry", () => {
    expect(
      Evidence.safeParse({
        referenceId: "ref-1",
        claim: "This dashboard uses a 12-column grid",
        field: "layout",
        type: "visible",
      }).success,
    ).toBe(true);
  });

  it("accepts type 'inferred'", () => {
    expect(
      Evidence.safeParse({
        referenceId: "ref-1",
        claim: "The spacing suggests an 8px base unit",
        field: "spacing",
        type: "inferred",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown type values", () => {
    expect(
      Evidence.safeParse({
        referenceId: "ref-1",
        claim: "x",
        field: "x",
        type: "guessed",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ToolError
// ---------------------------------------------------------------------------

describe("ToolError", () => {
  it("accepts a valid error", () => {
    expect(
      ToolError.safeParse({
        code: "NOT_FOUND",
        message: "No references found",
        retryable: false,
      }).success,
    ).toBe(true);
  });

  it("accepts retryable errors", () => {
    expect(
      ToolError.safeParse({
        code: "PROVIDER_ERROR",
        message: "Rate limited",
        retryable: true,
      }).success,
    ).toBe(true);
  });

  it("requires code, message, and retryable", () => {
    expect(
      ToolError.safeParse({ code: "ERR", message: "x" }).success,
    ).toBe(false);
  });

  it("strict-rejects unknown keys", () => {
    expect(
      ToolError.safeParse({
        code: "ERR",
        message: "x",
        retryable: false,
        extra: true,
      }).success,
    ).toBe(false);
  });
});
