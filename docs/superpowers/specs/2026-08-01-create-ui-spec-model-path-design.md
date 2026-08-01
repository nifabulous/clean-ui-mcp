# `create_ui_spec` Model Path Design

Status: design only. This document does not add a provider call, change the C3
recipe, or write to the corpus.

## Purpose

The current `create_ui_spec` producer is intentionally deterministic. It can
assemble a grounded handoff from the private corpus, public references, and the
operator-authored `c3-fallback-v1` recipe, but it does not pretend that a model
was involved. A future model path may propose richer direction, tokens, and
motion guidance, but it must preserve that honesty boundary.

The model path must therefore answer four questions before implementation:

1. What is model output, and where is it classified?
2. Which exact endpoint and model produced it?
3. What does the integrity claim mean when a provider is nondeterministic?
4. Where can generated history live without becoming corpus evidence?

## Decisions Required Before Coding

These are the decisions that block implementation. The recommended choices are
defaults for review, not silently accepted policy.

| Decision | Recommended choice | Reason |
| --- | --- | --- |
| Saved output semantics | Store generated output in a separate model-artifact store. Never add it to `corpus/entries.json`, `corpus/decisions.json`, or the corpus reader. | Generated history is not an observation of a source. Reusing the corpus store would make a later retrieval look like evidence. |
| Determinism claim | Keep `semanticSpecSha256` as a content claim. Add a separate reproducibility claim that is conditional on the pinned provider, endpoint, model, prompt, parameters, and seed. | Temperature 0 does not make every provider byte-identical. A model path must not promise more than the provider can guarantee. |
| C3 anchor | Treat the existing C3 anchor as historical for this design. Do not re-anchor or edit `C3_RECIPE` as part of the model path. Re-anchor only as a separately approved release action. | Adding a model capability must not silently reopen the signed deterministic baseline. |

If the first choice is rejected, the safe alternative is ephemeral model output:
the response may carry it for the current artifact, but no later retrieval or
history feature may read it. The unsafe alternative is saving it as a
`corpus-observation`; that option is excluded.

## Current Contract Boundary

`src/create-ui-spec-contracts.ts:247` currently defines exactly three evidence
kinds:

- `corpus-observation`: a sanitized summary derived from a private corpus entry;
- `public-reference`: explicit public input;
- `recipe-system`: deterministic operator content from `c3-fallback-v1`.

`recipe-system` cannot be repurposed for model output. The contract explicitly
defines it as operator-authored content, and its basis cannot be
`user-supplied`. `corpus-observation` is also incorrect because a model response
is not directly observed source material.

The implementation must choose one of these explicit shapes:

1. Keep model output outside `SanitizedEvidenceSchema` and store it as a
   separately typed generated proposal. This is the preferred first slice when
   model output is only a producer input.
2. Add a closed `model-output` evidence variant with provider/model provenance,
   a bounded output reference, and a basis value that means generated rather
   than observed. This is required only if model output needs to participate in
   the evidence lanes or be cited by a decision.

Either shape must be `.strict()`, bounded, private-marker screened, and assigned
response-scoped IDs if exposed over a transport. Neither shape may carry a
private corpus ID, source path, provider credential, raw provider body, or an
unbounded prompt/response transcript.

## Endpoint Pinning

The model request must carry an explicit endpoint record:

```ts
type PinnedModelEndpoint = {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
};
```

The key is an in-memory secret and is never serialized, logged, included in the
artifact identity, or written to generated history. `baseUrl` and `model` are
part of the pinned execution context and must be validated before the call.

`src/tagger.ts:323-330` shows the existing provider configuration pattern, but
`openaiConfigForPass()` resolves values from ambient environment variables. The
new model path must not use that resolution as its source of truth. Instead, it
should reuse the provider transport mechanics through the explicit pinned
request contract used by `TextModelRequest` at `src/tagger.ts:364-374`.

The model path must fail closed when any of `provider`, `baseUrl`, `apiKey`, or
`model` is absent. It must not silently select another provider, another model,
or a process environment default after a request fails.

Provider diagnostics are internal only. Response bodies, request headers,
credentials, filesystem paths, and raw exception messages never enter the
artifact or a user-facing error.

## Proposed Execution Flow

1. Parse the caller request with the existing strict request schema.
2. Resolve and sanitize corpus/public evidence using the existing reader.
3. Assemble the deterministic scaffold first. This is the fallback floor and
   remains usable when no model is configured.
4. If the model path is enabled, construct a bounded prompt from approved
   inputs. Keep evidence IDs and private source identity out of the model's
   public output contract.
5. Call exactly the pinned endpoint. Record provider, base URL origin, model,
   prompt hash, generation parameters, seed if supplied, and request status in
   internal provenance. Never record the API key.
6. Parse the model response into a strict proposal schema. Reject unknown keys,
   oversized strings, private markers, invalid token values, and unsupported
   authority claims.
7. Apply the proposal only through the authority rules below. A model response
   cannot promote itself to corpus evidence.
8. If the call, parse, or authority check fails, return the deterministic
   scaffold with an honest unavailable/warning state. Do not partially merge an
   invalid proposal.
9. Re-run the existing envelope parser and served-byte gates before returning
   the artifact.

## Fallback Floor

The deterministic producer remains the minimum successful result:

- `colorTokens` and `typographyTokens` stay `null` unless exact valid tokens
  have a permitted authority;
- `motionGuidance.evidenceUnavailable` stays truthful;
- each unavailable field has its required `unavailableDecisions` row;
- no model warning is converted into a corpus warning or a successful claim;
- `c3-fallback-v1` remains the recipe-system source for the deterministic path.

Model failure is not the same thing as retrieval failure. The UI and envelope
must distinguish at least:

- no model configured;
- model call failed or was refused;
- model proposal rejected by schema or authority checks;
- deterministic retrieval fallback used.

## Token Authority

`src/tool-contracts.ts:482-484` currently permits:
`team-design-system`, `project-constraint`, `corpus-evidence`, `editorial`, and
`mixed`.

The current null-token refinement at `src/tool-contracts.ts:653-701` is
load-bearing:

- null color tokens require editorial authority plus an unavailable
  `colorTokens` decision;
- available color tokens must not retain that unavailable decision;
- the equivalent rule applies to typography;
- unavailable motion requires the `motion` decision, while available motion
  must remove it.

A model proposal must not be labeled `corpus-evidence` merely because the model
saw corpus-derived context. The evidence that grounded a decision must remain
explicit and cited. The model is a transformation, not the source observation.

Before implementation, choose one of these authority policies:

- **Proposal-only:** model output is displayed as a proposal, tokens remain
  unavailable until a caller or identified team design system supplies/accepts
  exact values. This requires the smallest contract change and is recommended.
- **New model authority:** add a closed `model-proposal` authority and update
  all authority-lane, citation, documentation, and null-token checks. This is
  appropriate only if model-generated values are intended to be first-class
  artifact decisions before human acceptance.
- **Accepted constraint:** a caller supplies exact values and the model only
  formats or checks them. Authority remains `project-constraint`; the existing
  non-empty constraints prerequisite must remain true.

The model must never turn a mood word such as "calm" into a fabricated full
color or typography system and label it as settled. Intent and materialized
tokens remain separate concepts.

## Integrity Claims

The existing identity chain is:

```text
spec content -> semanticSpecSha256 -> artifactId
```

The model path must preserve that chain. Any model-derived content visible in
`spec` changes `semanticSpecSha256` and therefore `artifactId`. Do not add a
second model-only identity lane that can change an ID while the visible spec is
unchanged.

The claims are deliberately split:

- `semanticSpecSha256`: this artifact's semantic spec content;
- byte hashes: the exact generated spec/rendering bytes, including timestamped
  provenance where applicable;
- `reproducible`: whether the producer can reproduce the semantic result under
  the same pinned endpoint, model, prompt hash, parameters, and seed;
- `deterministic`: reserved for the current recipe path or a future provider
  contract that can actually prove byte-independent semantic output.

Two model requests with different provider, model, prompt, or seed metadata must
not be described as the same reproducibility class. A same-content result may
still have a different execution record; the artifact should expose those
claims separately rather than overloading the semantic hash.

## Storage And Corpus Separation

The recommended store is a separate generated-artifact history keyed by the
artifact ID. It must have its own schema and reader, and it must not be passed to
`PrivateCorpusReader`, `PublicCorpusReader`, or any retrieval ranking path.

The store must enforce:

- no writes to `corpus/entries.json` or `corpus/decisions.json`;
- no automatic promotion of a model output into a corpus observation;
- no corpus IDs or filesystem paths in the stored public record;
- explicit retention/deletion semantics;
- separate integrity metadata for the provider execution;
- no read path from `create_ui_spec` until a later contract explicitly defines
  generated-history retrieval.

If the decision is ephemeral output instead, the response must still carry
bounded provenance sufficient to explain the result, but it must not imply that
the output will be available as evidence on a later run.

## Test Requirements Before Implementation

The implementation PR must include tests for:

- missing or partial endpoint configuration fails closed;
- an ambient model environment variable cannot override a pinned model;
- provider failure does not fall through to another provider silently;
- malformed, oversized, or private-marker-bearing model output is rejected;
- model output is never classified as `corpus-observation` by default;
- exact token availability removes the matching unavailable decision;
- null-token and unavailable-motion refinements remain enforced;
- differing model-derived content changes `semanticSpecSha256` and `artifactId`;
- equal semantic content with a new timestamp keeps the semantic hash stable;
- reproducibility metadata does not get confused with deterministic identity;
- the fallback floor remains valid with no model configured;
- the generated store, if selected, is not read by corpus retrieval and does not
  mutate the frozen corpus files;
- HTTP/MCP responses contain no provider body, credential, path, or raw corpus
  identity.

## C3 And Release Boundary

This design does not edit `src/c3/fallback-recipe-v1.json`, `RECIPE_SHA256`, or
the existing C3 anchor. The deterministic path remains the reference baseline
against which the model path is compared.

If the project later decides that the model path changes the signed C3 contract,
that work must be a separate release action with a new anchor, regenerated
artifacts, and a new readiness review. It must not be smuggled into the first
model implementation PR.
