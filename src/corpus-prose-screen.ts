/**
 * corpus-prose-screen.ts — the identity screen for served corpus prose (C3
 * Phase 1, Task 3).
 *
 * The corpus records real product identity (source.productName, title, image
 * paths) that must never be published. This module is the single screen every
 * corpus-prose string passes before it can be emitted into a UiSpec field:
 * drop-whole (never redact), word-boundary, case-insensitive.
 *
 * Design spec §3: drop a string when it names the source entry's own product
 * or title, any corpus-derived distinctive product name, or any private-corpus
 * marker. The distinctive-name list is DERIVED from the corpus at build time —
 * not hand-maintained — so a new corpus entry cannot silently widen the hole.
 */
import type { CorpusEntryT } from "./schema.js";
import { containsPrivateMarker } from "./create-ui-spec-private-markers.js";

/**
 * Dictionary-word product names excluded from the corpus-wide denied-name set
 * (design spec §3). Matching them globally would drop ~8% of good rows for
 * "projects" and the other five. They are still caught by the own-entry check,
 * which is precise.
 */
const DICTIONARY_WORD_PRODUCT_NAMES: ReadonlySet<string> = new Set([
  "origin",
  "hive",
  "people",
  "projects",
  "mercury",
  "untitled",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary, case-insensitive literal match. The name is regex-escaped so
 * corpus product names containing metacharacters ("SLMobbin!", "1-on-1") match
 * literally; the `\b` boundaries prevent "Mobbin" from matching inside an
 * unrelated word like "Mobbinology".
 */
function matchesName(text: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(text);
}

/**
 * Derive the corpus-wide denied-name set: every distinct source.productName
 * (lowercased, so casing variants like "Wise"/"wise" collapse), excluding the
 * six dictionary words. Always derived at build time, never hand-maintained.
 */
export function buildDeniedNames(entries: readonly CorpusEntryT[]): ReadonlySet<string> {
  const denied = new Set<string>();
  for (const entry of entries) {
    const productName = entry.source?.productName?.trim().toLowerCase();
    if (!productName) continue;
    if (DICTIONARY_WORD_PRODUCT_NAMES.has(productName)) continue;
    denied.add(productName);
  }
  return denied;
}

/**
 * Screen one corpus-prose string (design spec §3). Returns the string
 * UNCHANGED when safe to serve, or null when it must be dropped WHOLE — never
 * redacted in place. Drop conditions, in order:
 *   1. the source entry's own id, productName or title (always, even
 *      dictionary words — the own-entry check is precise; the id is a
 *      fail-closed addition over design spec §3's list, required by §2c:
 *      "Never served: ... the corpus entry id", including when prose embeds it);
 *   2. any corpus-derived distinctive product name (dictionary words excluded
 *      from the global list by {@link buildDeniedNames});
 *   3. any private-corpus marker via the existing containsPrivateMarker sweep
 *      (unchanged, still fail-closed).
 */
export function screenProse(
  text: string,
  entry: CorpusEntryT,
  deniedNames: ReadonlySet<string>,
): string | null {
  const ownNames: string[] = [];
  if (typeof entry.id === "string" && entry.id.length > 0)
    ownNames.push(entry.id);
  if (typeof entry.source?.productName === "string" && entry.source.productName.length > 0)
    ownNames.push(entry.source.productName);
  if (typeof entry.title === "string" && entry.title.length > 0)
    ownNames.push(entry.title);
  for (const own of ownNames) {
    if (matchesName(text, own)) return null;
  }
  for (const name of deniedNames) {
    if (matchesName(text, name)) return null;
  }
  if (containsPrivateMarker(text)) return null;
  return text;
}
