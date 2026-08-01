/**
 * create-ui-spec-dependencies.ts — the ONE dependency constructor and the ONE
 * explicit-reference policy for every create-ui-spec transport adapter
 * (Task 2a of the C3 slice).
 *
 * Two adapters consume the core producer: the MCP adapter (Task 3) and the
 * operator loopback HTTP adapter (Task 5). Both need a
 * {@link CreateUiSpecDependencies} value. If each built its own, the two could
 * drift on the one decision that actually matters for privacy — WHICH caller
 * tokens count as resolvable explicit references — and either could quietly
 * widen the core's opaque-reference boundary. So there is exactly one
 * constructor here, and neither adapter authors a resolver.
 *
 * THE POLICY (deliberately narrow):
 *
 *     reader.getById(token) !== undefined ? token : undefined
 *
 * It recognizes ONLY ids the ACTIVE reader already exposes through the existing
 * tool surface. Consequences, all intentional:
 *  - An arbitrary filesystem path, a URL, or any token absent from the active
 *    reader resolves to `undefined` (the core then omits it, and raises
 *    INVALID_INPUT if every supplied token was omitted).
 *  - There is NO fallback lookup and NO second resolution path. `getById` is the
 *    only reader method consulted, so there is no alternate route to widen.
 *  - The token is NOT normalized, trimmed, case-folded, or path-repaired before
 *    the lookup. A repaired variant would let a caller reach an entry the active
 *    reader never named; the raw token goes to `getById` exactly as supplied.
 *    (The request schema already trims `referenceIds`, so a production token
 *    arrives trimmed; this module adds no second, divergent normalization.)
 *  - Mode isolation is INHERITED from the reader, not re-implemented. In public
 *    mode the injected reader is a `PublicCorpusReader`, whose `getById` returns
 *    `undefined` for every id outside its verified snapshot — so an ineligible
 *    private id is unresolvable in public mode by construction. This module
 *    imports NEITHER corpus.ts NOR any global index: the reader is the single
 *    authority in both modes.
 *
 * THE TOKEN NEVER REACHES OUTPUT. An accepted token is a raw reader id (in
 * private mode, a private corpus id). The core does not publish it: it hashes it
 * into the opaque `ref-<sha256>` citation and puts only that digest in
 * `citedReferences` / `provenance.sourceReferences` / the row's
 * `publicReference`. A REFUSED token is not echoed either — the core's typed
 * errors carry fixed, `SafeErrorMessage`-validated text. This module therefore
 * never logs, wraps, formats, or re-throws around the token: it returns the
 * token or `undefined` and nothing else. Both properties are verified
 * end-to-end in create-ui-spec-dependencies.test.ts rather than assumed.
 *
 * NO synthesis, retrieval, or rendering lives here — `createUiSpec()` remains
 * the sole producer. This module only constructs the dependency value.
 */
import type { CorpusReader } from "./corpus-reader.js";
import type {
  CreateUiSpecDependencies,
  CreateUiSpecModelDependency,
} from "./create-ui-spec.js";
export type { CreateUiSpecModelDependency } from "./create-ui-spec.js";

/**
 * Build the dependency value both create-ui-spec transport adapters pass to the
 * core producer. The ONLY adapter dependency constructor.
 *
 * @param reader the active `CorpusReader` — a `PrivateCorpusReader` in private
 *   mode (current behavior preserved) or a `PublicCorpusReader` in public mode.
 *   Injected VERBATIM; this function never wraps, filters, or substitutes it,
 *   and never constructs a reader of its own. Mode isolation is the reader's
 *   property, so an adapter cannot get a wider view by choosing a different
 *   dependency constructor.
 * @param now optional clock, forwarded unchanged to the core for
 *   `generatedAt`. Omitted from the returned object entirely when not supplied,
 *   so the core's own `new Date()` default applies exactly as before.
 * @param model explicit proposal-path state. Defaults to `not-configured`, so
 *   existing deterministic callers retain their envelope shape and identity.
 *
 * @returns dependencies whose `resolveReferenceToken` implements the single
 *   explicit-reference policy documented at the top of this module.
 */
export function makeCreateUiSpecDependencies(
  reader: CorpusReader,
  now?: () => Date,
  model?: CreateUiSpecModelDependency,
): CreateUiSpecDependencies {
  return {
    reader,
    /**
     * The single explicit-reference policy. Recognizes ONLY ids the active
     * reader already exposes; returns the token itself so the core can hash it
     * into the opaque `ref-<sha256>` citation. Any thrown reader failure
     * propagates untouched — the core wraps it as RETRIEVAL_UNAVAILABLE with a
     * safe message, so catching it here would only risk re-surfacing the raw
     * error text (which can carry a path) through a second channel.
     */
    resolveReferenceToken: (token: string): string | undefined =>
      reader.getById(token) !== undefined ? token : undefined,
    ...(now !== undefined ? { now } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}
