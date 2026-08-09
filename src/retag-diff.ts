import { createHash } from "node:crypto";

/** Fields a shadow retag may propose. Protected identity and source fields are
 * intentionally absent; this list is the review contract, not a convenience
 * list for copying arbitrary model output. */
export const RETAG_FIELDS = [
  "patternType",
  "categories",
  "styleTags",
  "components",
  "domainTags",
  "colorScheme",
  "layout",
  "visual.typePairing",
  "mood",
] as const;

export type RetagField = (typeof RETAG_FIELDS)[number];

export type RetagEntryLike = {
  id?: string;
  source?: { productName?: string | null } | null;
  [key: string]: unknown;
};

export type FieldRelation = "absent" | "added" | "removed" | "unchanged" | "changed";

export type FieldComparison = {
  baselinePresent: boolean;
  candidatePresent: boolean;
  relation: FieldRelation;
  /** Null when one or both sides are absent; absence is never scored as agreement. */
  agrees: boolean | null;
};

export type EntryComparison = {
  id: string;
  family: string;
  fields: Record<RetagField, FieldComparison>;
};

export type FieldSummary = {
  baselinePresent: number;
  candidatePresent: number;
  bothPresent: number;
  unchanged: number;
  changed: number;
  added: number;
  removed: number;
  /** `changed / bothPresent`; zero when there are no shared values. */
  disagreementRate: number;
};

export type RetagSummary = Record<RetagField, FieldSummary>;

export function valueForField(entry: RetagEntryLike, field: RetagField): unknown {
  if (field === "visual.typePairing") {
    const visual = entry.visual;
    return visual && typeof visual === "object" ? (visual as Record<string, unknown>).typePairing : undefined;
  }
  return entry[field];
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(isPresent);
  }
  return true;
}

/** Canonical comparison: arrays are set-like tags; object key order is irrelevant. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    const values = value.map(canonical);
    return values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function equalValues(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export function compareField(baseline: unknown, candidate: unknown): FieldComparison {
  const baselinePresent = isPresent(baseline);
  const candidatePresent = isPresent(candidate);
  if (!baselinePresent && !candidatePresent) {
    return { baselinePresent, candidatePresent, relation: "absent", agrees: null };
  }
  if (!baselinePresent) {
    return { baselinePresent, candidatePresent, relation: "added", agrees: null };
  }
  if (!candidatePresent) {
    return { baselinePresent, candidatePresent, relation: "removed", agrees: null };
  }
  const agrees = equalValues(baseline, candidate);
  return { baselinePresent, candidatePresent, relation: agrees ? "unchanged" : "changed", agrees };
}

export function familyOf(entry: RetagEntryLike): string {
  const product = entry.source?.productName?.trim().toLowerCase();
  if (product) return product.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
  const id = typeof entry.id === "string" ? entry.id.split("-")[0] : "unknown";
  return id || "unknown";
}

export function compareEntry(baseline: RetagEntryLike, candidate: RetagEntryLike): EntryComparison {
  const fields = Object.fromEntries(
    RETAG_FIELDS.map((field) => [field, compareField(valueForField(baseline, field), valueForField(candidate, field))]),
  ) as Record<RetagField, FieldComparison>;
  return { id: String(baseline.id ?? candidate.id ?? ""), family: familyOf(baseline), fields };
}

export function summarize(comparisons: readonly EntryComparison[]): RetagSummary {
  return Object.fromEntries(
    RETAG_FIELDS.map((field) => {
      const rows = comparisons.map((comparison) => comparison.fields[field]);
      const baselinePresent = rows.filter((row) => row.baselinePresent).length;
      const candidatePresent = rows.filter((row) => row.candidatePresent).length;
      const bothPresent = rows.filter((row) => row.baselinePresent && row.candidatePresent).length;
      const unchanged = rows.filter((row) => row.relation === "unchanged").length;
      const changed = rows.filter((row) => row.relation === "changed").length;
      const added = rows.filter((row) => row.relation === "added").length;
      const removed = rows.filter((row) => row.relation === "removed").length;
      return [field, {
        baselinePresent,
        candidatePresent,
        bothPresent,
        unchanged,
        changed,
        added,
        removed,
        disagreementRate: bothPresent === 0 ? 0 : changed / bothPresent,
      } satisfies FieldSummary];
    }),
  ) as RetagSummary;
}

/** Deterministically sample across product families without relying on corpus order. */
export function pickStratifiedSample<T extends RetagEntryLike>(entries: readonly T[], size: number, seed: string): T[] {
  if (size <= 0 || entries.length === 0) return [];
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const family = familyOf(entry);
    const group = groups.get(family) ?? [];
    group.push(entry);
    groups.set(family, group);
  }
  const ranked = [...groups.entries()].map(([family, group]) => ({
    family,
    entries: [...group].sort((a, b) => rank(seed, a.id ?? "").localeCompare(rank(seed, b.id ?? ""))),
  })).sort((a, b) => a.family.localeCompare(b.family));
  const out: T[] = [];
  for (let index = 0; out.length < Math.min(size, entries.length); index += 1) {
    let progressed = false;
    for (const group of ranked) {
      const entry = group.entries[index];
      if (!entry) continue;
      out.push(entry);
      progressed = true;
      if (out.length === size) break;
    }
    if (!progressed) break;
  }
  return out;
}

function rank(seed: string, id: string): string {
  return createHash("sha256").update(`${seed}:${id}`).digest("hex");
}
