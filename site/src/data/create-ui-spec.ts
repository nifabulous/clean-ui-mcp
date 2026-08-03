/**
 * create-ui-spec.ts — the browser-side client for the loopback
 * `POST /api/create-ui-spec` route (C3 Task 6).
 *
 * WHAT THIS MODULE IS ALLOWED TO DO. Obtain the process-local CSRF nonce, send
 * one bounded brief to the same-origin loopback route, CHECK the response shape,
 * and project the checked response onto an explicit display-safe view. It never
 * assembles a `UiSpec`, never imports the corpus, never reads a credential, and
 * never opens a request to anything but a relative `/api/*` path.
 *
 * THE RESPONSE IS UNTRUSTED UNTIL ITS SHAPE IS CHECKED. The server runs a
 * fail-closed gate before serving, and that gate screens ID and PATH *shape* —
 * it is not a prose screen. So two things follow, and both are implemented here:
 *
 *  1. This client re-checks the shape it depends on, positively: the artifact
 *     version literal, four 64-hex digests, both rendering strings, a non-empty
 *     list of `evidence-<n>` ids, the retrieval block's numeric/boolean fields,
 *     and the shape of every row it renders. A response that fails any of these
 *     is refused WHOLE — there is no partial render, because a half-checked
 *     artifact is exactly the thing the operator would mistake for a result.
 *
 *  2. The RENDERED fields are an ALLOWLIST PROJECTION, not a scrub. The
 *     display-safe half of {@link SafeArtifact} — `designDirection`, `decisions`,
 *     `acceptanceCriteria`, `warnings`, `unavailableDecisions`, `evidence` — is
 *     built field by field from checked positions, so a field the producer adds
 *     later cannot reach a rendered element by default: it simply is not on the
 *     projected object. None of `sourceId`, `sourceIds`, `sourceReferences`,
 *     `citedReferences`, `evidenceIds`, `provenance`, `componentInventory`, an
 *     image path, or a screenshot is projected.
 *
 *     WHAT THE PROJECTION DOES *NOT* COVER, stated exactly. `designMarkdown` and
 *     `designJson` are carried through WHOLE and unprojected — they are the
 *     server's own renderings, and the download guarantee requires the exact
 *     bytes. `renderDesignHandoffMarkdown` (src/design-handoff.ts) renders
 *     `spec.context.productContext`, `spec.citedReferences`, the target profile's
 *     `sourceId` + URL lines, and `spec.techniques[].text`,
 *     `spec.antiPatterns[].text` and `spec.componentInventory` — i.e. fields this
 *     projection deliberately does not read. So these two strings are
 *     DOWNLOAD/CLIPBOARD PAYLOADS ONLY. No caller may render them into the DOM,
 *     and the composer does not: the copy control writes them to the clipboard and
 *     falls back to pointing at the download, never to printing the value as
 *     selectable text. Treating them as displayable would defeat (2) entirely.
 *
 * `spec.context.productContext` echoes the CALLER'S OWN brief. That is the
 * operator's data, not corpus content, and it is still dropped. The explicit
 * `colorIntent` / `typeIntent` fields are the exception: they are projected from
 * checked `context` positions so the operator can see what was recorded, with no
 * parallel copy taken from `handoff`. `designDirection` IS projected: it is the
 * producer's direction statement and the design names it as displayable. It is
 * producer free text, so this module makes no claim to have screened its prose;
 * the only prose claim made anywhere in this client is about ID/path SHAPE.
 *
 *  NO SERVER FREE TEXT ON THE FAILURE PATH. The route's bounded error body carries
 *  a `message`. It is deliberately never surfaced: failures are described by a
 *  CLIENT-authored code ({@link CreateUiSpecFailureCode}) that the UI turns into
 *  its own copy. A server string cannot become UI copy through this module.
 *
 *  THE OPTIONAL MODEL LANE. The served envelope may carry `modelExecution` beside
 *  the artifact and `spec.modelProposal` inside it. Both project through the same
 *  closed-shape discipline: `modelExecution` reduces to `{ state }` — plus
 *  `provider`/`model` on `succeeded`, where `provider` must be one of the six
 *  server-side provider enum values (a URL-shaped, marker-bearing or secret-shaped
 *  value is then impossible by construction) and `model` is refused when it
 *  carries a private marker or a URL/path form (a URL-shaped value in a machine
 *  identifier position is never a legal display value). The proposal reduces to
 *  its five bounded content positions plus the FIXED disclaimer literal: a served
 *  disclaimer that differs from the constant REFUSES the response, and the
 *  rendered string is always the constant. Execution digests, `reproducibility`,
 *  `usage`, and every unknown execution field are never read. The proposal's
 *  prose positions are screened for the same private-corpus markers the server's
 *  envelope gate refuses on (see {@link PRIVATE_MARKERS_MIRROR}) — a marker
 *  refuses the response, exactly like the evidence-id shape check, because the
 *  client re-checks what the server's fail-closed gate screens rather than
 *  trusting that it ran. The client makes NO other prose claim about proposal
 *  content, matching the deterministic lane's `designDirection`.
 *
 * NO PERSISTENCE, NO ANALYTICS. The nonce lives in a module-scope variable for
 * the life of the page. Nothing is written to `localStorage`, `sessionStorage`,
 * `document.cookie`, or any analytics sink, and this module logs nothing at all —
 * a `console.*` call here would put the operator's brief in the devtools console.
 */

// ---------------------------------------------------------------------------
// Request contract — mirrors CreateUiSpecHttpRequestSchema's bounds.
// ---------------------------------------------------------------------------

/** The CSRF header name the loopback server requires on every mutating call. */
export const CSRF_HEADER = "X-Clean-UI-CSRF";

/** Same-origin, relative paths. Never an absolute origin. */
const CSRF_PATH = "/api/csrf";
const CREATE_UI_SPEC_PATH = "/api/create-ui-spec";

/** `productContext` bounds, from `CreateUiSpecRequestSchema`. */
export const BRIEF_MIN_LENGTH = 8;
export const BRIEF_MAX_LENGTH = 8_000;
/**
 * `constraints`, `referenceIds` and `implementationFramework` bounds. Only the
 * COUNT limits are exported — the composer shows them as hints. The per-item
 * length limits are enforced by {@link briefValidationMessage} and have no caller
 * outside this module, so they stay private rather than becoming unused surface.
 */
export const MAX_CONSTRAINTS = 12;
const MAX_CONSTRAINT_LENGTH = 500;
export const MAX_REFERENCE_IDS = 5;
const MAX_REFERENCE_ID_LENGTH = 200;
const MAX_FRAMEWORK_LENGTH = 120;
/** Structured design-intent text mirrors ColorIntentSchema/TypeIntentSchema. */
export const MAX_INTENT_TEXT_LENGTH = 120;
export const COLOR_CONTRAST_FLOORS = ["AA", "AAA"] as const;
export const TYPE_DENSITIES = ["compact", "regular", "spacious"] as const;

export type BriefPlatform = "web" | "mobile" | "tablet";

export interface BriefDesignSystem {
  readonly status: "none" | "identified";
  readonly registry?: string;
  readonly library?: string;
}

export type BriefColorContrastFloor = (typeof COLOR_CONTRAST_FLOORS)[number];
export type BriefTypeDensity = (typeof TYPE_DENSITIES)[number];

export interface BriefColorIntent {
  readonly accentPreference?: string;
  readonly mood?: string;
  readonly contrastFloor?: BriefColorContrastFloor;
}

export interface BriefTypeIntent {
  readonly voice?: string;
  readonly density?: BriefTypeDensity;
}

/** What the composer collects. Optional fields are omitted from the request. */
export interface DesignBrief {
  readonly productContext: string;
  readonly platform?: BriefPlatform;
  readonly implementationFramework?: string;
  readonly designSystem?: BriefDesignSystem;
  readonly constraints?: readonly string[];
  readonly referenceIds?: readonly string[];
  readonly colorIntent?: BriefColorIntent;
  readonly typeIntent?: BriefTypeIntent;
}

/**
 * Client-side validity gate. Returns an actionable message, or `null` when the
 * brief may be submitted. The server validates independently — this exists so
 * Generate can stay disabled and so an obviously-invalid brief never leaves the
 * browser, not as a substitute for the server contract.
 */
export function briefValidationMessage(brief: DesignBrief): string | null {
  const productContext = brief.productContext.trim();
  if (productContext.length < BRIEF_MIN_LENGTH) {
    return `Describe the product in at least ${BRIEF_MIN_LENGTH} characters.`;
  }
  if (productContext.length > BRIEF_MAX_LENGTH) {
    return `The brief is limited to ${BRIEF_MAX_LENGTH} characters.`;
  }
  const framework = brief.implementationFramework?.trim() ?? "";
  if (framework.length > MAX_FRAMEWORK_LENGTH) {
    return `The implementation framework is limited to ${MAX_FRAMEWORK_LENGTH} characters.`;
  }
  const constraints = brief.constraints ?? [];
  if (constraints.length > MAX_CONSTRAINTS) {
    return `Use at most ${MAX_CONSTRAINTS} constraints (one per line).`;
  }
  if (constraints.some((c) => c.length > MAX_CONSTRAINT_LENGTH)) {
    return `Each constraint is limited to ${MAX_CONSTRAINT_LENGTH} characters.`;
  }
  const referenceIds = brief.referenceIds ?? [];
  if (referenceIds.length > MAX_REFERENCE_IDS) {
    return `Use at most ${MAX_REFERENCE_IDS} explicit references (one per line).`;
  }
  if (referenceIds.some((r) => r.length > MAX_REFERENCE_ID_LENGTH)) {
    return `Each explicit reference is limited to ${MAX_REFERENCE_ID_LENGTH} characters.`;
  }
  if (new Set(referenceIds).size !== referenceIds.length) {
    return "Explicit references must be unique.";
  }
  const colorIntent = brief.colorIntent;
  if (colorIntent !== undefined) {
    for (const value of [colorIntent.accentPreference, colorIntent.mood]) {
      if (value !== undefined && value.trim().length > MAX_INTENT_TEXT_LENGTH) {
        return `Each color intent text is limited to ${MAX_INTENT_TEXT_LENGTH} characters.`;
      }
    }
    if (
      colorIntent.contrastFloor !== undefined &&
      !(COLOR_CONTRAST_FLOORS as readonly string[]).includes(colorIntent.contrastFloor)
    ) {
      return "Choose AA or AAA for the contrast floor.";
    }
  }
  const typeIntent = brief.typeIntent;
  if (typeIntent !== undefined) {
    if (typeIntent.voice !== undefined && typeIntent.voice.trim().length > MAX_INTENT_TEXT_LENGTH) {
      return `Typography intent text is limited to ${MAX_INTENT_TEXT_LENGTH} characters.`;
    }
    if (
      typeIntent.density !== undefined &&
      !(TYPE_DENSITIES as readonly string[]).includes(typeIntent.density)
    ) {
      return "Choose compact, regular, or spacious for typography density.";
    }
  }
  if (brief.designSystem?.status === "identified") {
    const registry = brief.designSystem.registry?.trim() ?? "";
    const library = brief.designSystem.library?.trim() ?? "";
    if (registry.length === 0 && library.length === 0) {
      return "An identified design system needs a registry or a library name.";
    }
  }
  return null;
}

/** Build the request body, omitting every field the operator left blank. */
function requestBodyFor(brief: DesignBrief): Record<string, unknown> {
  const body: Record<string, unknown> = { productContext: brief.productContext.trim() };
  if (brief.platform !== undefined) body.platform = brief.platform;
  const framework = brief.implementationFramework?.trim() ?? "";
  if (framework.length > 0) body.implementationFramework = framework;
  if (brief.designSystem !== undefined) {
    const designSystem: Record<string, unknown> = { status: brief.designSystem.status };
    const registry = brief.designSystem.registry?.trim() ?? "";
    const library = brief.designSystem.library?.trim() ?? "";
    // `status: "none"` must not carry registry/library (DesignSystemIdentitySchema).
    if (brief.designSystem.status === "identified") {
      if (registry.length > 0) designSystem.registry = registry;
      if (library.length > 0) designSystem.library = library;
    }
    body.designSystem = designSystem;
  }
  const constraints = brief.constraints ?? [];
  if (constraints.length > 0) body.constraints = [...constraints];
  const referenceIds = brief.referenceIds ?? [];
  if (referenceIds.length > 0) body.referenceIds = [...referenceIds];
  const colorIntent: Record<string, string> = {};
  const accentPreference = brief.colorIntent?.accentPreference?.trim() ?? "";
  const mood = brief.colorIntent?.mood?.trim() ?? "";
  if (accentPreference.length > 0) colorIntent.accentPreference = accentPreference;
  if (mood.length > 0) colorIntent.mood = mood;
  if (brief.colorIntent?.contrastFloor !== undefined) {
    colorIntent.contrastFloor = brief.colorIntent.contrastFloor;
  }
  if (Object.keys(colorIntent).length > 0) body.colorIntent = colorIntent;

  const typeIntent: Record<string, string> = {};
  const voice = brief.typeIntent?.voice?.trim() ?? "";
  if (voice.length > 0) typeIntent.voice = voice;
  if (brief.typeIntent?.density !== undefined) typeIntent.density = brief.typeIntent.density;
  if (Object.keys(typeIntent).length > 0) body.typeIntent = typeIntent;
  return body;
}

// ---------------------------------------------------------------------------
// The display-safe projection.
// ---------------------------------------------------------------------------

/** A key decision, reduced to its structured positions. No `sourceId`. */
export interface SafeDecision {
  readonly id: string;
  readonly field: string;
  readonly authority: string;
  readonly readiness: string;
}

/** An acceptance criterion, without its evidence-id links. */
export interface SafeAcceptanceCriterion {
  readonly id: string;
  readonly subject: string;
  readonly assertion: string;
  readonly expectedOutcome: string;
  readonly verifier: string;
  readonly priority: string;
}

/** A producer warning whose code is inside the closed set. */
export interface SafeWarning {
  readonly code: WarningCode;
  readonly message: string;
}

/** A field the producer could not decide, and the reason it gave. */
export interface SafeUnavailableDecision {
  readonly field: string;
  readonly reason: string;
}

/** Caller-supplied intent projected from the checked `spec.context` only. */
export interface SafeColorIntent {
  readonly accentPreference?: string;
  readonly mood?: string;
  readonly contrastFloor?: BriefColorContrastFloor;
}

/** Caller-supplied typography intent projected from the checked `spec.context` only. */
export interface SafeTypeIntent {
  readonly voice?: string;
  readonly density?: BriefTypeDensity;
}

/**
 * The AGGREGATE evidence summary — counts and closed-enum retrieval metadata
 * only. The response-scoped `evidence-<n>` ids are counted, never listed, and no
 * per-row evidence summary is requested from or served by this route.
 */
export interface EvidenceSummary {
  readonly evidenceCount: number;
  readonly retrievalMode: string;
  readonly retrievalModality: string;
  readonly corpusResultCount: number;
  readonly attemptedCount: number;
  readonly fallbackUsed: boolean;
  readonly fallbackReason: string | null;
}

/**
 * The safe projection of the served `modelExecution` position. `null` when the
 * envelope carries no model lane. `provider`/`model` exist ONLY on
 * `"succeeded"` — the failed states carry nothing but their state, so a hostile
 * value on a failed run is never read and cannot be rendered. The execution
 * digests (`promptSha256` / `parametersSha256` / `modelExecutionSha256`),
 * `reproducibility`, `usage`, and every unknown field are deliberately absent:
 * they are execution metadata, not display content.
 */
export interface SafeModelExecution {
  readonly state: ModelExecutionState;
  readonly provider?: string;
  readonly model?: string;
}

/** The five token members the model may propose for color, mirrored 1:1. */
export interface SafeModelColorTokens {
  readonly primary: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly accent: string;
}

/** The three token members the model may propose for typography. */
export interface SafeModelTypographyTokens {
  readonly heading: string;
  readonly body: string;
  readonly mono: string;
}

/**
 * The safe projection of the served `spec.modelProposal` position. `null` when
 * the envelope carries no proposal. `disclaimer` is the FIXED literal from the
 * module constant — the projection refuses a served string that differs, so the
 * rendered disclaimer can never be server text.
 */
export interface SafeModelProposal {
  readonly disclaimer: typeof MODEL_PROPOSAL_DISCLAIMER;
  readonly designDirection: string;
  readonly colorTokens: SafeModelColorTokens | null;
  readonly typographyTokens: SafeModelTypographyTokens | null;
  readonly motionNotes: readonly string[];
  readonly contentVoiceGuidance: string | null;
}

/**
 * Everything the composer may render, plus the EXACT rendering bytes the
 * response contained. Downloads read `designMarkdown` / `designJson` straight
 * off this object, so a download can never trigger a second generation (which
 * would carry a different `generatedAt`, and therefore different bytes and a
 * different `designJson`/`spec` hash, than the one the operator just reviewed —
 * the `artifactId` itself is timestamp-independent and would NOT change).
 *
 * `designMarkdown` / `designJson` are NOT projected and must never be rendered —
 * see the module header. Every other field on this object is display-safe.
 */
export interface SafeArtifact {
  readonly artifactId: string;
  readonly generatedAt: string;
  readonly producerVersion: string;
  readonly designDirection: string;
  readonly colorIntent: SafeColorIntent | null;
  readonly typeIntent: SafeTypeIntent | null;
  readonly decisions: readonly SafeDecision[];
  readonly acceptanceCriteria: readonly SafeAcceptanceCriterion[];
  readonly warnings: readonly SafeWarning[];
  /**
   * Warnings the producer emitted whose `code` is outside {@link WARNING_CODES}.
   * They are NOT rendered (an unmapped server token must not become UI copy) but
   * they ARE counted: a warned artifact stays a warned artifact, so the lifecycle
   * label cannot invert to "complete" the day the producer adds a fifth code.
   */
  readonly droppedWarningCount: number;
  readonly unavailableDecisions: readonly SafeUnavailableDecision[];
  readonly evidence: EvidenceSummary;
  /** `null` when the envelope carried no `modelExecution` (no model attached). */
  readonly modelExecution: SafeModelExecution | null;
  /** `null` when the envelope carried no `spec.modelProposal`. */
  readonly modelProposal: SafeModelProposal | null;
  readonly designMarkdown: string;
  readonly designJson: string;
  readonly specSha256: string;
  readonly semanticSpecSha256: string;
  readonly designMarkdownSha256: string;
  readonly designJsonSha256: string;
}

/**
 * The fixed proposal disclaimer, verbatim from the backend contract
 * (`src/tool-contracts.ts` `ModelProposalSchema`). The projection REFUSES a
 * served string that differs from this literal and projects THIS constant, so
 * the rendered disclaimer is always client-authored by construction — its type
 * is the literal itself.
 */
export const MODEL_PROPOSAL_DISCLAIMER = "Proposal only; not accepted into token authority.";

const MODEL_EXECUTION_STATES = [
  "invalid-configuration",
  "call-failed",
  "proposal-rejected",
  "persistence-failed",
  "succeeded",
] as const;
export type ModelExecutionState = (typeof MODEL_EXECUTION_STATES)[number];

/**
 * Mirrors the server-side provider enum (`src/create-ui-spec-model-contracts.ts`
 * `ProviderSchema`). The site is a separate build and cannot import backend src,
 * so the six literals are duplicated here. Gating on the CLOSED SET — rather
 * than shape checks — is what makes a secret-shaped or URL-shaped provider
 * value impossible by construction: the transport suites' API-key fixture
 * ("task-6-http-secret-key") and any non-enum value refuse the whole response.
 */
export const MODEL_PROVIDERS = ["openai", "claude", "gemini", "mistral", "minimax", "grok"] as const;

/**
 * Mirrors `PRIVATE_MARKERS` (`src/create-ui-spec-private-markers.ts`). The site
 * is a separate build and cannot import backend src, so the literals are
 * duplicated here and pinned by the site suite's hostile fixtures. The server's
 * envelope gate refuses the WHOLE response when any string carries one
 * (`DesignArtifactEnvelopeSchema` superRefine), so refusing here is a strict
 * mirror — the same "re-check what the fail-closed gate screens" rule as the
 * response-scoped evidence-id check.
 */
const PRIVATE_MARKERS = [
  "private-corpus-id",
  ".c2-private/",
  "/corpus/private/",
  "corpus/images-private/",
  "images-private/",
] as const;

function containsPrivateMarker(value: string): boolean {
  return PRIVATE_MARKERS.some((marker) => value.includes(marker));
}

/**
 * A URL- or path-shaped form (`scheme://`, `//`, a leading `/`, or a Windows
 * drive prefix). Applied ONLY to the model lane's machine identifiers
 * (provider/model), never to prose positions: a URL in a provider or model name
 * is never a legitimate identifier, while proposal prose may legitimately cite
 * URLs. The deterministic lane's `designDirection` is likewise rendered as-is.
 */
const URL_OR_PATH_FORM = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|\/\/|[a-zA-Z]:[\\/]|\/)/;

/** The closed warning-code set, mirroring `WarningSchema`. */
const WARNING_CODES = [
  "sparseCoverage",
  "insufficientCorpusEvidence",
  "motionEvidenceUnavailable",
  "authorityConflict",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/**
 * Client-authored failure codes. No server string ever becomes one of these.
 *
 * `LOCAL_API_UNAVAILABLE` and `CSRF_REJECTED` are deliberately DISTINCT. The
 * first means there is no loopback API on this origin at all — `GET /api/csrf`
 * answered with a non-2xx, or with a 2xx that is not the nonce document (a static
 * host's 404 page or SPA fallback). That is the state of every HOSTED copy of this
 * site, so collapsing it into `CSRF_REJECTED` told visitors "the local server may
 * have restarted" about a server that was never there. The second means the route
 * IS there and refused the nonce twice.
 */
export type CreateUiSpecFailureCode =
  | "INVALID_INPUT"
  | "PROVIDER_ERROR"
  | "LOCAL_API_UNAVAILABLE"
  | "CSRF_REJECTED"
  | "NETWORK"
  | "MALFORMED_RESPONSE";

export interface CreateUiSpecFailure {
  readonly code: CreateUiSpecFailureCode;
  readonly retryable: boolean;
}

export type CreateUiSpecResult =
  | { readonly ok: true; readonly artifact: SafeArtifact }
  | { readonly ok: false; readonly failure: CreateUiSpecFailure };

/**
 * The REAL client-observable phases. There is exactly one server round trip, so
 * the client cannot observe the producer's internal stages — inventing a ticking
 * "assembling / validating / rendering" sequence would be fabricated progress.
 * These three are the phases this module actually enters.
 */
export type LifecyclePhase = "authorizing" | "submitting" | "validating";

export interface RequestOptions {
  readonly fetchImpl?: typeof fetch;
  readonly onPhase?: (phase: LifecyclePhase) => void;
}

/**
 * The process-local nonce, cached for the life of the page. Module scope, never
 * persisted: the server mints a NEW nonce when the operator restarts it, and a
 * persisted stale nonce would fail every submit until storage was cleared.
 */
let cachedNonce: string | null = null;

/** Discard the cached nonce (exported for tests and for the re-mint path). */
export function resetCachedNonce(): void {
  cachedNonce = null;
}

/**
 * The outcome of asking for a nonce. `absent` is the "there is no loopback API on
 * this origin" case — it must not be reported as a CSRF rejection, because the
 * remedy is completely different (start the server, versus retry the submit).
 */
type NonceResult = { readonly kind: "nonce"; readonly nonce: string } | { readonly kind: "absent" };

async function fetchNonce(fetchImpl: typeof fetch): Promise<NonceResult> {
  const response = await fetchImpl(CSRF_PATH, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
    // Send NO ambient credential. `fetch`'s default (`same-origin`) would attach
    // any cookie another local server left on this host — cookies are host-scoped,
    // not port-scoped, so a Vite or Next dev server on the same loopback host can
    // set one. The route never reads a cookie, and `omit` means the browser never
    // offers one either.
    credentials: "omit",
  });
  // A non-2xx here is a static host's 404 page, not a rejected nonce.
  if (!response.ok) return { kind: "absent" };
  // A 2xx that will not parse as the `{ nonce }` document is a static host's SPA
  // fallback (`index.html` served for an unknown path), which is likewise not a
  // rejected nonce.
  const body: unknown = await response.json().catch(() => null);
  const nonce = isRecord(body) ? body.nonce : undefined;
  return typeof nonce === "string" && nonce.length > 0 ? { kind: "nonce", nonce } : { kind: "absent" };
}

/**
 * Submit one brief and return either the checked, projected artifact or a
 * client-authored failure. Never throws: a transport rejection becomes a
 * retryable `NETWORK` failure.
 */
export async function requestDesignArtifact(
  brief: DesignBrief,
  options: RequestOptions = {},
): Promise<CreateUiSpecResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const onPhase = options.onPhase ?? ((): void => {});

  // Refuse locally so an obviously-invalid brief never leaves the browser.
  if (briefValidationMessage(brief) !== null) {
    return { ok: false, failure: { code: "INVALID_INPUT", retryable: false } };
  }

  const body = JSON.stringify(requestBodyFor(brief));

  try {
    // One re-mint, then stop. The nonce is process-local, so an operator restart
    // invalidates the cached one exactly once; looping would hammer the server.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      onPhase("authorizing");
      if (cachedNonce === null) {
        const minted = await fetchNonce(fetchImpl);
        if (minted.kind === "absent") {
          // No loopback API on this origin. Retryable in the sense that starting
          // the server makes it work — the UI copy says exactly that.
          return { ok: false, failure: { code: "LOCAL_API_UNAVAILABLE", retryable: true } };
        }
        cachedNonce = minted.nonce;
      }

      onPhase("submitting");
      const response = await fetchImpl(CREATE_UI_SPEC_PATH, {
        method: "POST",
        // See fetchNonce: no ambient credential is offered, and no authorization
        // header is ever set (the route refuses one outright).
        credentials: "omit",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          [CSRF_HEADER]: cachedNonce,
        },
        cache: "no-store",
        body,
      });

      if (response.status === 403) {
        // The nonce was rejected — the server restarted. Re-mint once.
        cachedNonce = null;
        continue;
      }

      if (!response.ok) {
        return { ok: false, failure: mapErrorResponse(response.status, await readJson(response)) };
      }

      onPhase("validating");
      const payload = await readJson(response);
      const artifact = projectSafeArtifact(payload);
      if (artifact === null) {
        return { ok: false, failure: { code: "MALFORMED_RESPONSE", retryable: false } };
      }
      return { ok: true, artifact };
    }
    return { ok: false, failure: { code: "CSRF_REJECTED", retryable: true } };
  } catch {
    // A transport rejection (server down, connection reset). Nothing derived from
    // the exception is surfaced or logged — its text can quote the request.
    return { ok: false, failure: { code: "NETWORK", retryable: true } };
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Map a non-2xx response to a client-authored failure. The server's `retryable`
 * flag is honoured when present and boolean (the integrity refusal is a
 * deterministic 503 that must NOT be retried), but its `message` is discarded.
 */
function mapErrorResponse(status: number, payload: unknown): CreateUiSpecFailure {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  const retryableFlag = error !== null && typeof error.retryable === "boolean" ? error.retryable : null;
  if (status === 400) return { code: "INVALID_INPUT", retryable: false };
  if (status === 503) return { code: "PROVIDER_ERROR", retryable: retryableFlag ?? true };
  // Any other status is not part of this route's contract.
  return { code: "MALFORMED_RESPONSE", retryable: false };
}

// ---------------------------------------------------------------------------
// Shape checks. Deliberately hand-written and explicit: this is the browser's
// own boundary, and every accepted position is visible in one place.
// ---------------------------------------------------------------------------

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** Response-scoped evidence ids. A path or a raw corpus id cannot match this. */
const RESPONSE_SCOPED_EVIDENCE_ID = /^evidence-[0-9]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max = 8_000): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max) return null;
  return value;
}

/**
 * A non-empty string with NO maximum, for positions the server schema leaves
 * unbounded (`z.string().trim().min(1)` with no `.max()`).
 *
 * A client maximum tighter than the schema's is not a safety property — it is a
 * way to refuse a LEGAL artifact whole, and the operator would see only "the
 * response did not match the expected artifact shape" with no way to tell that
 * apart from a corrupt one. The rule this encodes: the client may only ever refuse
 * something the SERVER would also refuse. `src/create-ui-spec-client-bounds.test.ts`
 * pins these positions against the real schema so the two cannot drift.
 *
 * The safety property does not come from length at all: it comes from the fields
 * being ABSENT from the projection, plus the positive ID/path shape checks.
 */
function unboundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length === 0 ? null : value;
}

function sha(value: unknown): string | null {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Check the served payload and project it onto {@link SafeArtifact}. Returns
 * `null` — refusing the whole response — when any checked position is absent or
 * the wrong shape.
 */
function projectSafeArtifact(payload: unknown): SafeArtifact | null {
  if (!isRecord(payload)) return null;
  if (payload.artifactVersion !== "1.0") return null;

  const artifactId = str(payload.artifactId, 200);
  const generatedAt = str(payload.generatedAt, 64);
  const producerVersion = str(payload.producerVersion, 120);
  if (artifactId === null || generatedAt === null || producerVersion === null) return null;

  // Both renderings must be present as strings. `""` is not a handoff, so the
  // non-empty check in `str` is the right gate here.
  const designMarkdown = typeof payload.designMarkdown === "string" ? payload.designMarkdown : null;
  const designJson = typeof payload.designJson === "string" ? payload.designJson : null;
  if (designMarkdown === null || designJson === null) return null;
  if (designMarkdown.length === 0 || designJson.length === 0) return null;

  const specSha256 = sha(payload.specSha256);
  const semanticSpecSha256 = sha(payload.semanticSpecSha256);
  const designMarkdownSha256 = sha(payload.designMarkdownSha256);
  const designJsonSha256 = sha(payload.designJsonSha256);
  if (
    specSha256 === null ||
    semanticSpecSha256 === null ||
    designMarkdownSha256 === null ||
    designJsonSha256 === null
  ) {
    return null;
  }

  // Response-scoped evidence ids. Checked POSITIVELY: every id must match the
  // `evidence-<n>` shape, so a filesystem path or a raw corpus id sitting in this
  // position refuses the response rather than being counted.
  const rawEvidenceIds = payload.publicEvidenceIds;
  if (!Array.isArray(rawEvidenceIds) || rawEvidenceIds.length === 0) return null;
  for (const id of rawEvidenceIds) {
    if (typeof id !== "string" || !RESPONSE_SCOPED_EVIDENCE_ID.test(id)) return null;
  }

  const retrieval = payload.retrieval;
  if (!isRecord(retrieval)) return null;
  const retrievalMode = str(retrieval.mode, 40);
  const retrievalModality = str(retrieval.modality, 40);
  const corpusResultCount = count(retrieval.resultCount);
  const attemptedCount = count(retrieval.attemptedCount);
  if (
    retrievalMode === null ||
    retrievalModality === null ||
    corpusResultCount === null ||
    attemptedCount === null ||
    typeof retrieval.fallbackUsed !== "boolean"
  ) {
    return null;
  }
  // `fallbackReason` DEGRADES rather than refusing, deliberately. It is a short
  // producer token (`"no-results"` / `"missing-index"`); if a future one exceeds
  // this bound the projection reports the reason as unknown and the UI says
  // "used (reason not reported)". That is the right trade HERE and only here,
  // because the alternative — refusing the whole artifact over an over-long
  // parenthetical — would throw away a generation for a cosmetic detail. Every
  // position the operator actually reads is unbounded instead (see unboundedText).
  const fallbackReason = typeof retrieval.fallbackReason === "string" ? str(retrieval.fallbackReason, 60) : null;

  const spec = payload.spec;
  if (!isRecord(spec)) return null;
  if (spec.specVersion !== "1.0") return null;
  if (!isRecord(spec.context)) return null;
  // UNBOUNDED, deliberately. `UiSpec.designDirection` is
  // `z.string().trim().min(1)` with no `.max()` (src/tool-contracts.ts), and the
  // deterministic direction embeds the caller's brief verbatim — up to 8,000
  // chars — plus the corpus-signal section. Reading it through `str()`, whose
  // default maximum is 8,000, refused a LEGAL artifact whole on a long brief and
  // told the operator only that the response "did not match the expected
  // artifact shape". See the {@link unboundedText} docblock: a client maximum
  // tighter than the schema's is not a safety property.
  const designDirection = unboundedText(spec.designDirection);
  if (designDirection === null) return null;

  const modelExecution = projectModelExecution(payload.modelExecution);
  if (payload.modelExecution !== undefined && modelExecution === null) return null;
  const modelProposal = projectModelProposal(spec.modelProposal);
  if (spec.modelProposal !== undefined && modelProposal === null) return null;
  const colorIntent = projectColorIntent(spec.context.colorIntent);
  if (spec.context.colorIntent !== undefined && colorIntent === null) return null;
  const typeIntent = projectTypeIntent(spec.context.typeIntent);
  if (spec.context.typeIntent !== undefined && typeIntent === null) return null;

  const decisions = projectDecisions(spec.citedDecisions);
  if (decisions === null) return null;
  const acceptanceCriteria = projectAcceptanceCriteria(spec.acceptanceCriteria);
  if (acceptanceCriteria === null || acceptanceCriteria.length === 0) return null;
  const unavailableDecisions = projectUnavailableDecisions(spec.unavailableDecisions);
  if (unavailableDecisions === null) return null;
  const projectedWarnings = projectWarnings(payload.warnings);
  if (projectedWarnings === null) return null;

  const evidence: EvidenceSummary = {
    evidenceCount: rawEvidenceIds.length,
    retrievalMode,
    retrievalModality,
    corpusResultCount,
    attemptedCount,
    fallbackUsed: retrieval.fallbackUsed,
    fallbackReason,
  };

  return {
    artifactId,
    generatedAt,
    producerVersion,
    designDirection,
    colorIntent,
    typeIntent,
    decisions,
    acceptanceCriteria,
    warnings: projectedWarnings.warnings,
    droppedWarningCount: projectedWarnings.droppedCount,
    unavailableDecisions,
    evidence,
    modelExecution,
    modelProposal,
    // There is deliberately NO collapsed `partial` flag. "The deterministic
    // fallback carried this" and "the producer raised warnings" are different
    // claims, and the lifecycle label has to keep them apart — a single boolean
    // cannot, and the one this object used to carry had no production reader.
    //
    // `unavailableDecisions` deliberately affects neither. A brief with no design
    // system ALWAYS yields `colorTokens`/`typographyTokens` unavailable decisions —
    // that is the producer honestly declining to invent tokens, not a degraded run.
    // They are always displayed; they just do not change the lifecycle label.
    designMarkdown,
    designJson,
    specSha256,
    semanticSpecSha256,
    designMarkdownSha256,
    designJsonSha256,
  };
}

type OptionalIntentText = string | undefined | null;

function optionalIntentText(value: unknown): OptionalIntentText {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_INTENT_TEXT_LENGTH) {
    return null;
  }
  return value;
}

function projectColorIntent(raw: unknown): SafeColorIntent | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) return null;
  if (Object.keys(raw).some((key) => !["accentPreference", "mood", "contrastFloor"].includes(key))) {
    return null;
  }
  const accentPreference = optionalIntentText(raw.accentPreference);
  const mood = optionalIntentText(raw.mood);
  if (accentPreference === null || mood === null) return null;
  const contrastFloor = raw.contrastFloor;
  if (
    contrastFloor !== undefined &&
    !(COLOR_CONTRAST_FLOORS as readonly string[]).includes(String(contrastFloor))
  ) {
    return null;
  }
  return {
    ...(accentPreference !== undefined ? { accentPreference } : {}),
    ...(mood !== undefined ? { mood } : {}),
    ...(contrastFloor !== undefined ? { contrastFloor: contrastFloor as BriefColorContrastFloor } : {}),
  };
}

function projectTypeIntent(raw: unknown): SafeTypeIntent | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) return null;
  if (Object.keys(raw).some((key) => !["voice", "density"].includes(key))) return null;
  const voice = optionalIntentText(raw.voice);
  if (voice === null) return null;
  const density = raw.density;
  if (density !== undefined && !(TYPE_DENSITIES as readonly string[]).includes(String(density))) {
    return null;
  }
  return {
    ...(voice !== undefined ? { voice } : {}),
    ...(density !== undefined ? { density: density as BriefTypeDensity } : {}),
  };
}

// ---------------------------------------------------------------------------
// The optional model lane. The same closed-shape discipline as every other
// position: unknown fields on `modelExecution` are never read (dropped), while
// a hostile VALUE in a projected position, an unknown key on the proposal, or a
// served disclaimer that differs from the fixed literal refuses the whole
// response.
// ---------------------------------------------------------------------------

/** provider/model: a non-empty string ≤200 that is neither marker- nor
 * URL/path-shaped. These are machine identifiers, not prose — a URL- or
 * path-shaped value here is never a legitimate display value. The provider
 * position does NOT use this shape guard: it is gated on the closed
 * {@link MODEL_PROVIDERS} enum instead, which refuses non-enum (and therefore
 * secret- or URL-shaped) values by construction. */
function modelIdentifier(value: unknown): string | null {
  const s = str(value, 200);
  if (s === null) return null;
  if (containsPrivateMarker(s) || URL_OR_PATH_FORM.test(s)) return null;
  return s;
}

/** Proposal prose positions: bounded, and marker-free — the same private-marker
 * gate the server's envelope superRefine applies to every served string. No
 * other prose claim is made about them (see the module header). */
function modelProse(value: unknown, max: number): string | null {
  const s = str(value, max);
  if (s === null) return null;
  if (containsPrivateMarker(s)) return null;
  return s;
}

function projectModelExecution(raw: unknown): SafeModelExecution | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) return null;
  if (typeof raw.state !== "string") return null;
  if (!(MODEL_EXECUTION_STATES as readonly string[]).includes(raw.state)) return null;
  if (raw.state !== "succeeded") {
    // Failed states carry their state and NOTHING else: `provider`/`model` are
    // never read here, so a hostile value on a failed run is dropped by
    // construction rather than rendered. (The server's per-state schema is
    // strict too, so this mirrors what it would refuse to serve.)
    return { state: raw.state as ModelExecutionState };
  }
  // The provider position is the closed enum: non-enum values — URL-shaped,
  // marker-bearing, or secret-shaped — refuse by construction, exactly like the
  // transport suites' API-key fixture. The model position keeps the shape guard
  // (see `modelIdentifier`).
  if (typeof raw.provider !== "string" || !(MODEL_PROVIDERS as readonly string[]).includes(raw.provider)) return null;
  const provider = raw.provider as (typeof MODEL_PROVIDERS)[number];
  const model = modelIdentifier(raw.model);
  if (model === null) return null;
  return { state: "succeeded", provider, model };
}

const MODEL_PROPOSAL_KEYS = [
  "status",
  "disclaimer",
  "designDirection",
  "colorTokens",
  "typographyTokens",
  "motionNotes",
  "contentVoiceGuidance",
] as const;

const MODEL_COLOR_TOKEN_KEYS = ["primary", "surface", "ink", "muted", "accent"] as const;
const MODEL_TYPOGRAPHY_TOKEN_KEYS = ["heading", "body", "mono"] as const;

/** Project one strict token set. `null` when absent; refuses on unknown keys,
 * non-string values, out-of-bound values, or a marker-bearing value. */
function projectModelTokens<K extends string>(
  raw: unknown,
  keys: readonly K[],
): Record<K, string> | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) return null;
  if (Object.keys(raw).some((key) => !(keys as readonly string[]).includes(key))) return null;
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const value = modelProse(raw[key], 200);
    if (value === null) return null;
    out[key] = value;
  }
  return out;
}

function projectMotionNotes(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 8) return null;
  const out: string[] = [];
  for (const note of raw) {
    const value = modelProse(note, 500);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}

function projectModelProposal(raw: unknown): SafeModelProposal | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) return null;
  // `.strict()` server-side: an unknown key — e.g. a future authority field
  // attempting promotion — refuses the whole response rather than being
  // dropped, so a promotion attempt can never half-render.
  if (Object.keys(raw).some((key) => !(MODEL_PROPOSAL_KEYS as readonly string[]).includes(key))) {
    return null;
  }
  if (raw.status !== "proposal-only") return null;
  // The served disclaimer must be the fixed literal; the PROJECTED value is the
  // constant, so a served string can never become the rendered disclaimer.
  if (raw.disclaimer !== MODEL_PROPOSAL_DISCLAIMER) return null;
  const designDirection = modelProse(raw.designDirection, 2_000);
  if (designDirection === null) return null;
  const colorTokens = projectModelTokens(raw.colorTokens, MODEL_COLOR_TOKEN_KEYS);
  if (raw.colorTokens !== undefined && colorTokens === null) return null;
  const typographyTokens = projectModelTokens(raw.typographyTokens, MODEL_TYPOGRAPHY_TOKEN_KEYS);
  if (raw.typographyTokens !== undefined && typographyTokens === null) return null;
  const motionNotes = raw.motionNotes === undefined ? [] : projectMotionNotes(raw.motionNotes);
  if (raw.motionNotes !== undefined && motionNotes === null) return null;
  const contentVoiceGuidance =
    raw.contentVoiceGuidance === undefined ? null : modelProse(raw.contentVoiceGuidance, 1_000);
  if (raw.contentVoiceGuidance !== undefined && contentVoiceGuidance === null) return null;
  return {
    disclaimer: MODEL_PROPOSAL_DISCLAIMER,
    designDirection,
    colorTokens,
    typographyTokens,
    // The guard above already returned on null; the coalesce narrows the type
    // to SafeModelProposal.motionNotes (`readonly string[]`) without a cast.
    motionNotes: motionNotes ?? [],
    contentVoiceGuidance,
  };
}

function projectDecisions(raw: unknown): SafeDecision[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SafeDecision[] = [];
  for (const row of raw) {
    if (!isRecord(row)) return null;
    // `id`/`field`: unbounded in the schema (src/tool-contracts.ts CitedDecision).
    const id = unboundedText(row.id);
    const field = unboundedText(row.field);
    // `authority`/`readiness` ARE closed enums server-side, so a bound is honest.
    const authority = str(row.authority, 60);
    const readiness = str(row.readiness, 60);
    if (id === null || field === null || authority === null || readiness === null) return null;
    // `row.sourceId` is deliberately NOT read.
    out.push({ id, field, authority, readiness });
  }
  return out;
}

function projectAcceptanceCriteria(raw: unknown): SafeAcceptanceCriterion[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SafeAcceptanceCriterion[] = [];
  for (const row of raw) {
    if (!isRecord(row)) return null;
    // `id`/`subject`/`expectedOutcome`: unbounded in the schema
    // (src/tool-contracts.ts AcceptanceCriterion). `assertion`/`verifier`/
    // `priority` are closed enums server-side, so those bounds are honest.
    const id = unboundedText(row.id);
    const subject = unboundedText(row.subject);
    const assertion = str(row.assertion, 60);
    const expectedOutcome = unboundedText(row.expectedOutcome);
    const verifier = str(row.verifier, 40);
    const priority = str(row.priority, 20);
    if (
      id === null ||
      subject === null ||
      assertion === null ||
      expectedOutcome === null ||
      verifier === null ||
      priority === null
    ) {
      return null;
    }
    // `row.evidenceIds`, `row.selector`, `row.command`, `row.manualSteps` are NOT
    // read: a selector or a command is a machine-verifier detail, and the
    // evidence links are aggregated instead of listed.
    out.push({ id, subject, assertion, expectedOutcome, verifier, priority });
  }
  return out;
}

function projectUnavailableDecisions(raw: unknown): SafeUnavailableDecision[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SafeUnavailableDecision[] = [];
  for (const row of raw) {
    if (!isRecord(row)) return null;
    // Both unbounded in the schema (src/tool-contracts.ts UnavailableDecision).
    const field = unboundedText(row.field);
    const reason = unboundedText(row.reason);
    if (field === null || reason === null) return null;
    out.push({ field, reason });
  }
  return out;
}

interface ProjectedWarnings {
  readonly warnings: SafeWarning[];
  readonly droppedCount: number;
}

/**
 * Project the warning list.
 *
 * A row whose `code` is outside the closed set is not RENDERED — an unknown code
 * is a producer vocabulary addition rather than a corrupt artifact, and putting an
 * unmapped server token in the UI would make the producer's vocabulary into UI
 * copy. But it is still COUNTED. Dropping it from the count too would invert the
 * lifecycle label: a future producer emitting a fifth code on its own would make
 * the live region announce "Generated a complete design handoff" for an artifact
 * the producer explicitly flagged as degraded — the same truthfulness inversion
 * the three-way label exists to prevent, arrived at from the other direction.
 */
function projectWarnings(raw: unknown): ProjectedWarnings | null {
  if (!Array.isArray(raw)) return null;
  const warnings: SafeWarning[] = [];
  let droppedCount = 0;
  for (const row of raw) {
    if (!isRecord(row)) return null;
    const code = row.code;
    // `message` max 500 matches WarningSchema's own bound exactly.
    const message = str(row.message, 500);
    if (typeof code !== "string" || message === null) return null;
    if (!(WARNING_CODES as readonly string[]).includes(code)) {
      droppedCount += 1;
      continue;
    }
    warnings.push({ code: code as WarningCode, message });
  }
  return { warnings, droppedCount };
}

// ---------------------------------------------------------------------------
// Downloads — the exact returned bytes, no second request.
// ---------------------------------------------------------------------------

export const DESIGN_MARKDOWN_FILENAME = "DESIGN.md";
export const DESIGN_JSON_FILENAME = "DESIGN.json";
export const DESIGN_MARKDOWN_MIME = "text/markdown;charset=utf-8";
export const DESIGN_JSON_MIME = "application/json;charset=utf-8";

/** Injection seam so the download path is assertable without a real navigation. */
export interface DownloadEnv {
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly doc?: Document;
  /**
   * How the revoke is scheduled. Kept as a seam so a test can still assert that
   * the URL IS revoked; production always defers (see {@link downloadExactBytes}).
   */
  readonly defer?: (task: () => void) => void;
}

function defaultDownloadEnv(): DownloadEnv {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  };
}

/**
 * The default revoke schedule: a macrotask after the click.
 *
 * Not zero — `setTimeout(…, 0)` is already a later task than the click dispatch,
 * which is the property that matters, and a small delay gives an engine that
 * starts the fetch of the blob asynchronously room to begin reading it.
 */
const REVOKE_DELAY_MS = 1_000;

function defaultDefer(task: () => void): void {
  setTimeout(task, REVOKE_DELAY_MS);
}

/**
 * Save `contents` as `filename`.
 *
 * The bytes come from the caller — which is always the {@link SafeArtifact}
 * already in component state — so a download NEVER issues a request of any kind.
 * That is the whole point: a second generation would produce a different
 * `generatedAt` and therefore different BYTES than the one the operator
 * reviewed. The identity would be unchanged — `artifactId` is derived from the
 * timestamp-normalized semantic hash — which is precisely why comparing ids is
 * not enough and the reviewed bytes must be the saved bytes.
 * There is no `fetch` in this function, and the artifact it reads from is
 * immutable state.
 *
 * THE REVOKE IS DEFERRED PAST THE CLICK. Chromium starts the download
 * synchronously while dispatching the synthetic click, so revoking in the same
 * task happens to work there — but other engines start it in a later task, and a
 * same-task revoke there produces a failed or zero-byte file with nothing
 * surfacing the error. A silently empty save is the worst possible outcome for a
 * surface whose promise is "the reviewed bytes are the only bytes that can be
 * saved", so the revoke is scheduled instead of inlined. It still happens — the
 * object URL is not leaked for the life of the page.
 *
 * Returns the anchor element it clicked so a test can assert the filename.
 */
export function downloadExactBytes(
  filename: string,
  contents: string,
  mimeType: string,
  env: DownloadEnv = defaultDownloadEnv(),
): HTMLAnchorElement {
  const doc = env.doc ?? document;
  const blob = new Blob([contents], { type: mimeType });
  const url = env.createObjectURL(blob);
  const anchor = doc.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  doc.body.appendChild(anchor);
  anchor.click();
  doc.body.removeChild(anchor);
  const defer = env.defer ?? defaultDefer;
  defer(() => env.revokeObjectURL(url));
  return anchor;
}
