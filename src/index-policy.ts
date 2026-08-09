/**
 * Eligibility policy shared by text-index construction and its tests.
 * Review status is intentionally the only global index gate here: field-level
 * trust is enforced by the reader/tool policy because different consumers need
 * different verified core fields. A pending draft must never consume index
 * capacity or influence semantic retrieval.
 */
export function isTextIndexEligible(entry: { reviewStatus?: "draft" | "approved" }): boolean {
  return entry.reviewStatus !== "draft";
}
