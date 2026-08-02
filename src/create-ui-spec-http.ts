/**
 * create-ui-spec-http.ts — the `create_ui_spec` loopback HTTP transport adapter
 * (Task 5 of the C3 slice).
 *
 * A THIN adapter, held to exactly the same three permissions as the MCP adapter:
 * parse transport input, call the sole producer, serialize a VALIDATED result. It
 * does NOT construct a `UiSpec`, assign evidence authority, sanitize a raw corpus
 * entry, render a second handoff, or author a dependency value —
 * `createUiSpecForAdapter()` in create-ui-spec.ts is the only producer and
 * `makeCreateUiSpecDependencies()` is the only dependency constructor and the
 * only explicit-reference policy.
 *
 * THE SHAPE DIFFERENCE FROM MCP, AND WHAT EACH TRANSPORT ACTUALLY ENFORCES.
 * The MCP adapter serves the standard tool envelope (`content` +
 * `structuredContent`) and validates it with `parseToolResult`, whose rule 0 is
 * the Task 1b fail-closed structural leaf gate. This adapter serves something
 * different: the parsed {@link DesignArtifactEnvelope} ITSELF, with both
 * renderings and the response-scoped evidence ids. `parseToolResult` describes a
 * shape this response does not have, so it cannot be the whole gate here. The
 * three screens below are NOT ordered by strength — they are strong on different
 * axes, and this adapter runs ALL THREE:
 *
 *   * `parseDesignArtifactEnvelope` (envelope integrity) is stronger than the
 *     MCP result schema on structure: it re-derives the handoff from the spec,
 *     re-renders both renderings, recomputes all four hashes, demands exact
 *     equality, refuses an adapter-added top-level field (`.strict()`), and
 *     sweeps every string for private corpus markers. MCP has no equivalent.
 *   * `findUnsafeCreateUiSpecLeaves` (ID shape) is the ONLY screen on either
 *     transport that enforces Global Constraints 19 and 20 — no raw corpus id,
 *     url or path in a reference position, and the evidence-id and reference-id
 *     domains kept disjoint. The envelope schema does NOT compensate for its
 *     absence: `UiSpec.citedReferences` is `z.array(z.string())`
 *     (tool-contracts.ts) and `containsPrivateMarker` is a fixed five-literal
 *     marker list, not an ID-shape rule. An earlier revision of this adapter ran
 *     only the first screen and claimed it was "STRONGER" without qualification;
 *     that was false on exactly this axis, and a producer regression emitting a
 *     raw corpus id in `spec.citedReferences` would have been refused over MCP
 *     and served with 200 here.
 *   * `findCreateUiSpecCitationInconsistencies` (citation consistency) is the
 *     SHARED predicate the `create_ui_spec` descriptor's `refineEnvelope` also
 *     calls — ONE implementation, both transports, which is what makes the six
 *     rules below non-divergent by construction rather than by two lists that
 *     have to be kept in step.
 *
 * THE SIX CITATION RULES, AND WHY THEY ARE HERE NOW. `refineEnvelope` is invoked
 * only from `makeEnvelope`, reachable only through `parseToolResult` — so
 * anything written inline THERE is an MCP-only rule, and this adapter cannot use
 * `parseToolResult` at all (it serves a different shape). Its ID-SHAPE subset was
 * recovered by the leaf gate above; its CITATION-CONSISTENCY subset was NOT, even
 * though every input those six rules read is present in the body this route
 * serves:
 *
 *   1. `citedReferences must be unique`
 *   2. `techniques[].sourceIds[]` must be members of `citedReferences`
 *   3. `antiPatterns[].sourceIds[]` must be members of `citedReferences`
 *   4. `componentInventory[].sourceId` must be a member of `citedReferences`
 *   5. `provenance.sourceReferences must be unique`
 *   6. `provenance.sourceReferences` must equal `citedReferences` as sets
 *
 * A producer regression emitting `techniques[0].sourceIds = ["ref-<sha>"]` where
 * the digest is well-formed but absent from `spec.citedReferences`, or a
 * `provenance.sourceReferences` that disagrees with `citedReferences`, was
 * REFUSED over MCP and SERVED WITH 200 here. No private data was at stake — the
 * leaf gate enforces `ref-<sha256>` shape on all eight reference positions and
 * `containsPrivateMarker` sweeps the whole body — but PROVENANCE INTEGRITY was: a
 * design artifact whose technique claims a source the artifact does not cite,
 * shipped to a browser. Two independent reviewers rated that P1, so the six were
 * extracted into the shared predicate and are now enforced HERE TOO, as
 * validation-that-refuses. All six are measured, not assumed, in
 * create-ui-spec-http.test.ts's `I3(r5) closed` block, which proves for each rule
 * that `parseDesignArtifactEnvelope` accepts the poison, that the leaf gate
 * ignores it, that MCP refuses for that exact rule, and that this route now
 * refuses it too.
 *
 * WHAT STILL DIFFERS, AND WHY THAT IS STRUCTURAL RATHER THAN A GAP.
 * `refineEnvelope` retains the rules that read the TOOL ENVELOPE's `evidence[]`
 * ROWS — evidence-ID membership, the evidence-KIND authority prerequisites, the
 * lane/kind agreement rules and the warning-coupling rules. This surface
 * publishes no evidence rows and no warnings array of its own (the envelope
 * carries `publicEvidenceIds` only), so those rules have no inputs here: they are
 * inapplicable, not skipped. `UiSpec.superRefine` DOES reach this transport (the
 * envelope declares `spec: UiSpec`) and covers `citedDecisions[].sourceId`
 * membership, the citedDecision authority prerequisites and the two
 * lane-membership rules; the envelope schema covers `publicEvidenceIds`
 * uniqueness and the `provenance.evidenceIds` element-for-element binding.
 *
 * THE TWO ADJUDICATED EXCEPTIONS ARE UNCHANGED AND NARROW: the
 * retrieval-projection ruling is about `retrieval.resultCount` (this surface
 * serves the corpus-scoped count, unreshaped), and the ID-shape parity ruling is
 * about the leaf gate. Neither ever covered the six.
 *
 * EVERY SCREEN HERE VALIDATES AND REFUSES; none rewrites. That matters,
 * because this surface serves the PERSISTED envelope and must not reshape it
 * (the separately adjudicated reason it does not call the MCP retrieval
 * projection). A gate that throws changes no byte on the success path.
 *
 * IT RUNS ON THE SERVED BYTES, NOT THE OBJECT. {@link handleCreateUiSpecHttp}
 * serializes the envelope to JSON, re-parses that STRING, and validates the
 * result. A field that survives `JSON.stringify` but not the schema, or a value
 * that changes across the serialization round trip, is therefore caught on the
 * exact bytes the route writes. The response body returned from here is that
 * same already-validated string; the caller writes it verbatim.
 *
 * WHAT THE ENVELOPE DOES *NOT* SCREEN — the same residual the MCP adapter
 * documents, restated because this surface publishes the same fields. The
 * private-marker sweep is a fixed marker/path check, not a prose screen: free
 * text that reaches `spec.designDirection`, a decision `rationale`, or an
 * evidence `summary` is unscreened for product identities, bare hostnames,
 * real corpus-id shapes and critique prose. That residual is a PRODUCER
 * property, accepted as "intended, not enforced". This adapter neither widens
 * nor narrows it: it publishes `spec` exactly as the producer validated it, and
 * publishes NO field the MCP surface does not already publish. It notably does
 * NOT publish the `sanitizedEvidence` ROWS (`evidence[].summary` and friends) —
 * the envelope carries only `publicEvidenceIds`, so the one field named in the
 * known residual has strictly LESS reachability here than over MCP.
 *
 * WHAT NEVER REACHES THIS SURFACE. `ResolvedEvidence.omittedReferenceTokens`
 * holds the caller's RAW refused tokens; it is deliberately not read here and has
 * no output field. There is no per-token success list, count, or ordering signal
 * beyond what `spec.citedReferences` (unsalted digests of the caller's own
 * tokens) already implies — a reviewed, accepted bounded property of the
 * explicit-reference policy which this adapter must not amplify. The caller's
 * `productContext` brief is likewise never echoed: it reaches the producer and
 * nothing else, and this module logs nothing at all (see below).
 *
 * THIS MODULE NEVER LOGS. Not the brief, not a request field, not an exception.
 * The bounded typed error is the ONLY thing that leaves on the failure path, and
 * nothing derived from an exception's text reaches it (see
 * create-ui-spec-transport-errors.ts). A `console.*` call here would put the
 * caller's brief into the operator's terminal, which is exactly the "client state
 * only" constraint this task carries.
 *
 * NO NETWORK, NO PAID PROVIDER. The only dependency is the injected
 * `CorpusReader`; nothing here opens a socket or reads a provider credential.
 */
import type { CorpusReader } from "./corpus-reader.js";
import {
  createUiSpecForAdapter,
  type CreateUiSpecModelDependency,
} from "./create-ui-spec.js";
import { makeCreateUiSpecDependencies } from "./create-ui-spec-dependencies.js";
import {
  containsPrivateMarker,
  parseDesignArtifactEnvelope,
  type DesignArtifactEnvelope,
} from "./create-ui-spec-contracts.js";
import {
  createUiSpecTransportError,
  mapCoreErrorToTransportError,
  type CreateUiSpecTransportError,
  type CreateUiSpecTransportErrorCode,
} from "./create-ui-spec-transport-errors.js";
import {
  CreateUiSpecInput,
  findCreateUiSpecCitationInconsistencies,
  findUnsafeCreateUiSpecLeaves,
} from "./tool-contracts.js";

/**
 * The HTTP request contract: the CORE request fields and NO `outputFormat`.
 *
 * Derived from the shared {@link CreateUiSpecInput} by omission rather than
 * hand-written, so the two transports cannot drift on a field name or a bound —
 * and `CreateUiSpecInput` itself is already pinned field-for-field against
 * `CreateUiSpecRequestSchema` by the drift gate in tool-contracts.test.ts.
 *
 * `outputFormat` is omitted because it would be a lie on this transport: the
 * response carries BOTH renderings, so there is nothing for a format selector to
 * select. It is REJECTED rather than ignored (the schema stays strict), for the
 * same reason every other unknown key is: an accepted-and-discarded field is an
 * un-auditable contract. Strictness is also what refuses browser-supplied
 * screenshots, provider configuration and credential-shaped fields in the body.
 */
export const CreateUiSpecHttpRequestSchema = CreateUiSpecInput.omit({
  outputFormat: true,
}).strict();

/** The HTTP status each transport error code is served with. */
const ERROR_STATUS: Readonly<Record<CreateUiSpecTransportErrorCode, 400 | 503>> = Object.freeze({
  // Caller-fixable: the request itself was not acceptable.
  INVALID_INPUT: 400,
  // Retryable and not the caller's fault: assembly could not run right now.
  PROVIDER_ERROR: 503,
});

/**
 * What the route writes. `body` is the EXACT, already-validated JSON string —
 * the caller must not re-serialize it, because the validation was performed on
 * these bytes.
 */
export interface CreateUiSpecHttpResult {
  readonly status: 200 | 400 | 503;
  readonly contentType: "application/json; charset=utf-8";
  readonly body: string;
}

/**
 * Handle one `POST /api/create-ui-spec` request body.
 *
 * @param rawBody the parsed JSON request body, untrusted. Validated through
 *   {@link CreateUiSpecHttpRequestSchema}; its zod issues are NEVER forwarded,
 *   because they echo the caller's own values (including the brief).
 * @param reader the active `CorpusReader`, injected. This adapter never
 *   constructs one and never imports corpus.ts or a global index, so mode
 *   isolation is entirely the injected reader's property.
 * @param now optional clock, forwarded unchanged to the ONE dependency
 *   constructor (used by tests to pin `generatedAt`; production omits it so the
 *   core's own `new Date()` applies).
 *
 * @throws Error when the envelope about to be served fails ANY of the serve-time
 * gates — the ID-shape gate, the citation-consistency gate, the envelope
 * integrity re-check, the key-set check, or the private-marker sweep. Every one of
 * them is a producer or adapter DEFECT, not caller error, so the response is
 * refused rather than dressed up as a typed caller-facing failure. The thrown
 * message names only structural positions or fixed rule ids; it never reproduces a
 * value, the caller's brief, or raw exception text. The route
 * (scripts/ui-server.ts) maps every one of them to the SAME bounded
 * `createUiSpecIntegrityRefusalError()` — a NON-retryable `PROVIDER_ERROR` served
 * with 503 — so a caller cannot tell the gates apart, and none of them tells it to
 * retry a request that is deterministically refused.
 */
export async function handleCreateUiSpecHttp(
  rawBody: unknown,
  reader: CorpusReader,
  now?: () => Date,
  model?: CreateUiSpecModelDependency,
): Promise<CreateUiSpecHttpResult> {
  // ----- 1. Transport input -----
  const parsed = CreateUiSpecHttpRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResult(createUiSpecTransportError("INVALID_INPUT"));
  }

  // Only the core request fields, mapped EXPLICITLY (not spread) so a future
  // transport-only field added to CreateUiSpecInput cannot silently reach the
  // core — the same discipline the MCP adapter applies.
  const request: Record<string, unknown> = {
    productContext: parsed.data.productContext,
    referenceIds: parsed.data.referenceIds,
    constraints: parsed.data.constraints,
    motionIntents: parsed.data.motionIntents,
    ...(parsed.data.platform !== undefined ? { platform: parsed.data.platform } : {}),
    ...(parsed.data.implementationFramework !== undefined
      ? { implementationFramework: parsed.data.implementationFramework }
      : {}),
    ...(parsed.data.designSystem !== undefined ? { designSystem: parsed.data.designSystem } : {}),
    ...(parsed.data.target !== undefined ? { target: parsed.data.target } : {}),
    ...(parsed.data.colorIntent !== undefined ? { colorIntent: parsed.data.colorIntent } : {}),
    ...(parsed.data.typeIntent !== undefined ? { typeIntent: parsed.data.typeIntent } : {}),
  };

  // ----- 2. The sole producer, through the ONE dependency constructor -----
  let produced: Awaited<ReturnType<typeof createUiSpecForAdapter>>;
  try {
    produced = await createUiSpecForAdapter(
      request,
      makeCreateUiSpecDependencies(reader, now, model),
    );
  } catch (err) {
    // Nothing derived from `err` is logged or published — the shared mapping
    // discards untyped text entirely.
    return errorResult(mapCoreErrorToTransportError(err));
  }

  // ----- 3. Serialize (no reinterpretation) and validate the SERVED BYTES -----
  // `sanitizedEvidence` is deliberately NOT read: the envelope publishes the
  // response-scoped ids, and adding the rows would both break the envelope's
  // strict shape and widen the `evidence[].summary` residual on this surface.
  const body = serializeEnvelope(produced.envelope);
  assertServedBytesAreEnvelope(body, produced.envelope);

  return { status: 200, contentType: JSON_CONTENT_TYPE, body };
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8" as const;

/**
 * Serialize the producer's envelope. `JSON.stringify` over the parsed envelope
 * object and nothing else — no field is added, renamed, reordered by hand,
 * trimmed, or re-rendered.
 */
function serializeEnvelope(envelope: DesignArtifactEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * The serve-time gate. Runs on the STRING about to be written, not on the
 * in-memory object:
 *
 *  1. the ID-SHAPE gate (`findUnsafeCreateUiSpecLeaves`) over the served
 *     `spec` — the same function and the same position table the MCP adapter
 *     reaches through `parseToolResult`, so Global Constraints 19 and 20 hold
 *     identically on both transports. It runs FIRST and on the raw re-parsed
 *     value, so an unsafe reference is reported as what it is rather than as a
 *     downstream hash mismatch.
 *  2. the CITATION-CONSISTENCY gate
 *     (`findCreateUiSpecCitationInconsistencies`) over the same re-parsed
 *     `spec` — the same predicate the descriptor's `refineEnvelope` calls, so
 *     the six citation rules hold identically on both transports. It runs after
 *     the ID-shape gate for the same reason that gate runs first: membership is
 *     only meaningful once shape holds.
 *  3. `parseDesignArtifactEnvelope` over the re-parsed bytes — schema (including
 *     the strict shape, so an adapter-added field is refused), handoff
 *     reconstruction, both re-renders, all four hashes, and the private-marker
 *     sweep.
 *  4. the served key set is exactly the producer envelope's, asserted directly
 *     so the "no adapter-added envelope field" property does not rest solely on
 *     the schema staying strict.
 *  5. a final `containsPrivateMarker` sweep over the whole serialized body. The
 *     envelope's own superRefine already walks its strings, so on the production
 *     path this is a no-op; it exists so the served bytes are not an unguarded
 *     position if that sweep is ever narrowed.
 *
 * WHY `spec` IS THE WHOLE ID-SHAPE AND CITATION SURFACE HERE, field by field.
 * `spec` is the
 * only envelope field carrying producer-authored identifiers.
 * `publicEvidenceIds` is bound by the envelope schema to exactly
 * `spec.provenance.evidenceIds` (element for element, in order) and every element
 * is `EvidenceIdSchema`, so gating `data.provenance.evidenceIds[]` gates it too.
 * `designMarkdown` / `designJson` are re-rendered FROM the gated spec by step 3
 * and asserted byte-equal, so they cannot carry a string the spec does not.
 * `artifactId`, `assemblyRulesSha256` and the four hashes are recomputed digests;
 * `handoff` is reconstructed from the spec; `retrieval` and `warnings` are closed
 * shapes with no reference position. There is no `referenceIds` field and no
 * `evidence` rows on this transport, so those two gate roots are absent rather
 * than unchecked — the same values live at `data.citedReferences[]`.
 *
 * Refuses rather than serves. Reports POSITIONS only — the underlying integrity
 * message can legitimately name a value for in-process diagnostics, and this
 * string must not become response or log content.
 */
function assertServedBytesAreEnvelope(body: string, envelope: DesignArtifactEnvelope): void {
  const rawServed = JSON.parse(body) as unknown;

  const unsafeLeaves = findUnsafeCreateUiSpecLeaves({
    data: (rawServed as { spec?: unknown } | null)?.spec,
    // Absent on this transport (see the field-by-field note above), not skipped:
    // the values MCP publishes as `referenceIds` are `spec.citedReferences`,
    // which the `data` root walks, and there are no evidence rows here at all.
    referenceIds: undefined,
    evidence: undefined,
  });
  if (unsafeLeaves.length > 0) {
    const positions = [...new Set(unsafeLeaves.map((leaf) => leaf.position))].slice(0, 12).join(", ");
    throw new Error(
      `create_ui_spec response failed the reference/evidence ID-shape gate and was not served; offending positions: [${positions}] (values withheld)`,
    );
  }

  // The CITATION-CONSISTENCY gate, the shared predicate's other caller. Runs on
  // the same re-parsed value and immediately after the ID-shape gate, because
  // membership is only meaningful once shape holds: a raw corpus id in
  // `citedReferences` should be reported as an unsafe reference, not as a dangling
  // citation link. Its own message names its own gate and the stable rule ids, so a
  // refusal here is never confusable with an ID-shape or hash refusal (and never
  // reproduces a value — the rule ids are fixed literals).
  const citationViolations = findCreateUiSpecCitationInconsistencies(
    (rawServed as { spec?: unknown } | null)?.spec,
  );
  if (citationViolations.length > 0) {
    const rules = [...new Set(citationViolations.map((violation) => violation.rule))].join(", ");
    throw new Error(
      `create_ui_spec response failed the citation-consistency gate and was not served; offending rules: [${rules}] (values withheld)`,
    );
  }

  let reparsed: DesignArtifactEnvelope;
  try {
    reparsed = parseDesignArtifactEnvelope(rawServed);
  } catch {
    throw new Error(
      "create_ui_spec response failed the design-artifact envelope integrity re-check and was not served (values withheld)",
    );
  }
  const servedKeys = Object.keys(reparsed).sort();
  const producedKeys = Object.keys(envelope).sort();
  if (servedKeys.length !== producedKeys.length || servedKeys.some((k, i) => k !== producedKeys[i])) {
    throw new Error(
      "create_ui_spec response key set did not match the producer envelope and was not served (values withheld)",
    );
  }
  if (containsPrivateMarker(body)) {
    throw new Error(
      "create_ui_spec response carried a private corpus marker and was not served (value withheld)",
    );
  }
}

/**
 * Build the bounded, typed error body. `{ error: { code, message, retryable } }`
 * and nothing else — no echo of the request, no `issues` array (zod issues quote
 * the caller's values), no diagnostic field. The triple itself is the SHARED
 * mapping's; this function only chooses the status and the wrapper.
 */
function errorResult(transportError: CreateUiSpecTransportError): CreateUiSpecHttpResult {
  const { code, message, retryable } = transportError;
  return {
    status: ERROR_STATUS[code],
    contentType: JSON_CONTENT_TYPE,
    body: JSON.stringify({ error: { code, message, retryable } }),
  };
}
