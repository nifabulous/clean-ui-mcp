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
 * A generic URL in corpus prose is identity/path material that must never be
 * served. `containsPrivateMarker` covers only the five private-corpus literals
 * plus private-path forms, so the screen adds a focused URL match. Deliberately
 * NOT PATH_OR_URL_PATTERN (create-ui-spec-contracts.ts): that regex is scoped
 * to operator error messages and matches ordinary words ("private",
 * "node_modules") and any slash, which would over-drop legitimate prose here.
 */
const URL_PATTERN = /https?:\/\/[^\s]+|www\.[^\s]+/i;

/**
 * A SCHEMELESS host reference ("acme.com/start", "stripe.com"). Corpus prose
 * quotes on-screen copy verbatim, and product surfaces write their own domain
 * without a scheme far more often than with one, so {@link URL_PATTERN} alone
 * leaves the common case open.
 *
 * The TLD list is CLOSED on purpose. A general `\w+\.\w+` would drop
 * "WCAG 1.4.3", "e.g.", "i.e." and "config.json" — ordinary prose in a corpus
 * whose whole value is prose — so the screen trades recall for precision here
 * and the generic-URL pattern above catches anything carrying a scheme.
 */
const SCHEMELESS_HOST_PATTERN =
  /(?:^|[^\w@.])[a-z0-9][a-z0-9-]*\.(?:com|io|app|co|dev|net|org|ai|so|xyz|design|studio)(?:$|[^\w])/i;

/**
 * Word-boundary, case-insensitive literal match. The name is regex-escaped so
 * corpus product names containing metacharacters ("SLMobbin!", "1-on-1") match
 * literally. `\b` is deliberately NOT used: a name ending in a non-word
 * character ("SLMobbin!") never matches with `\b…\b` (there is no word/non-word
 * transition after "!"), so the boundaries are explicit non-word/edge checks.
 * These also prevent "Mobbin" from matching inside an unrelated word like
 * "Mobbinology".
 */
function matchesName(text: string, name: string): boolean {
  return new RegExp(`(?:^|[^\\w])${escapeRegExp(name)}(?:$|[^\\w])`, "i").test(text);
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
  if (URL_PATTERN.test(text)) return null;
  if (SCHEMELESS_HOST_PATTERN.test(text)) return null;
  return text;
}
