import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import {
  BRIEF_MAX_LENGTH,
  BRIEF_MIN_LENGTH,
  DESIGN_JSON_FILENAME,
  DESIGN_JSON_MIME,
  DESIGN_MARKDOWN_FILENAME,
  DESIGN_MARKDOWN_MIME,
  MAX_INTENT_TEXT_LENGTH,
  MAX_CONSTRAINTS,
  MAX_REFERENCE_IDS,
  briefValidationMessage,
  downloadExactBytes,
  requestDesignArtifact,
  type BriefPlatform,
  type CreateUiSpecFailure,
  type DesignBrief,
  type LifecyclePhase,
  type ModelExecutionState,
  type SafeArtifact,
  type SafeModelExecution,
  type SafeModelProposal,
} from "../data/create-ui-spec";
import "../styles/playground.css";

/**
 * Playground — the focused C3 `create_ui_spec` composer.
 *
 * BRIEF FIRST, THEN RESULT. One column collects the brief and its optional
 * controls; the other reports the lifecycle and the artifact. There is no
 * project list, no revision history, and no dashboard: the approved design is a
 * composer, and anything else here would be a surface with no producer behind it.
 *
 * WHAT REACHES THE DOM. Only the DISPLAY-SAFE half of {@link SafeArtifact}, the
 * allowlist projection built by the client from CHECKED response positions: the
 * design direction, caller-supplied color/typography intent, the key decisions'
 * structured positions, the acceptance criteria, the producer's warnings, the
 * fields it could not decide, and an AGGREGATE evidence summary (counts plus
 * retrieval metadata). No raw corpus id, source identity, product name, image
 * path, screenshot, critique, provider diagnostic, credential, or filesystem path
 * is projected, so none can be rendered — not because a scrubber removed it, but
 * because the object this component reads does not carry it.
 *
 * `artifact.designMarkdown` / `artifact.designJson` are the EXCEPTION, and the
 * exception is enforced rather than asserted. They are the server's own
 * renderings, carried through whole and unprojected because the download
 * guarantee needs the exact bytes — and `renderDesignHandoffMarkdown` prints
 * `spec.context.productContext`, `spec.citedReferences`, the profile's `sourceId`
 * and URL lines, and `spec.techniques[].text` / `spec.antiPatterns[].text` /
 * `spec.componentInventory`, i.e. positions the projection deliberately does not
 * read. So this component treats those two strings as DOWNLOAD/CLIPBOARD PAYLOADS
 * ONLY: they are passed to {@link downloadExactBytes} and to the clipboard, and to
 * nothing that renders. {@link CopyHandoffAction} exists precisely because the
 * shared `CopyAction` (site/src/components/CopyAction.tsx) answers a clipboard
 * failure by printing its `value` into the DOM as selectable text, which would
 * publish every one of those fields. A copy control on this page must have NO
 * value-rendering fallback.
 *
 * The producer echoes the caller's own brief into `spec.context.productContext`
 * and records explicit intent beside it. The projection drops the product brief
 * but carries only the bounded intent fields, so the operator can tell what was
 * recorded without treating it as a token decision. The `designDirection` IS
 * rendered — it is the producer's direction statement and the design names it as
 * displayable. It is producer free text, so this component makes no claim about
 * its prose; the only claim made anywhere on this path is about ID and path
 * SHAPE, which the client re-checks itself.
 *
 * DOWNLOADS NEVER REGENERATE. Both renderings arrive in the single response and
 * live in component state. The download handlers read `artifact.designMarkdown` /
 * `artifact.designJson` from that state and call {@link downloadExactBytes},
 * which touches no network. Re-requesting would produce a different
 * `generatedAt`, and therefore different BYTES — `DESIGN.json` embeds the
 * timestamp and the spec hash covers it — than the one the operator just
 * reviewed, so the reviewed bytes are the only bytes that can be saved. Note it
 * is the bytes that differ, NOT the identity: `buildArtifactIdentityInput`
 * excludes `generatedAt` and consumes the timestamp-normalized semantic hash, so
 * a timestamp-only rerun keeps the same `artifactId`. The returned hashes are
 * displayed so the saved file can be verified.
 *
 * NOTHING IS PERSISTED OR LOGGED. No `localStorage`, no `sessionStorage`, no
 * cookie, no analytics call, and no `console.*` — the brief lives in React state
 * for the life of the page and nowhere else.
 */

/** The composer's lifecycle. Every stage here is one the client actually enters. */
type Lifecycle =
  | { readonly kind: "idle" }
  | { readonly kind: "generating"; readonly phase: LifecyclePhase }
  | { readonly kind: "success"; readonly artifact: SafeArtifact }
  | {
      readonly kind: "failure";
      readonly failure: CreateUiSpecFailure;
      readonly explicitReferences: boolean;
    };

/** Editable form state. Kept flat so "start over" is one assignment. */
interface FormState {
  readonly brief: string;
  readonly platform: "" | BriefPlatform;
  readonly framework: string;
  readonly designSystemStatus: "none" | "identified";
  readonly registry: string;
  readonly library: string;
  readonly constraintsText: string;
  readonly referencesText: string;
  readonly accentPreference: string;
  readonly colorMood: string;
  readonly colorContrastFloor: "" | "AA" | "AAA";
  readonly typographyVoice: string;
  readonly typographyDensity: "" | "compact" | "regular" | "spacious";
}

const EMPTY_FORM: FormState = {
  brief: "",
  platform: "",
  framework: "",
  designSystemStatus: "none",
  registry: "",
  library: "",
  constraintsText: "",
  referencesText: "",
  accentPreference: "",
  colorMood: "",
  colorContrastFloor: "",
  typographyVoice: "",
  typographyDensity: "",
};

/** Split a one-per-line textarea into trimmed, non-empty lines. */
function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Build the request brief from the form. Blank optional fields are omitted. */
function briefFrom(form: FormState): DesignBrief {
  const constraints = lines(form.constraintsText);
  const referenceIds = lines(form.referencesText);
  const colorIntent = {
    ...(form.accentPreference.trim().length > 0
      ? { accentPreference: form.accentPreference }
      : {}),
    ...(form.colorMood.trim().length > 0 ? { mood: form.colorMood } : {}),
    ...(form.colorContrastFloor !== "" ? { contrastFloor: form.colorContrastFloor } : {}),
  };
  const typeIntent = {
    ...(form.typographyVoice.trim().length > 0 ? { voice: form.typographyVoice } : {}),
    ...(form.typographyDensity !== "" ? { density: form.typographyDensity } : {}),
  };
  return {
    productContext: form.brief,
    ...(form.platform !== "" ? { platform: form.platform } : {}),
    ...(form.framework.trim().length > 0 ? { implementationFramework: form.framework } : {}),
    ...(form.designSystemStatus === "identified"
      ? {
          designSystem: {
            status: "identified" as const,
            ...(form.registry.trim().length > 0 ? { registry: form.registry } : {}),
            ...(form.library.trim().length > 0 ? { library: form.library } : {}),
          },
        }
      : {}),
    ...(constraints.length > 0 ? { constraints } : {}),
    ...(referenceIds.length > 0 ? { referenceIds } : {}),
    ...(Object.keys(colorIntent).length > 0 ? { colorIntent } : {}),
    ...(Object.keys(typeIntent).length > 0 ? { typeIntent } : {}),
  };
}

/**
 * The live-region copy for every lifecycle stage.
 *
 * The generating stages are the client's REAL phases — obtaining the local
 * nonce, submitting, checking the response. There is exactly one server round
 * trip, so the producer's internal steps are not observable from here and a
 * ticking percentage would be fabricated. None is shown.
 */
function statusLabel(lifecycle: Lifecycle): string {
  if (lifecycle.kind === "idle") {
    return "Idle. Describe what you are designing, then choose Generate handoff.";
  }
  if (lifecycle.kind === "generating") {
    return PHASE_LABELS[lifecycle.phase];
  }
  if (lifecycle.kind === "success") {
    return successLabel(lifecycle.artifact);
  }
  return failureLabel(lifecycle.failure, lifecycle.explicitReferences);
}

/** Producers that consult no model. Their unavailable fields are a rule of the
 * producer, not a consequence of a weak brief or an unsuccessful retrieval. */
const DETERMINISTIC_PRODUCERS = new Set(["c3-fallback-v1"]);

/**
 * Success copy keeps three separate claims visible:
 *
 * - a producer can be deterministic even when retrieval found observations;
 * - retrieval can fall back after finding nothing;
 * - an artifact can carry warnings without either of those being true.
 */
function successLabel(artifact: SafeArtifact): string {
  // Warnings the client could not map are still warnings. Counting only the
  // mapped ones would announce "complete" for a producer-degraded artifact the
  // moment it adds a warning code this client does not know.
  const count = artifact.warnings.length + artifact.droppedWarningCount;
  const parts: string[] = [
    count > 0
      ? `Generated a design handoff with ${count} ${count === 1 ? "warning" : "warnings"}.`
      : "Generated a complete design handoff.",
  ];

  // Do not interpolate producerVersion into this copy: the production id
  // "c3-fallback-v1" contains "fallback", which would mislabel a retrieval
  // success as a fallback run in the warning-sensitive UI.
  //
  // The deterministic claim is suppressed ONLY for a SUCCEEDED model run: the
  // same producerVersion serves both lanes (the deterministic scaffold is
  // rebuilt under the model envelope), so "no model attached" would be false
  // exactly when the proposal section above says a model ran. Failed model
  // states KEEP the claim — the served scaffold IS the deterministic artifact
  // there, and the model section next to it says so.
  if (
    DETERMINISTIC_PRODUCERS.has(artifact.producerVersion) &&
    artifact.modelExecution?.state !== "succeeded"
  ) {
    parts.push(
      "This is a deterministic scaffold with no model attached. Color, typography and motion are declined by design, not missing because of your brief.",
    );
  }

  if (artifact.evidence.fallbackUsed) {
    parts.push(
      "Automatic retrieval matched nothing, so this used the deterministic fallback and no corpus evidence grounds it.",
    );
  }

  return parts.join(" ");
}

const PHASE_LABELS: Readonly<Record<LifecyclePhase, string>> = {
  authorizing: "Authorizing with the local server…",
  submitting: "Submitting the brief to the local server…",
  validating: "Checking the returned artifact…",
};

/**
 * Failure copy. Authored HERE, keyed on the client's own failure code — the
 * server's bounded `error.message` is deliberately never rendered, so no server
 * string can become UI copy.
 */
function failureLabel(failure: CreateUiSpecFailure, explicitReferences = false): string {
  if (failure.code === "INVALID_INPUT" && explicitReferences) {
    return "The explicit references could not be resolved; omit them to use automatic retrieval.";
  }

  switch (failure.code) {
    case "INVALID_INPUT":
      return "The brief could not be accepted. Adjust the brief or the optional controls and generate again.";
    case "PROVIDER_ERROR":
      return failure.retryable
        ? "Generation could not run right now. Your brief is unchanged — try again."
        : "Generation could not run and retrying would fail the same way. Check the local server output.";
    case "LOCAL_API_UNAVAILABLE":
      // NOT "the server may have restarted": there was no server. This is the
      // state of every hosted copy of this page, and the remedy is to run one.
      return "No clean-ui server answered on this address, so nothing was generated. Generation runs on your own machine only: start the server with npm run ui and open the address it prints. A hosted copy of this page has no server to call.";
    case "CSRF_REJECTED":
      return "The local server did not authorize this generation. It may have restarted — try again.";
    case "NETWORK":
      return "Generation could not reach the local server. Confirm it is running, then try again.";
    case "MALFORMED_RESPONSE":
      return "The response did not match the expected artifact shape, so nothing was displayed. Nothing was saved.";
  }
}

/**
 * Stable element ids. The composer is rendered once per page, so fixed ids are
 * unambiguous and — unlike `useId()`'s colon-bearing values — usable in CSS and
 * in browser-test selectors.
 */
function id(suffix: string): string {
  return `composer-${suffix}`;
}

/**
 * The corpus-search query-string keys, mirrored from `site/src/search/search.ts`
 * (`PARAM_QUERY`/`PARAM_CATEGORY`/`PARAM_STYLE`/`PARAM_DOMAIN`/`PARAM_PLATFORM`).
 *
 * They are DUPLICATED rather than imported on purpose: `search.ts` pulls in
 * MiniSearch at module scope, and importing it here would drag the whole search
 * index into the composer's route chunk for the sake of five string literals.
 */
const SEARCH_PARAM_KEYS = ["q", "category", "style", "domain", "platform"] as const;

/**
 * `/playground?q=…` was the canonical shareable corpus-search URL before C3 Task 6
 * moved search to `/browse`. Such a URL now lands on the composer, which has no
 * search UI and would silently discard every parameter — so it is forwarded, query
 * intact. A `/playground` with no search parameters (or with unrelated ones, e.g.
 * campaign tags) is a genuine composer visit and is left alone.
 */
export function PlaygroundPage(): ReactElement {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  if (SEARCH_PARAM_KEYS.some((key) => params.has(key))) {
    return <Navigate to={`/browse${search}`} replace />;
  }
  return <PlaygroundComposer />;
}

function PlaygroundComposer(): ReactElement {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [lifecycle, setLifecycle] = useState<Lifecycle>({ kind: "idle" });

  // A submit already in flight. The button is disabled too, but a form can also
  // be submitted with Enter from a text field, which a disabled button does not
  // prevent — so the guard is the ref, and the disabled button is the affordance.
  const inFlight = useRef(false);
  const outcomeRef = useRef<HTMLElement | null>(null);
  const briefRef = useRef<HTMLTextAreaElement | null>(null);

  const validation = briefValidationMessage(briefFrom(form));
  const generating = lifecycle.kind === "generating";
  const canGenerate = validation === null && !generating;

  // Move focus to the outcome column when the lifecycle leaves idle. Submitting
  // disables the button under the user's own focus, so without this a keyboard
  // user would be dropped onto the document body; landing on the region that is
  // about to describe the outcome is where they were heading anyway.
  useEffect(() => {
    if (lifecycle.kind === "idle") return;
    outcomeRef.current?.focus();
    // Only on a stage CHANGE, not on every phase tick.
  }, [lifecycle.kind]);

  const generate = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    const brief = briefFrom(form);
    if (briefValidationMessage(brief) !== null) return;

    inFlight.current = true;
    setLifecycle({ kind: "generating", phase: "authorizing" });
    const result = await requestDesignArtifact(brief, {
      onPhase: (phase) => setLifecycle({ kind: "generating", phase }),
    });
    inFlight.current = false;

    // The brief is NEVER cleared on failure — a recoverable failure must leave
    // the operator exactly where they were.
    setLifecycle(
      result.ok
        ? { kind: "success", artifact: result.artifact }
        : {
            kind: "failure",
            failure: result.failure,
            explicitReferences: (brief.referenceIds?.length ?? 0) > 0,
          },
    );
  }, [form]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void generate();
  };

  const startOver = (): void => {
    setForm(EMPTY_FORM);
    setLifecycle({ kind: "idle" });
    briefRef.current?.focus();
  };

  const briefLength = form.brief.trim().length;
  // The inline message appears only once the operator has typed something — an
  // empty field is not yet an error, it is the starting state.
  //
  // It also gates the `aria-describedby` reference below: a dangling idref is not
  // merely untidy, some screen readers announce NOTHING for a field whose
  // `aria-describedby` names a missing element.
  const showBriefError = validation !== null && briefLength > 0;

  return (
    <div className="playground">
      <header className="playground__header">
        <p className="playground__eyebrow">Playground</p>
        <h1>Generate a grounded design handoff</h1>
        <p className="playground__lede">
          Describe what you are designing. The local server assembles a deterministic UI spec from
          the curated corpus and returns both handoffs — Markdown and JSON — in one response. The
          brief stays on this machine: it is sent to the loopback server beside this page and
          nowhere else.
        </p>
        {/* STATIC, ALWAYS PRESENT, NO PROBE. Generation is a POST to the loopback
            server that serves this page; a hosted copy has no such server, and
            without this notice its only signal was a failure after the operator
            had already written a brief and pressed Generate. Probing `/api` on
            mount would be a request made on the operator's behalf for a fact that
            is already knowable — so the requirement is simply stated. */}
        <p className="playground__requirement" data-testid="playground-requirement">
          <strong>Generation runs on your own machine.</strong> This page can only generate while
          your local clean-ui server is serving it — start it with <code>npm run ui</code> and open
          the address it prints. A hosted copy of this page cannot generate, because there is no
          server beside it to call. Browsing the corpus works anywhere.
        </p>
        <p className="playground__crosslink">
          Looking for the corpus itself? <Link to="/browse">Browse the corpus</Link>.
        </p>
      </header>

      <div className="playground__layout">
        <form className="composer" onSubmit={handleSubmit} noValidate>
          <h2 className="composer__title">Brief</h2>

          <div className="composer__field">
            <label className="composer__label" htmlFor={id("brief")}>
              What are you designing?
            </label>
            <textarea
              id={id("brief")}
              ref={briefRef}
              className="composer__textarea"
              rows={6}
              value={form.brief}
              maxLength={BRIEF_MAX_LENGTH}
              aria-describedby={`${id("brief-hint")}${showBriefError ? ` ${id("brief-error")}` : ""}`}
              onChange={(event) => setForm({ ...form, brief: event.target.value })}
            />
            <p className="composer__hint" id={id("brief-hint")}>
              At least {BRIEF_MIN_LENGTH} characters. {briefLength} entered.
            </p>
            {showBriefError && (
              <p className="composer__error" id={id("brief-error")}>
                {validation}
              </p>
            )}
          </div>

          <div className="composer__grid">
            <div className="composer__field">
              <label className="composer__label" htmlFor={id("platform")}>
                Platform
              </label>
              <select
                id={id("platform")}
                className="composer__select"
                value={form.platform}
                onChange={(event) =>
                  setForm({ ...form, platform: event.target.value as FormState["platform"] })
                }
              >
                <option value="">Not specified</option>
                <option value="web">Web</option>
                <option value="mobile">Mobile</option>
                <option value="tablet">Tablet</option>
              </select>
            </div>

            <div className="composer__field">
              <label className="composer__label" htmlFor={id("framework")}>
                Implementation framework
              </label>
              <input
                id={id("framework")}
                className="composer__input"
                type="text"
                value={form.framework}
                onChange={(event) => setForm({ ...form, framework: event.target.value })}
              />
            </div>

            <div className="composer__field">
              <label className="composer__label" htmlFor={id("design-system")}>
                Design system
              </label>
              <select
                id={id("design-system")}
                className="composer__select"
                value={form.designSystemStatus}
                onChange={(event) =>
                  setForm({
                    ...form,
                    designSystemStatus: event.target.value as FormState["designSystemStatus"],
                  })
                }
              >
                <option value="none">None</option>
                <option value="identified">Identified</option>
              </select>
            </div>

            {form.designSystemStatus === "identified" && (
              <>
                <div className="composer__field">
                  <label className="composer__label" htmlFor={id("registry")}>
                    Token registry
                  </label>
                  <input
                    id={id("registry")}
                    className="composer__input"
                    type="text"
                    value={form.registry}
                    onChange={(event) => setForm({ ...form, registry: event.target.value })}
                  />
                </div>
                <div className="composer__field">
                  <label className="composer__label" htmlFor={id("library")}>
                    Component library
                  </label>
                  <input
                    id={id("library")}
                    className="composer__input"
                    type="text"
                    value={form.library}
                    onChange={(event) => setForm({ ...form, library: event.target.value })}
                  />
                </div>
              </>
            )}
          </div>

          <div className="composer__field">
            <label className="composer__label" htmlFor={id("constraints")}>
              Constraints, one per line
            </label>
            <textarea
              id={id("constraints")}
              className="composer__textarea"
              rows={3}
              value={form.constraintsText}
              aria-describedby={id("constraints-hint")}
              onChange={(event) => setForm({ ...form, constraintsText: event.target.value })}
            />
            <p className="composer__hint" id={id("constraints-hint")}>
              Up to {MAX_CONSTRAINTS}. Blank lines are ignored.
            </p>
          </div>

          <fieldset className="composer__fieldset">
            <legend className="composer__legend">Design intent</legend>
            <p className="composer__hint" id={id("intent-hint")}>
              Optional caller-supplied guidance. It is recorded in the handoff, but it does not
              create color or typography tokens. Text fields allow up to {MAX_INTENT_TEXT_LENGTH}
              characters.
            </p>
            <div className="composer__grid">
              <div className="composer__field">
                <label className="composer__label" htmlFor={id("accent-preference")}>
                  Accent preference
                </label>
                <input
                  id={id("accent-preference")}
                  className="composer__input"
                  type="text"
                  maxLength={MAX_INTENT_TEXT_LENGTH}
                  value={form.accentPreference}
                  aria-describedby={id("intent-hint")}
                  onChange={(event) => setForm({ ...form, accentPreference: event.target.value })}
                />
              </div>
              <div className="composer__field">
                <label className="composer__label" htmlFor={id("color-mood")}>
                  Color mood
                </label>
                <input
                  id={id("color-mood")}
                  className="composer__input"
                  type="text"
                  maxLength={MAX_INTENT_TEXT_LENGTH}
                  value={form.colorMood}
                  aria-describedby={id("intent-hint")}
                  onChange={(event) => setForm({ ...form, colorMood: event.target.value })}
                />
              </div>
              <div className="composer__field">
                <label className="composer__label" htmlFor={id("contrast-floor")}>
                  Contrast floor
                </label>
                <select
                  id={id("contrast-floor")}
                  className="composer__select"
                  value={form.colorContrastFloor}
                  aria-describedby={id("intent-hint")}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      colorContrastFloor: event.target.value as FormState["colorContrastFloor"],
                    })
                  }
                >
                  <option value="">Not specified</option>
                  <option value="AA">AA</option>
                  <option value="AAA">AAA</option>
                </select>
              </div>
              <div className="composer__field">
                <label className="composer__label" htmlFor={id("typography-voice")}>
                  Typography voice
                </label>
                <input
                  id={id("typography-voice")}
                  className="composer__input"
                  type="text"
                  maxLength={MAX_INTENT_TEXT_LENGTH}
                  value={form.typographyVoice}
                  aria-describedby={id("intent-hint")}
                  onChange={(event) => setForm({ ...form, typographyVoice: event.target.value })}
                />
              </div>
              <div className="composer__field">
                <label className="composer__label" htmlFor={id("typography-density")}>
                  Typography density
                </label>
                <select
                  id={id("typography-density")}
                  className="composer__select"
                  value={form.typographyDensity}
                  aria-describedby={id("intent-hint")}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      typographyDensity: event.target.value as FormState["typographyDensity"],
                    })
                  }
                >
                  <option value="">Not specified</option>
                  <option value="compact">Compact</option>
                  <option value="regular">Regular</option>
                  <option value="spacious">Spacious</option>
                </select>
              </div>
            </div>
          </fieldset>

          <details className="composer__advanced">
            <summary className="composer__summary">Advanced: explicit reference override</summary>
            <div className="composer__field">
              <label className="composer__label" htmlFor={id("references")}>
                Explicit references, one per line
              </label>
              <textarea
                id={id("references")}
                className="composer__textarea"
                rows={3}
                value={form.referencesText}
                aria-describedby={id("references-hint")}
                onChange={(event) => setForm({ ...form, referencesText: event.target.value })}
              />
              <p className="composer__hint" id={id("references-hint")}>
                Up to {MAX_REFERENCE_IDS} public references. Supplying any of these turns automatic
                retrieval off for this run. Find candidates in <Link to="/browse">Browse</Link>.
              </p>
            </div>
          </details>

          <div className="composer__actions">
            {/* The label is CONSTANT. Swapping it for "Generating…" would change
                the control's accessible name mid-interaction, so a screen-reader
                user who returned to it would hear a different button; the
                lifecycle is reported by the live region instead. */}
            <button type="submit" className="composer__generate" disabled={!canGenerate}>
              Generate handoff
            </button>
          </div>
        </form>

        <section
          className="outcome"
          ref={outcomeRef}
          tabIndex={-1}
          aria-labelledby={id("outcome-title")}
        >
          <h2 className="outcome__title" id={id("outcome-title")}>
            Result
          </h2>
          <p className="outcome__status" role="status" aria-live="polite">
            {statusLabel(lifecycle)}
          </p>

          {lifecycle.kind === "failure" && lifecycle.failure.retryable && (
            <div className="outcome__actions">
              <button type="button" className="outcome__action" onClick={() => void generate()}>
                Try again
              </button>
            </div>
          )}

          {lifecycle.kind === "success" && (
            <ArtifactView artifact={lifecycle.artifact} onStartOver={startOver} />
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Copy the handoff to the clipboard WITHOUT a value-rendering fallback.
 *
 * WHY THIS IS NOT THE SHARED `CopyAction`. That component's documented fallback
 * renders its `value` into the DOM as selectable text
 * (`<code>{value}</code>`) when `navigator.clipboard.writeText` rejects — which
 * Chrome does routinely with "Document is not focused" — or when the async
 * Clipboard API is absent. For a public entry's agent prompt that is a reasonable
 * affordance. For `designMarkdown` it is a publication: those bytes are the
 * server's own rendering and carry `spec.context.productContext`,
 * `spec.citedReferences`, the profile's `sourceId` and URL lines, and
 * `spec.techniques[].text` / `spec.antiPatterns[].text` /
 * `spec.componentInventory` — the exact positions the client's allowlist
 * projection refuses to read. Rendering them on a clipboard failure would defeat
 * the projection through the back door, and would leave the guarantee resting on
 * those producer arrays happening to be empty in this milestone.
 *
 * So `value` NEVER reaches an element here. It goes to `clipboard.writeText` and
 * nowhere else; there is no hidden textarea and no `execCommand` path either,
 * because a transient element would still put the bytes in the document. When the
 * clipboard is unavailable this control says so and points at the download, which
 * saves the very same bytes with the very same hash.
 */
type CopyHandoffState = "idle" | "copied" | "unavailable";

function CopyHandoffAction({
  value,
  label,
}: {
  readonly value: string;
  readonly label: string;
}): ReactElement {
  const [state, setState] = useState<CopyHandoffState>("idle");

  // Return to idle after a successful copy so the control can be reused. The
  // unavailable state is sticky: the operator has to act on it (use the download).
  useEffect(() => {
    if (state !== "copied") return;
    const timer = window.setTimeout(() => setState("idle"), 2_400);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copy = async (): Promise<void> => {
    setState("idle");
    const clipboard = (
      navigator as Navigator & {
        clipboard?: { writeText?: (data: string) => Promise<void> };
      }
    ).clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      setState("unavailable");
      return;
    }
    try {
      // Called as a method so `this` is the clipboard holder, as some engines
      // require — and so a test spy on `navigator.clipboard.writeText` observes it.
      await clipboard.writeText(value);
      setState("copied");
    } catch {
      // A rejection (document not focused, permission, insecure context). Nothing
      // derived from the exception is rendered or logged: its text can quote the
      // request. Never throw into the page.
      setState("unavailable");
    }
  };

  return (
    <span className="copy-handoff">
      {/* The accessible name is CONSTANT, for the same reason the Generate
          button's is: a control that renames itself mid-interaction reads as a
          different control to anyone who returns to it. The outcome is announced
          by the live region below instead. */}
      <button type="button" className="artifact__action" onClick={() => void copy()}>
        {label}
      </button>
      {state !== "idle" && (
        // Rendered only when non-idle: the page's lifecycle live region is the
        // only `role="status"` present at rest.
        <span className="copy-handoff__note" role="status">
          {state === "copied"
            ? `Copied ${DESIGN_MARKDOWN_FILENAME} to the clipboard.`
            : `The clipboard is not available here, and the handoff is not shown as text — use Download ${DESIGN_MARKDOWN_FILENAME} instead. It saves the same bytes, under the same hash.`}
        </span>
      )}
    </span>
  );
}

/**
 * Client-authored, per-state notices for the failed model lane. Keyed on the
 * client's projected {@link ModelExecutionState}: no server string ever becomes
 * one of these. Each one states plainly that the deterministic scaffold above
 * is what was served — the honest reading of every failed state.
 */
const MODEL_EXECUTION_NOTICES: Readonly<
  Record<
    Exclude<ModelExecutionState, "succeeded">,
    { readonly heading: string; readonly note: string }
  >
> = {
  "invalid-configuration": {
    heading: "Model — not configured",
    note: "The model configuration was incomplete, so no model ran. The result above is the deterministic scaffold; fix the configuration and generate again to include a proposal.",
  },
  "call-failed": {
    heading: "Model — call failed",
    note: "The model call failed, so no proposal was produced. The result above is the deterministic scaffold.",
  },
  "proposal-rejected": {
    heading: "Model — proposal rejected",
    note: "The model returned a proposal that could not be accepted, so nothing from it is shown. The result above is the deterministic scaffold.",
  },
  "persistence-failed": {
    heading: "Model — persistence failed",
    note: "The proposal could not be persisted, so it is not shown here. The result above is the deterministic scaffold.",
  },
};

/**
 * The model lane of an artifact: an unaccepted proposal on success, a neutral
 * per-state notice on failure, and NOTHING when no model ran. Fed only the
 * projected {@link SafeModelExecution} / {@link SafeModelProposal}, so a field
 * the projection dropped cannot be rendered here. Deterministic evidence,
 * decisions and unavailable values are rendered by {@link ArtifactView} itself
 * in every model state.
 */
function ModelExecutionSection({
  execution,
  proposal,
}: {
  readonly execution: SafeModelExecution;
  readonly proposal: SafeModelProposal | null;
}): ReactElement {
  if (execution.state === "succeeded") {
    return (
      <section className="artifact__section" aria-labelledby={id("model-title")}>
        <h4 className="artifact__section-title" id={id("model-title")}>
          Model proposal — not accepted
        </h4>
        {proposal !== null && (
          <>
            <p className="artifact__note">
              Produced by {execution.provider} ({execution.model}).
            </p>
            <p className="artifact__note">{proposal.disclaimer}</p>
            <div className="artifact__proposal">
              <ProposalGroups proposal={proposal} />
            </div>
          </>
        )}
      </section>
    );
  }
  const notice = MODEL_EXECUTION_NOTICES[execution.state];
  return (
    <section className="artifact__section" aria-labelledby={id("model-title")}>
      <h4 className="artifact__section-title" id={id("model-title")}>
        {notice.heading}
      </h4>
      <p className="artifact__note">{notice.note}</p>
    </section>
  );
}

/**
 * The proposal card. Every label is proposal-only — "Proposed color tokens"
 * and never "Color tokens" — because nothing in this card was accepted into
 * token authority. Groups render only when the projection carried them.
 */
function ProposalGroups({ proposal }: { readonly proposal: SafeModelProposal }): ReactElement {
  const colorTokens = proposal.colorTokens;
  const typographyTokens = proposal.typographyTokens;
  return (
    <>
      {colorTokens !== null && (
        <div className="artifact__proposal-group">
          <h5 className="artifact__proposal-label">Proposed color tokens</h5>
          <dl className="artifact__facts">
            {(["primary", "surface", "ink", "muted", "accent"] as const).map((key) => (
              <div className="artifact__fact" key={key}>
                <dt>{key}</dt>
                <dd>{colorTokens[key]}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {typographyTokens !== null && (
        <div className="artifact__proposal-group">
          <h5 className="artifact__proposal-label">Proposed typography tokens</h5>
          <dl className="artifact__facts">
            {(["heading", "body", "mono"] as const).map((key) => (
              <div className="artifact__fact" key={key}>
                <dt>{key}</dt>
                <dd>{typographyTokens[key]}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {proposal.motionNotes.length > 0 && (
        <div className="artifact__proposal-group">
          <h5 className="artifact__proposal-label">Proposed motion notes</h5>
          <ul className="artifact__list">
            {proposal.motionNotes.map((note, index) => (
              <li key={index} className="artifact__row">
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposal.contentVoiceGuidance !== null && (
        <div className="artifact__proposal-group">
          <h5 className="artifact__proposal-label">Proposed content voice guidance</h5>
          <p className="artifact__row-body">{proposal.contentVoiceGuidance}</p>
        </div>
      )}
    </>
  );
}

/**
 * The result view. Renders the display-safe half of {@link SafeArtifact} and
 * nothing else — it has no access to the raw response, so it cannot render a field
 * the projection dropped, and it passes `designMarkdown` / `designJson` only to the
 * download and clipboard paths (see the module header).
 */
function ArtifactView({
  artifact,
  onStartOver,
}: {
  readonly artifact: SafeArtifact;
  readonly onStartOver: () => void;
}): ReactElement {
  return (
    <div className="artifact">
      <h3 className="artifact__heading">Design handoff</h3>

      <div className="artifact__actions">
        <button
          type="button"
          className="artifact__action artifact__action--primary"
          onClick={() =>
            downloadExactBytes(
              DESIGN_MARKDOWN_FILENAME,
              // The EXACT bytes the response carried. No request is made.
              artifact.designMarkdown,
              DESIGN_MARKDOWN_MIME,
            )
          }
        >
          Download {DESIGN_MARKDOWN_FILENAME}
        </button>
        <button
          type="button"
          className="artifact__action"
          onClick={() =>
            downloadExactBytes(DESIGN_JSON_FILENAME, artifact.designJson, DESIGN_JSON_MIME)
          }
        >
          Download {DESIGN_JSON_FILENAME}
        </button>
        <CopyHandoffAction value={artifact.designMarkdown} label="Copy markdown" />
        <button type="button" className="artifact__action" onClick={onStartOver}>
          Start over
        </button>
      </div>

      {artifact.modelExecution !== null && (
        <ModelExecutionSection
          execution={artifact.modelExecution}
          proposal={artifact.modelProposal}
        />
      )}

      <section className="artifact__section" aria-labelledby={id("direction-title")}>
        <h4 className="artifact__section-title" id={id("direction-title")}>
          Design direction
        </h4>
        <p className="artifact__direction">{artifact.designDirection}</p>
      </section>

      {(artifact.colorIntent !== null || artifact.typeIntent !== null) && (
        <section className="artifact__section" aria-labelledby={id("intent-title")}>
          <h4 className="artifact__section-title" id={id("intent-title")}>
            Design intent
          </h4>
          <p className="artifact__note">
            Caller-supplied guidance recorded in the spec context. It is not a token decision:
            color and typography tokens are only available when an authoritative design system
            supplies them.
          </p>
          <dl className="artifact__facts artifact__facts--intent">
            {artifact.colorIntent !== null && (
              <div className="artifact__fact">
                <dt>Color intent</dt>
                <dd>
                  {[
                    artifact.colorIntent.accentPreference
                      ? "Accent preference: " + artifact.colorIntent.accentPreference
                      : null,
                    artifact.colorIntent.mood ? "Mood: " + artifact.colorIntent.mood : null,
                    artifact.colorIntent.contrastFloor
                      ? "Contrast floor: " + artifact.colorIntent.contrastFloor
                      : null,
                  ]
                    .filter((value): value is string => value !== null)
                    .join(" · ")}
                </dd>
              </div>
            )}
            {artifact.typeIntent !== null && (
              <div className="artifact__fact">
                <dt>Typography intent</dt>
                <dd>
                  {[
                    artifact.typeIntent.voice ? "Voice: " + artifact.typeIntent.voice : null,
                    artifact.typeIntent.density ? "Density: " + artifact.typeIntent.density : null,
                  ]
                    .filter((value): value is string => value !== null)
                    .join(" · ")}
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {artifact.decisions.length > 0 && (
        <section className="artifact__section" aria-labelledby={id("decisions-title")}>
          <h4 className="artifact__section-title" id={id("decisions-title")}>
            Key decisions
          </h4>
          <ul className="artifact__list" aria-label="Key decisions">
            {artifact.decisions.map((decision) => (
              <li key={decision.id} className="artifact__row">
                <span className="artifact__row-field">{decision.field}</span>
                <span className="artifact__badge">{decision.authority}</span>
                <span className="artifact__badge artifact__badge--muted">{decision.readiness}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="artifact__section" aria-labelledby={id("criteria-title")}>
        <h4 className="artifact__section-title" id={id("criteria-title")}>
          Acceptance criteria
        </h4>
        <ul className="artifact__list" aria-label="Acceptance criteria">
          {artifact.acceptanceCriteria.map((criterion) => (
            <li key={criterion.id} className="artifact__row artifact__row--stacked">
              <span className="artifact__row-head">
                <span className="artifact__badge">{criterion.priority}</span>
                <span className="artifact__row-field">{criterion.subject}</span>
              </span>
              <span className="artifact__row-body">{criterion.expectedOutcome}</span>
              <span className="artifact__row-meta">
                {criterion.assertion} · verified by {criterion.verifier}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {artifact.warnings.length > 0 && (
        <section className="artifact__section" aria-labelledby={id("warnings-title")}>
          <h4 className="artifact__section-title" id={id("warnings-title")}>
            Warnings
          </h4>
          <ul className="artifact__list" aria-label="Warnings">
            {artifact.warnings.map((warning) => (
              <li key={warning.code} className="artifact__row artifact__row--stacked">
                <span className="artifact__badge artifact__badge--warning">{warning.code}</span>
                <span className="artifact__row-body">{warning.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {artifact.unavailableDecisions.length > 0 && (
        <section className="artifact__section" aria-labelledby={id("unavailable-title")}>
          <h4 className="artifact__section-title" id={id("unavailable-title")}>
            Unavailable fields
          </h4>
          <p className="artifact__note">
            The producer declined to decide these rather than inventing them. The handoff says so
            too — this is not a fully model-generated artifact.
          </p>
          <ul className="artifact__list" aria-label="Unavailable fields">
            {artifact.unavailableDecisions.map((decision) => (
              <li key={decision.field} className="artifact__row artifact__row--stacked">
                <span className="artifact__row-field">{decision.field}</span>
                <span className="artifact__row-body">{decision.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="artifact__section" aria-labelledby={id("evidence-title")}>
        <h4 className="artifact__section-title" id={id("evidence-title")}>
          Evidence summary
        </h4>
        <p className="artifact__note">
          Aggregate only. Individual evidence rows, source identities and screenshots are never sent
          to this page.
        </p>
        <dl className="artifact__facts">
          <div className="artifact__fact">
            <dt>Evidence rows cited</dt>
            <dd>{artifact.evidence.evidenceCount}</dd>
          </div>
          <div className="artifact__fact">
            <dt>Retrieval</dt>
            <dd>
              {artifact.evidence.retrievalMode} / {artifact.evidence.retrievalModality}
            </dd>
          </div>
          <div className="artifact__fact">
            {/* `resultCount` counts different things in different retrieval
                states. In `none/none` — the explicit-reference override, which
                this composer exposes under Advanced — it counts RESOLVED
                REFERENCE TOKENS, not corpus observations, so the corpus label
                would be false there. Label per state rather than once. */}
            <dt>
              {artifact.evidence.retrievalMode === "none"
                ? "Explicit references resolved"
                : "Corpus observations retrieved"}
            </dt>
            <dd>{artifact.evidence.corpusResultCount}</dd>
          </div>
          <div className="artifact__fact">
            <dt>Retrieval modes attempted</dt>
            <dd>{artifact.evidence.attemptedCount}</dd>
          </div>
          <div className="artifact__fact">
            <dt>Deterministic fallback</dt>
            <dd>
              {artifact.evidence.fallbackUsed
                ? `used (${artifact.evidence.fallbackReason ?? "reason not reported"})`
                : "not used"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="artifact__section" aria-labelledby={id("integrity-title")}>
        <h4 className="artifact__section-title" id={id("integrity-title")}>
          Artifact integrity
        </h4>
        <p className="artifact__note">
          The semantic hash covers the spec's content with generation time normalized: identical
          semantic content produces the same hash. Of the byte digests below, {DESIGN_JSON_FILENAME}{" "}
          and the spec hash include generation time, so they change between runs even when the
          design does not; the {DESIGN_MARKDOWN_FILENAME} hash does not carry a timestamp, so it
          stays stable while the rendered document does.
        </p>
        <dl className="artifact__facts artifact__facts--hashes">
          <div className="artifact__fact">
            <dt>Semantic spec SHA-256</dt>
            <dd className="artifact__hash">{artifact.semanticSpecSha256}</dd>
          </div>
          <div className="artifact__fact">
            <dt>Producer</dt>
            <dd>{artifact.producerVersion}</dd>
          </div>
          <div className="artifact__fact">
            <dt>Artifact</dt>
            <dd className="artifact__hash">{artifact.artifactId}</dd>
          </div>
          <div className="artifact__fact">
            <dt>Generated at</dt>
            <dd>{artifact.generatedAt}</dd>
          </div>
          <div className="artifact__fact">
            <dt>{DESIGN_MARKDOWN_FILENAME} SHA-256</dt>
            <dd className="artifact__hash">{artifact.designMarkdownSha256}</dd>
          </div>
          <div className="artifact__fact">
            <dt>{DESIGN_JSON_FILENAME} SHA-256</dt>
            <dd className="artifact__hash">{artifact.designJsonSha256}</dd>
          </div>
          <div className="artifact__fact">
            <dt>Spec SHA-256</dt>
            <dd className="artifact__hash">{artifact.specSha256}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
