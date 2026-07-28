import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { Link } from "react-router-dom";
import { CopyAction } from "../components/CopyAction";
import {
  BRIEF_MAX_LENGTH,
  BRIEF_MIN_LENGTH,
  DESIGN_JSON_FILENAME,
  DESIGN_JSON_MIME,
  DESIGN_MARKDOWN_FILENAME,
  DESIGN_MARKDOWN_MIME,
  MAX_CONSTRAINTS,
  MAX_REFERENCE_IDS,
  briefValidationMessage,
  downloadExactBytes,
  requestDesignArtifact,
  type BriefPlatform,
  type CreateUiSpecFailure,
  type DesignBrief,
  type LifecyclePhase,
  type SafeArtifact,
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
 * WHAT REACHES THE DOM. Only {@link SafeArtifact}, the allowlist projection built
 * by the client from CHECKED response positions: the design direction, the key
 * decisions' structured positions, the acceptance criteria, the producer's
 * warnings, the fields it could not decide, and an AGGREGATE evidence summary
 * (counts plus retrieval metadata). No raw corpus id, source identity, product
 * name, image path, screenshot, critique, provider diagnostic, credential, or
 * filesystem path is projected, so none can be rendered — not because a scrubber
 * removed it, but because the object this component reads does not carry it.
 *
 * The producer echoes the caller's own brief into `spec.context.productContext`.
 * The projection drops it: an operator's own brief read back is not a result. The
 * `designDirection` IS rendered — it is the producer's direction statement and the
 * design names it as displayable. It is producer free text, so this component
 * makes no claim about its prose; the only claim made anywhere on this path is
 * about ID and path SHAPE, which the client re-checks itself.
 *
 * DOWNLOADS NEVER REGENERATE. Both renderings arrive in the single response and
 * live in component state. The download handlers read `artifact.designMarkdown` /
 * `artifact.designJson` from that state and call {@link downloadExactBytes},
 * which touches no network. Re-requesting would produce a different
 * `generatedAt` — and therefore a different artifact identity — than the one the
 * operator just reviewed, so the reviewed bytes are the only bytes that can be
 * saved. The returned hashes are displayed so the saved file can be verified.
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
  | { readonly kind: "failure"; readonly failure: CreateUiSpecFailure };

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
  return failureLabel(lifecycle.failure);
}

/**
 * Success copy, three-way and deliberately not collapsed.
 *
 * "Used the deterministic fallback" and "carries warnings" are DIFFERENT claims.
 * The producer emits `motionEvidenceUnavailable` on essentially every run that
 * supplies no motion intents, while `fallbackUsed` stays false whenever keyword
 * retrieval matched — so folding warnings into the fallback wording would
 * mislabel almost every genuine keyword-matched artifact as a fallback. Equally,
 * an artifact carrying warnings is not a "complete" handoff.
 */
function successLabel(artifact: SafeArtifact): string {
  if (artifact.evidence.fallbackUsed) {
    return "Generated a design handoff using the deterministic fallback — automatic retrieval matched nothing. This is not a fully model-generated artifact; the unavailable fields are listed below.";
  }
  if (artifact.warnings.length > 0) {
    const count = artifact.warnings.length;
    return `Generated a design handoff with ${count} ${count === 1 ? "warning" : "warnings"}. Some fields were unavailable — see below.`;
  }
  return "Generated a complete design handoff.";
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
function failureLabel(failure: CreateUiSpecFailure): string {
  switch (failure.code) {
    case "INVALID_INPUT":
      return "The brief could not be accepted. Adjust the brief or the optional controls and generate again.";
    case "PROVIDER_ERROR":
      return failure.retryable
        ? "Generation could not run right now. Your brief is unchanged — try again."
        : "Generation could not run and retrying would fail the same way. Check the local server output.";
    case "CSRF_REJECTED":
      return "Generation could not be authorized by the local server. It may have restarted — try again.";
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

export function PlaygroundPage(): ReactElement {
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
        : { kind: "failure", failure: result.failure },
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
                retrieval off for this run.
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
 * The result view. Renders {@link SafeArtifact} and nothing else — it has no
 * access to the raw response, so it cannot render a field the projection dropped.
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
        <CopyAction value={artifact.designMarkdown} label="Copy markdown" />
        <button type="button" className="artifact__action" onClick={onStartOver}>
          Start over
        </button>
      </div>

      <section className="artifact__section" aria-labelledby={id("direction-title")}>
        <h4 className="artifact__section-title" id={id("direction-title")}>
          Design direction
        </h4>
        <p className="artifact__direction">{artifact.designDirection}</p>
      </section>

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
            <dt>Corpus observations retrieved</dt>
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
          These are the hashes the server returned with this artifact. The downloads above save the
          exact bytes those hashes cover — nothing is regenerated when you save.
        </p>
        <dl className="artifact__facts artifact__facts--hashes">
          <div className="artifact__fact">
            <dt>Artifact</dt>
            <dd className="artifact__hash">{artifact.artifactId}</dd>
          </div>
          <div className="artifact__fact">
            <dt>Generated at</dt>
            <dd>{artifact.generatedAt}</dd>
          </div>
          <div className="artifact__fact">
            <dt>Producer</dt>
            <dd>{artifact.producerVersion}</dd>
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
