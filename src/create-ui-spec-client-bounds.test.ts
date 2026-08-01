/**
 * create-ui-spec-client-bounds.test.ts — pins the BROWSER client's hand-written
 * shape check against the real server schema.
 *
 * WHY THIS TEST EXISTS, AND WHY IT LIVES IN `src/`. `site/src/data/create-ui-spec.ts`
 * re-checks the served envelope on its own side, deliberately by hand: the browser
 * is its own trust boundary and every accepted position should be visible in one
 * place. The cost is a SECOND description of the same contract, and a second
 * description can drift. The dangerous direction of drift is the client being
 * NARROWER than the schema: a response the server considers legal — and which
 * passed the producer's own re-render and integrity checks — is then refused
 * whole, the operator sees only "The response did not match the expected artifact
 * shape", and the generation is lost with no way to tell a corrupt artifact from
 * an undersized client bound.
 *
 * Neither of the site suites can catch that. Both exercise only what TODAY'S
 * producer emits, and today's recipe-authored strings sit far under any plausible
 * cap. So this test builds a real envelope, INFLATES every position the schema
 * leaves unbounded to a length no earlier client bound would have admitted, proves
 * the inflated envelope is still schema-legal, and then proves the browser client
 * accepts it. It has to live here because the envelope schema lives here (the site
 * app must not import `src/`), and it runs in the root suite's node environment —
 * the client module touches `document` only inside its download helper.
 *
 * NO NETWORK, NO PROVIDER. The envelope comes from the same in-memory fixture the
 * browser suite uses (the real `handleCreateUiSpecHttp` over a fake reader), and
 * the client is driven with an injected `fetch` stub.
 */
import { describe, expect, it } from "vitest";

import { DesignArtifactEnvelopeSchema } from "./create-ui-spec-contracts.js";
// A test-only helper. It calls the real loopback adapter over an in-memory reader,
// so the starting envelope is the exact shape the route serves.
import { designIntentArtifact, keywordMatchedArtifact } from "../site/tests/create-ui-spec-fixture.js";
import { requestDesignArtifact, resetCachedNonce } from "../site/src/data/create-ui-spec.js";

const BRIEF = { productContext: "A calm analytics dashboard for a fintech operations team" };
const NONCE = "f".repeat(64);

/** A long, marker-free string. The private-marker sweep must still pass. */
function long(n: number): string {
  return "lorem ipsum ".repeat(Math.ceil(n / 12)).slice(0, n);
}

/**
 * A free-text intent member at its exact max(120) bound. Whitespace-free on
 * purpose: the schema trims, so a padded string of 120 would arrive shorter and
 * the assertion would be testing the trim rather than the bound.
 */
const MAX_INTENT_TEXT = "a".repeat(120);

/** Serve `{ nonce }`, then the envelope, to the client under test. */
function stubFetch(envelope: unknown): typeof fetch {
  let call = 0;
  return (async () => {
    call += 1;
    const json = call === 1 ? { nonce: NONCE } : envelope;
    return { ok: true, status: 200, json: async () => json } as unknown as Response;
  }) as unknown as typeof fetch;
}

/**
 * The positions the server schema leaves unbounded (`z.string().trim().min(1)`
 * with no `.max()`), inflated well past every maximum the client used to impose:
 * `subject` 500, `expectedOutcome` 1 000, `unavailableDecisions[].reason` 1 000,
 * `citedDecisions[].id`/`field` 200, `acceptanceCriteria[].id` 200.
 */
async function inflatedEnvelope(): Promise<Record<string, unknown>> {
  const fixture = await keywordMatchedArtifact(BRIEF.productContext);
  const envelope = structuredClone(fixture.envelope) as Record<string, unknown>;
  const spec = envelope.spec as Record<string, unknown>;

  const criteria = spec.acceptanceCriteria as Array<Record<string, unknown>>;
  expect(criteria.length).toBeGreaterThan(0);
  for (const row of criteria) {
    row.subject = long(4_000);
    row.expectedOutcome = long(6_000);
  }

  // `unavailableDecisions[].field` is NOT inflated: a cross-field refinement in
  // UiSpec requires the exact names `colorTokens` / `typographyTokens` / `motion`
  // to be present when the corresponding spec field is null. `reason` is the free
  // text and the position the operator actually reads.
  const unavailable = spec.unavailableDecisions as Array<Record<string, unknown>>;
  expect(unavailable.length).toBeGreaterThan(0);
  for (const row of unavailable) {
    row.reason = long(6_000);
  }

  const decisions = spec.citedDecisions as Array<Record<string, unknown>>;
  expect(decisions.length).toBeGreaterThan(0);
  for (const row of decisions) {
    row.field = `${String(row.field)}-${long(1_000)}`;
  }

  return envelope;
}

describe("browser client bounds vs. the envelope schema", () => {
  it("the inflated envelope is still legal per DesignArtifactEnvelopeSchema", async () => {
    const envelope = await inflatedEnvelope();
    const parsed = DesignArtifactEnvelopeSchema.safeParse(envelope);
    // If this ever fails, the schema GAINED a bound — and the client may then
    // legitimately carry the same bound. Read the issue before loosening anything.
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it("the browser client accepts every string the schema leaves unbounded", async () => {
    const envelope = await inflatedEnvelope();
    resetCachedNonce();
    const result = await requestDesignArtifact(BRIEF, { fetchImpl: stubFetch(envelope) });

    if (!result.ok) {
      throw new Error(
        `the browser client refused a schema-legal artifact with ${result.failure.code}: ` +
          "its shape check is narrower than the server contract",
      );
    }
    expect(result.artifact.acceptanceCriteria[0].subject).toHaveLength(4_000);
    expect(result.artifact.acceptanceCriteria[0].expectedOutcome).toHaveLength(6_000);
    expect(result.artifact.unavailableDecisions[0].reason).toHaveLength(6_000);
    expect(result.artifact.decisions[0].field.length).toBeGreaterThan(1_000);
  });

  it("the browser client accepts an artifact carrying caller constraints and design intent", async () => {
    // The dangerous drift direction again, for the positions S1/S2 added. The
    // client's hand-written shape check predates both: a `spec.context` that now
    // carries `colorIntent`/`typeIntent`, and an `acceptanceCriteria` array that
    // is no longer length-1. If the client refuses either, the operator loses the
    // generation to "did not match the expected artifact shape" — a message that
    // cannot distinguish a corrupt artifact from an undersized client bound.
    //
    // The extras use MAXIMUM-length free-text members and the maximum constraint
    // count, so the check is against the real bounds rather than today's short
    // sample values.
    const fixture = await designIntentArtifact(BRIEF.productContext, {
      constraints: Array.from({ length: 12 }, (_, i) => `${long(499)}${i % 10}`),
      colorIntent: { accentPreference: MAX_INTENT_TEXT, mood: MAX_INTENT_TEXT, contrastFloor: "AAA" },
      typeIntent: { voice: MAX_INTENT_TEXT, density: "spacious" },
    });
    const envelope = fixture.envelope;

    // The producer accepted it, so it is by construction schema-legal — assert
    // that the intent actually reached the served spec before testing the client.
    const spec = envelope.spec as Record<string, unknown>;
    const context = spec.context as Record<string, unknown>;
    expect(context.colorIntent).toEqual({
      accentPreference: MAX_INTENT_TEXT,
      mood: MAX_INTENT_TEXT,
      contrastFloor: "AAA",
    });
    expect(context.typeIntent).toEqual({ voice: MAX_INTENT_TEXT, density: "spacious" });
    const criteria = spec.acceptanceCriteria as Array<Record<string, unknown>>;
    // One recipe criterion + twelve caller constraints.
    expect(criteria).toHaveLength(13);

    resetCachedNonce();
    const result = await requestDesignArtifact(BRIEF, { fetchImpl: stubFetch(envelope) });
    if (!result.ok) {
      throw new Error(
        `the browser client refused an intent-bearing artifact with ${result.failure.code}: ` +
          "its shape check is narrower than the server contract",
      );
    }
    // The client currently drops `context` by design, so this asserts only that
    // the criteria survived; projecting the intent itself is the site's task.
    expect(result.artifact.acceptanceCriteria).toHaveLength(13);
    expect(result.artifact.acceptanceCriteria.map((c) => c.id)).toContain("caller-constraint-12");
  });

  it("the browser client still refuses a genuinely wrong shape", async () => {
    // The loosened bounds must not have turned the check into a rubber stamp.
    const envelope = await inflatedEnvelope();
    delete envelope.designJson;
    resetCachedNonce();
    const result = await requestDesignArtifact(BRIEF, { fetchImpl: stubFetch(envelope) });
    expect(result.ok).toBe(false);
  });
});
