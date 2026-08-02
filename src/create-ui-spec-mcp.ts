/**
 * create-ui-spec-mcp.ts — the `create_ui_spec` MCP transport adapter
 * (Task 3 of the C3 slice).
 *
 * A THIN adapter. It is allowed to do exactly three things: parse transport
 * input, call the sole producer, and serialize a VALIDATED result. It does NOT
 * construct a `UiSpec`, assign evidence authority, sanitize a raw corpus entry,
 * or render a second handoff — `createUiSpecForAdapter()` in create-ui-spec.ts
 * is the only producer, `makeCreateUiSpecDependencies()` is the only dependency
 * constructor and the only explicit-reference policy, and the two projections in
 * create-ui-spec-contracts.ts are the only mappings onto the shared MCP shapes.
 *
 * THE CONTRACT GATE RUNS ON EVERY SERVED RESPONSE. `parseToolResult` (which
 * dispatches to `ToolResultSchemas.create_ui_spec`, whose rule 0 is the Task 1b
 * fail-closed structural leaf gate) validates the payload BEFORE it is returned,
 * on the success branch AND the error branch. This is deliberate and
 * load-bearing: no other registration in this repository routes its result
 * through the gate, so without this call the whole fail-closed contract would
 * run on no served response at all. A gate violation indicates a producer or
 * adapter DEFECT, not caller error, so it is raised as a bounded internal fault
 * rather than dressed up as a typed caller-facing error — the response is
 * refused, never served.
 *
 * WHAT THE LEAF GATE ACTUALLY SCREENS, AND WHAT IT DOES NOT. The Task 1b leaf
 * gate walks `data` / `referenceIds` / `evidence` and checks each string leaf
 * against ID/path/domain SHAPE patterns (fail-closed default) — it does not
 * screen prose, in any position. A free-text field under `data` (e.g.
 * `spec.designDirection`) is exactly as unscreened by the gate as
 * `content[0]` is; relocating text under `data` does not bring it under gate
 * authority. So `structuredContent`'s actual protections are (1) the gate's
 * shape screen on the positions it walks, and (2) the envelope's own
 * `.strict()` shape, which stops this adapter introducing an untaught
 * top-level field.
 *
 * `content[0].text` is `renderDesignHandoffMarkdown`/`renderDesignHandoffJson`
 * over `parseDesignHandoff({ spec, target, motionIntents, generatedAt })`
 * (see create-ui-spec.ts), and `parseDesignArtifactEnvelope` re-derives both
 * renderings from those same four inputs and demands byte equality against
 * the stored hashes before the envelope is accepted. `target` is a closed
 * enum resolved to producer constants. So `content[0]` cannot carry anything
 * that is not derivable from spec + closed enum + caller motionIntents + a
 * timestamp — producer-derived corpus content can reach `content[0]` ONLY via
 * `spec`, and if it does, the same string is simultaneously present in
 * `structuredContent.data`. There is no corpus-data channel unique to the
 * rendering.
 *
 * The one input that genuinely reaches `content[0]` and nowhere else is
 * caller-supplied `handoff.motionIntents`: it is rendered into `content[0]`
 * but never copied into `spec` (`spec.motionGuidance` is hardcoded
 * `{ notes: [], evidenceUnavailable: true }` in create-ui-spec.ts). Its
 * fields are unbounded strings, not walked by the leaf gate, and screened
 * only by the same `containsPrivateMarker` sweep
 * ({@link assertRenderingIsServable}) that covers the rest of the rendering —
 * no length bound beyond an 8-entry cap. It is not a leak, because it is the
 * caller's own request data reflected back to the caller, not corpus data —
 * but it is the one served position with no walker and no length bound, and
 * it is worth naming so nobody assumes `structuredContent`'s gate coverage
 * extends to it.
 *
 * WHAT NEVER REACHES A SURFACE. `ResolvedEvidence.omittedReferenceTokens` holds
 * the caller's RAW refused tokens; it is deliberately not read here and has no
 * output field. There is no per-token success list, count, or ordering signal
 * beyond what `citedReferences` (the unsalted digests of the caller's own
 * tokens) already implies — a reviewed and accepted bounded property of the
 * explicit-reference policy, which this adapter must not amplify.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CorpusReader } from "./corpus-reader.js";
import {
  createUiSpecForAdapter,
  type CreateUiSpecModelDependency,
} from "./create-ui-spec.js";
import { makeCreateUiSpecDependencies } from "./create-ui-spec-dependencies.js";
import {
  projectSanitizedEvidenceToMcpEvidence,
  projectRetrievalStateForTransport,
  containsPrivateMarker,
  type DesignArtifactEnvelope,
} from "./create-ui-spec-contracts.js";
import {
  createUiSpecTransportError,
  mapCoreErrorToTransportError,
  type CreateUiSpecTransportError,
} from "./create-ui-spec-transport-errors.js";
import { CreateUiSpecInput, parseToolResult } from "./tool-contracts.js";

/** The MCP tool result this adapter serves. No field beyond these three. */
export interface CreateUiSpecMcpResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

/**
 * The bounded success summary. A FIXED constant: the summary position is a
 * top-level envelope field the leaf gate does not walk, so it must not be
 * assembled from anything. It carries no brief, path, url, corpus id, product
 * identity or provider diagnostic — and no retrieval/reference count, which
 * would add a signal beyond `retrieval` and `referenceIds`.
 */
const OK_SUMMARY = "Design spec produced from the deterministic assembly recipe.";

/** The bounded error summary. Fixed for the same reason as {@link OK_SUMMARY}. */
const ERROR_SUMMARY = "No design spec was produced.";

// The transport error codes this tool may publish — exactly the descriptor's
// `errorCodes` for create_ui_spec — along with the fixed fallback messages, the
// core→transport code mapping and the retryable flag, all live in
// create-ui-spec-transport-errors.ts, shared with the loopback HTTP adapter so
// the two transports cannot drift on any of the three error decisions. Only the
// MCP-shaped ENVELOPE around the triple ({@link errorResult}) is owned here.

/**
 * The retrieval block an error envelope carries. `none/none` with
 * `resultCount: 0` is the only state the shared envelope permits on the error
 * branch (rule 2: `status "error" requires resultCount 0`), and `none/none` is
 * one of the create_ui_spec descriptor's declared states. Nothing is inferred
 * from the failed call.
 */
const ERROR_RETRIEVAL = Object.freeze({
  mode: "none" as const,
  modality: "none" as const,
  resultCount: 0,
  fallbackUsed: false,
  attemptedCount: 0,
  attemptedModes: [] as readonly string[],
});

/**
 * Register the `create_ui_spec` beta tool. Uses the same direct
 * `server.registerTool` style as the other registrations in server-factory.ts.
 *
 * `inputSchema` is the shared {@link CreateUiSpecInput} itself rather than a
 * hand-written mirror, so the served JSON Schema in `tools/list` and the
 * adapter's own parse cannot drift from the contract (the mirror against the
 * core request schema is already pinned by the drift gate in
 * tool-contracts.test.ts). The SDK validates arguments against it before the
 * handler runs; {@link handleCreateUiSpec} re-parses with the SAME schema so a
 * direct in-process caller gets the typed envelope rather than an untyped throw.
 *
 * No `outputSchema` is declared: the shared result envelope is a refined
 * (effect-wrapped) schema that the SDK cannot normalize into an object schema,
 * and `parseToolResult` — which applies ALL of the envelope's refinements,
 * including the fail-closed leaf gate — is the real validation.
 */
export function registerCreateUiSpec(
  server: McpServer,
  reader: CorpusReader,
  model?: CreateUiSpecModelDependency,
): void {
  server.registerTool(
    "create_ui_spec",
    {
      title: "Create an evidence-grounded UI design spec",
      description:
        "Describe what you're building and receive a structured, evidence-grounded UI " +
        "design spec: layout regions, color and typography tokens, component inventory, " +
        "motion guidance, acceptance criteria with named verifiers (axe, playwright, " +
        "static-analysis, manual), and provenance. Every decision is traced to a " +
        "response-scoped evidence id. Pass referenceIds (max 5) to ground the spec in " +
        "specific references you already know; a reference that cannot be resolved is " +
        "omitted, and a request whose references ALL fail is rejected rather than " +
        "silently substituted. outputFormat:'json' returns the JSON rendering instead " +
        "of markdown; the structured result is identical either way. No corpus content, " +
        "path, url or product identity is ever returned — corpus grounding appears only " +
        "as opaque evidence ids.",
      inputSchema: CreateUiSpecInput,
    },
    async (args) => {
      // Spread into a fresh object literal: the SDK's CallToolResult carries an
      // index signature, which a declared interface does not satisfy. This keeps
      // {@link CreateUiSpecMcpResult} strict (no `[key: string]: unknown` escape
      // hatch that would let a stray field in) without a cast. The key set is
      // asserted at runtime in create-ui-spec-mcp.test.ts.
      const result = await handleCreateUiSpec(args, reader, model);
      return { ...result };
    },
  );
}

/**
 * The adapter handler. Exported so it can be exercised without a transport (and
 * so the SDK's own argument validation is not the only input gate).
 *
 * @throws Error when the assembled result fails the contract gate or the served
 * rendering fails the private-marker screen — a producer/adapter defect. The
 * thrown message names only structural positions; it never reproduces a value,
 * the caller's brief, or raw exception text.
 */
export async function handleCreateUiSpec(
  rawArgs: unknown,
  reader: CorpusReader,
  model?: CreateUiSpecModelDependency,
  now?: () => Date,
): Promise<CreateUiSpecMcpResult> {
  // ----- 1. Transport input -----
  const parsedInput = CreateUiSpecInput.safeParse(rawArgs);
  if (!parsedInput.success) {
    // The zod issues are NOT forwarded: they can echo the caller's own values.
    return errorResult(createUiSpecTransportError("INVALID_INPUT"));
  }
  // `outputFormat` is ADAPTER-LOCAL presentation selection and is deliberately
  // destructured away here: the core request contract has no such field, and
  // mapping it through would be rejected by the core's strict schema.
  const { outputFormat, ...transport } = parsedInput.data;

  // Only the core request fields, mapped EXPLICITLY (not spread) so a future
  // MCP-only field added to CreateUiSpecInput cannot silently reach the core.
  const request: Record<string, unknown> = {
    productContext: transport.productContext,
    referenceIds: transport.referenceIds,
    constraints: transport.constraints,
    motionIntents: transport.motionIntents,
    ...(transport.platform !== undefined ? { platform: transport.platform } : {}),
    ...(transport.implementationFramework !== undefined
      ? { implementationFramework: transport.implementationFramework }
      : {}),
    ...(transport.designSystem !== undefined ? { designSystem: transport.designSystem } : {}),
    ...(transport.target !== undefined ? { target: transport.target } : {}),
    ...(transport.colorIntent !== undefined ? { colorIntent: transport.colorIntent } : {}),
    ...(transport.typeIntent !== undefined ? { typeIntent: transport.typeIntent } : {}),
  };

  // ----- 2. The sole producer -----
  let produced: Awaited<ReturnType<typeof createUiSpecForAdapter>>;
  try {
    const dependencies = model === undefined && now === undefined
      ? makeCreateUiSpecDependencies(reader)
      : makeCreateUiSpecDependencies(reader, now, model);
    produced = await createUiSpecForAdapter(request, dependencies);
  } catch (err) {
    return mapCoreError(err);
  }
  const { envelope, sanitizedEvidence } = produced;

  // ----- 3. Serialize (no reinterpretation) -----
  const payload: Record<string, unknown> = {
    tool: "create_ui_spec",
    schemaVersion: "1.0",
    status: "ok",
    summary: OK_SUMMARY,
    // The validated UiSpec, NOT the artifact envelope.
    data: envelope.spec,
    // `citedReferences` ONLY. Response-scoped evidence ids (`evidence-N`) are a
    // separate domain and never become referenceIds.
    referenceIds: [...envelope.spec.citedReferences],
    // The producer's real retrieval state, through the ONE shared mapping (which
    // re-scopes only `resultCount` to the documented artifact count).
    retrieval: projectRetrievalStateForTransport(envelope),
    // Copied from the parsed envelope, not reinterpreted.
    warnings: envelope.warnings.map((w) => ({ code: w.code, message: w.message })),
    // The ONE safe projection of the producer's own sanitized rows.
    evidence: projectSanitizedEvidenceToMcpEvidence(sanitizedEvidence),
  };

  assertPassesContractGate(payload);
  const rendering = selectRendering(envelope, outputFormat);
  assertRenderingIsServable(rendering);

  return {
    content: [{ type: "text", text: rendering }],
    structuredContent: payload,
  };
}

/**
 * Pick the producer's rendering for the requested presentation format. Returns
 * the envelope's own string — byte-identical, from the same producer
 * invocation. Nothing is re-rendered, re-serialized, trimmed or concatenated.
 */
function selectRendering(envelope: DesignArtifactEnvelope, outputFormat: "markdown" | "json"): string {
  return outputFormat === "json" ? envelope.designJson : envelope.designMarkdown;
}

/**
 * Run the fail-closed contract gate on a payload about to be served. Refuses
 * rather than serves.
 *
 * The gate's issue MESSAGES are not reproduced: some of them legitimately name
 * the offending value for diagnostics inside the process (e.g. the ID-domain
 * checks), and this string becomes tool output. Only the structural POSITIONS
 * are reported, which is enough to locate an adapter defect.
 */
function assertPassesContractGate(payload: Record<string, unknown>): void {
  const gate = parseToolResult(payload);
  if (gate.ok) return;
  const positions = [...new Set(gate.errors.map((e) => e.split(":")[0]!.trim()).filter((p) => p.length > 0))]
    .slice(0, 12)
    .join(", ");
  throw new Error(
    `create_ui_spec result failed the contract gate and was not served; offending positions: [${positions}] (values withheld)`,
  );
}

/**
 * Restate the envelope's private-marker screen on the ONE served string the leaf
 * gate does not walk. `parseDesignArtifactEnvelope` already applied this over
 * every envelope string, so on the production path this is a no-op; it exists so
 * the served rendering is not an unguarded position if that sweep is ever
 * narrowed.
 */
function assertRenderingIsServable(rendering: string): void {
  if (rendering.length === 0) {
    throw new Error("create_ui_spec rendering was empty and was not served");
  }
  if (containsPrivateMarker(rendering)) {
    throw new Error(
      "create_ui_spec rendering carried a private corpus marker and was not served (value withheld)",
    );
  }
}

/**
 * Map a thrown producer failure onto the standard MCP error envelope.
 *
 * The core→transport decision (code, bounded message, retryable) is the SHARED
 * {@link mapCoreErrorToTransportError}; this function only wraps the resulting
 * triple in the MCP envelope. See create-ui-spec-transport-errors.ts for why the
 * decision is shared and the envelope is not.
 */
function mapCoreError(err: unknown): CreateUiSpecMcpResult {
  return errorResult(mapCoreErrorToTransportError(err));
}

/**
 * Build the standard error envelope. Shape is exactly what the shared envelope's
 * error branch requires: `data: null`, empty `referenceIds`, empty `evidence`,
 * empty `warnings`, `none/none` retrieval with `resultCount: 0`, and the
 * `code`/`message`/`retryable` triple exactly as the shared mapping produced it
 * (the retryable flag is the shared `ERROR_RETRYABLE` table's, so a code and its
 * retryability cannot drift). Gate-validated before it is served, exactly like a
 * success result.
 */
function errorResult(transportError: CreateUiSpecTransportError): CreateUiSpecMcpResult {
  const { code, message, retryable } = transportError;
  const payload: Record<string, unknown> = {
    tool: "create_ui_spec",
    schemaVersion: "1.0",
    status: "error",
    summary: ERROR_SUMMARY,
    data: null,
    referenceIds: [],
    retrieval: { ...ERROR_RETRIEVAL, attemptedModes: [] },
    warnings: [],
    evidence: [],
    error: { code, message, retryable },
  };
  assertPassesContractGate(payload);
  return {
    content: [{ type: "text", text: message }],
    structuredContent: payload,
    isError: true,
  };
}
