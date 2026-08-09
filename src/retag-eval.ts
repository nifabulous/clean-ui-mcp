import { createHash } from "node:crypto";
import { RETAG_FIELDS, valueForField, type RetagEntryLike, type RetagField } from "./retag-diff.js";

export type GoldStatus = "present" | "none" | "abstain";

/** A gold label is explicit about negative and unscorable cases. */
export type GoldField = {
  status: GoldStatus;
  value?: unknown;
};

export type GoldLabel = {
  entryId: string;
  imageSha256: string;
  fields: Partial<Record<RetagField, GoldField>>;
};

export type GoldFieldMetrics = {
  labelled: number;
  abstained: number;
  exact: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  exactAccuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
};

export type GoldEvaluation = {
  entries: number;
  missingPredictions: string[];
  fields: Record<RetagField, GoldFieldMetrics>;
};

function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(present);
  return true;
}

function values(value: unknown): Set<string> {
  if (Array.isArray(value)) return new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean));
  return present(value) ? new Set([JSON.stringify(value)]) : new Set();
}

function scoreField(labels: GoldLabel[], predictions: Map<string, RetagEntryLike>, field: RetagField): GoldFieldMetrics {
  let labelled = 0;
  let abstained = 0;
  let exact = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const label of labels) {
    const expected = label.fields[field];
    if (!expected || expected.status === "abstain") {
      if (expected?.status === "abstain") abstained += 1;
      continue;
    }
    labelled += 1;
    const prediction = predictions.get(label.entryId);
    const hasPrediction = prediction !== undefined;
    const predicted = valueForField(prediction ?? {}, field);
    const expectedSet = expected.status === "present" ? values(expected.value) : new Set<string>();
    const predictedSet = values(predicted);
    for (const value of predictedSet) {
      if (expectedSet.has(value)) truePositives += 1;
      else falsePositives += 1;
    }
    for (const value of expectedSet) {
      if (!predictedSet.has(value)) falseNegatives += 1;
    }
    if (hasPrediction && (expected.status === "none" ? !present(predicted) : expectedSet.size > 0 && setsEqual(expectedSet, predictedSet))) {
      exact += 1;
    }
  }
  const precisionDenominator = truePositives + falsePositives;
  const recallDenominator = truePositives + falseNegatives;
  const f1Denominator = (2 * truePositives) + falsePositives + falseNegatives;
  return {
    labelled,
    abstained,
    exact,
    truePositives,
    falsePositives,
    falseNegatives,
    exactAccuracy: labelled ? exact / labelled : null,
    precision: precisionDenominator ? truePositives / precisionDenominator : null,
    recall: recallDenominator ? truePositives / recallDenominator : null,
    f1: f1Denominator ? (2 * truePositives) / f1Denominator : null,
  };
}

export function evaluateGold(labels: readonly GoldLabel[], predictions: readonly RetagEntryLike[]): GoldEvaluation {
  const byId = new Map<string, RetagEntryLike>(
    predictions.filter((entry): entry is RetagEntryLike & { id: string } => typeof entry.id === "string")
      .map((entry) => [entry.id, entry]),
  );
  const missingPredictions = labels.map((label) => label.entryId).filter((id) => !byId.has(id));
  return {
    entries: labels.length,
    missingPredictions,
    fields: Object.fromEntries(RETAG_FIELDS.map((field) => [field, scoreField([...labels], byId, field)])) as Record<RetagField, GoldFieldMetrics>,
  };
}

/** Require a persisted shadow score to contain an actual gold evaluation. */
export function assertGoldEvaluation(value: unknown): asserts value is { gold: GoldEvaluation } {
  if (!value || typeof value !== "object") throw new Error("promotion requires a persisted gold evaluation");
  const gold = (value as { gold?: unknown }).gold;
  if (!gold || typeof gold !== "object") throw new Error("promotion requires scores.gold from an independent label run");
  const entries = (gold as { entries?: unknown }).entries;
  const fields = (gold as { fields?: unknown }).fields;
  if (typeof entries !== "number" || !Number.isInteger(entries) || entries < 1 || !fields || typeof fields !== "object" || Object.keys(fields).length === 0) {
    throw new Error("promotion requires a non-empty, persisted gold field evaluation");
  }
}

export function assertGoldBindings(labels: readonly GoldLabel[], entries: readonly RetagEntryLike[], imageSha256: (entry: RetagEntryLike) => string): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label.entryId)) throw new Error(`duplicate gold label for ${label.entryId}`);
    seen.add(label.entryId);
    const entry = byId.get(label.entryId);
    if (!entry) throw new Error(`gold label names unknown entry ${label.entryId}`);
    const actual = imageSha256(entry);
    if (actual !== label.imageSha256) {
      throw new Error(`gold label image hash mismatch for ${label.entryId}: expected ${label.imageSha256}, got ${actual}`);
    }
  }
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
