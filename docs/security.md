# Security Notes

## Create UI Spec Model Artifact Store

The proposal-only model path keeps generated history in a separate gitignored
store: `.create-ui-spec-model-artifacts/`.

Records in that store:

- persist until `ModelArtifactStore.delete(artifactId)` is called;
- are permanently removed by that delete operation;
- are not corpus data;
- are not retrieval input;
- are not readable through `create_ui_spec`.

This store exists to retain validated proposal metadata without promoting model
output into `corpus/entries.json`, `corpus/decisions.json`, or any corpus
reader/ranking path.

### Configuration

The model lane is an env-only opt-in for composition roots. All four variables
must be set for the lane to run:

- `CREATE_UI_SPEC_MODEL_PROVIDER` — one of `openai`, `claude`, `gemini`,
  `mistral`, `minimax`, `grok`;
- `CREATE_UI_SPEC_MODEL_BASE_URL` — an `https:` URL with no userinfo;
- `CREATE_UI_SPEC_MODEL_API_KEY` — the credential for that endpoint;
- `CREATE_UI_SPEC_MODEL_NAME` — the pinned model name.

All four unset ⇒ the deterministic runner runs and the envelope carries no
model trace. A PARTIAL tuple ⇒ `invalid-configuration`: the model lane never
silently falls back to determinism while pretending no model was intended.

### Fixed generation parameters

First-slice generation is pinned: `temperature: 0`, `maxOutputTokens: 4096`,
`maxAttempts: 1`, `seed: null`. These values are recorded; deterministic
reproducibility is never claimed.

### No-fallback behavior

The model lane never uses ambient provider keys, never retries a failed call,
and never falls back to another provider or model. A configured call uses
exactly the tuple above, and any failure discards the model output entirely.

### Proposal-only authority

Model output is a proposal. Accepted token authority is unchanged:
`colorTokens` and `typographyTokens` stay `null` with `editorial` authority,
and the accepted-token positions stay unavailable to callers. A visible
proposal participates in `semanticSpecSha256` and `artifactId`; timestamps and
execution metadata do not.

### Distinct public failure states

`invalid-configuration`, `call-failed`, `proposal-rejected`, and
`persistence-failed` are distinct envelope states, each mapping to the same
deterministic scaffold the no-config lane serves. A failure never produces a
partial or half-validated proposal.

### History, retention, and deletion

Records persist until `ModelArtifactStore.delete(artifactId)` is called;
deletion is permanent. First write wins: a rerun with the same semantic
identity cannot overwrite or duplicate an existing record. The store is never
imported by corpus readers or ranking code.

### Conditional reproducibility

Reproducibility is conditional on the corpus as well as the caller's inputs:
retrieval reads a mutable corpus that is not one of the caller's inputs, so
requests with identical caller inputs can differ if the corpus changed between
runs. The deterministic lane is reproducible given identical caller inputs and
identical corpus state. The model lane is conditional again: temperature 0 and
pinned parameters narrow the distribution, but the semantic identity of a
proposal run also depends on what the provider actually returns, so it is only
reproducible given identical model output as well. In both lanes the spec hash
varies with generation time, so two runs are never byte-identical.

### No history read path

Model history is not readable through `create_ui_spec` — neither the MCP tool
nor the HTTP route exposes records, prompts, usage, or diagnostics.
