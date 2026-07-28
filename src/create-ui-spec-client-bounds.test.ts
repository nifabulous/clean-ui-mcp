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
import { keywordMatchedArtifact } from "../site/tests/create-ui-spec-fixture.js";
import { requestDesignArtifact, resetCachedNonce } from "../site/src/data/create-ui-spec.js";

const BRIEF = { productContext: "A calm analytics dashboard for a fintech operations team" };
const NONCE = "f".repeat(64);

/** A long, marker-free string. The private-marker sweep must still pass. */
function long(n: number): string {
  return "lorem ipsum ".repeat(Math.ceil(n / 12)).slice(0, n);
}

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

  it("the browser client still refuses a genuinely wrong shape", async () => {
    // The loosened bounds must not have turned the check into a rubber stamp.
    const envelope = await inflatedEnvelope();
    delete envelope.designJson;
    resetCachedNonce();
    const result = await requestDesignArtifact(BRIEF, { fetchImpl: stubFetch(envelope) });
    expect(result.ok).toBe(false);
  });
});
