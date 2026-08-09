/**
 * Split a model-produced taxonomy list without losing the model's unknown
 * proposals. Canonical corpus fields must stay closed-vocabulary, but an
 * unknown proposal is useful curator evidence and must not be indistinguishable
 * from the model seeing no value.
 */
export interface AllowedListResult {
  values: string[];
  rejected: string[];
}

export function listFromAllowedWithRejects(
  value: unknown,
  allowed: readonly string[],
  max: number,
): AllowedListResult {
  if (!Array.isArray(value) || max < 1) return { values: [], rejected: [] };

  const allowedSet = new Set(allowed);
  const values: string[] = [];
  const rejected: string[] = [];
  const seenValues = new Set<string>();
  const seenRejected = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized) continue;

    if (allowedSet.has(normalized)) {
      if (!seenValues.has(normalized) && values.length < max) {
        seenValues.add(normalized);
        values.push(normalized);
      }
      continue;
    }

    if (!seenRejected.has(normalized)) {
      seenRejected.add(normalized);
      rejected.push(normalized);
    }
  }

  return { values, rejected };
}
