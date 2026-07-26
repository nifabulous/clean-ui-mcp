# C3 `create_ui_spec` First Slice Design

**Status:** Approved design
**Date:** 2026-07-27
**Scope:** The first user-testable C3 vertical slice

## Goal

Let a user submit a product brief and receive a validated, evidence-grounded
`UiSpec` plus deterministic `DESIGN.md` and JSON handoffs. The same producer
must be usable through the MCP tool and the local/operator-hosted Playground.

The slice is stateless. It proves the synthesis and safety path without adding
project persistence, immutable revision storage, Decision Lab, critique
integration, or multi-user hosting.

## Decisions

- Ship one end-to-end vertical slice rather than all of C3 at once.
- Use a shared producer core with thin MCP and HTTP/Playground adapters.
- Use a hybrid producer: deterministic assembly is always available; an
  optional live provider may enrich candidate decisions.
- Automatically retrieve up to five diverse references when the caller does
  not provide `referenceIds`. Explicit references remain supported as an
  advanced override.
- Treat model output as untrusted candidate decisions, never as a `UiSpec` or
  evidence authority.
- Return a valid deterministic spec when no provider is configured or a live
  provider fails. Record unavailable model-dependent decisions and typed
  warnings instead of fabricating values.
- Run the first slice locally/operator-hosted. The server may read the private
  corpus; public output may contain only sanitized, response-scoped evidence.
- Preserve `UiSpec` 1.0. Add a `DesignArtifactEnvelope` around it instead of
  moving identity fields into the schema during this slice.
- Use the focused composer Playground layout: brief first, then result and
  downloads. Do not add project or revision UI yet.

## Architecture

```text
MCP create_ui_spec ─┐
                    ├── createUiSpec(input, dependencies)
Playground HTTP ────┘             │
                                  ├── evidence resolver
                                  ├── evidence sanitizer
                                  ├── candidate provider
                                  ├── deterministic assembler
                                  ├── UiSpec validator
                                  └── handoff renderer
```

`createUiSpec` is the behavioral authority. Adapters only parse transport
input, invoke the service, and map its result into their transport contract.
Neither adapter may construct `UiSpec`, assign evidence authority, or render a
second representation.

### Evidence resolution

The resolver accepts explicit `referenceIds` or performs ranked retrieval from
the injected `CorpusReader`. Automatic selection uses the existing relevance
path and product-diversity rule, with a maximum of five references. It returns
truthful retrieval metadata, including fallback and sparse-coverage states.

Explicit IDs are validated against the reader and bounded by the input schema.
Missing or inaccessible references do not get silently replaced with a
different identity. The resolver either records the bounded omission and uses
the remaining valid evidence, or returns a typed input error when the request
cannot produce a meaningful result.

### Sanitization boundary

The private evidence bundle exists only inside the producer request. Before it
reaches a candidate provider or renderer, a sanitizer projects it to safe,
response-scoped evidence:

- no private corpus IDs, image paths, source URLs, product identities learned
  from the corpus, or recognizable critique excerpts;
- no screenshots or reconstructable visual assets;
- transferable observations, aggregate principles, machine rules, and
  editorial guidance only;
- explicit user-supplied identities remain marked as user input rather than
  corpus observations.

The resulting evidence IDs are local to the response, such as `evidence-1`.
Internal corpus IDs are never echoed into `citedReferences`, `referenceIds`,
`DESIGN.md`, JSON, browser DOM, logs, or analytics.

## Provider and assembly model

The producer depends on an injected `UiSpecCandidateProvider`:

```text
providerId
providerVersion
generate(candidateInput): Promise<CreateUiSpecCandidate>
```

`CreateUiSpecCandidate` is a versioned internal schema containing proposed
decisions, prose, and evidence IDs. It has no authority lane, private identity,
artifact hash, or permission to claim evidence membership.

Two providers are required:

1. **Deterministic provider:** offline and reproducible. It uses the brief,
   sanitized evidence, existing aggregation/rule helpers, and explicit
   editorial defaults. Fields that cannot be supported remain unavailable.
2. **Live provider:** opt-in and provider-neutral. It uses the existing model
   call boundary with a pinned provider/model, bounded prompt and output size,
   strict JSON parsing, and no automatic provider fallback or repair call.

The deterministic assembler always creates the base candidate. A model result
may enrich a field only when its evidence IDs exist in the sanitized evidence
set and the proposed value passes the field's constraints. The assembler,
not the model, assigns `authorityLanes`, `CitedDecision.authority`, readiness,
warnings, and unavailable decisions. The complete result is parsed through the
existing strict `UiSpec` schema before rendering.

Provider absence, timeout, malformed JSON, invalid candidate data, or provider
error produces the deterministic result with a typed warning. The request is
not treated as a fatal error unless deterministic assembly or final contract
validation fails.

Provider identity, prompt hashes, usage, and failure diagnostics are private
operator diagnostics. They do not enter the public `UiSpec`, `DESIGN.md`, JSON
handoff, or browser response.

## Artifact contract

`UiSpec` 1.0 remains the semantic source of truth. The producer creates a safe
`DesignArtifactEnvelope` around it:

```text
artifactVersion: "1.0"
artifactId: deterministic hash-derived identifier
generatedAt: ISO timestamp
spec: validated UiSpec 1.0
handoff: validated web target and motion intents
designMarkdown: deterministic DESIGN.md bytes
designJson: deterministic JSON handoff bytes
specSha256: hash of canonical spec bytes
designMarkdownSha256: hash of exact markdown bytes
retrieval: truthful safe retrieval metadata
warnings: typed public warnings
```

`artifactId` is derived from canonical semantic content and handoff inputs, not
wall-clock time. `generatedAt` is metadata only. The existing deterministic
handoff renderer remains the sole renderer for both output formats.

The MCP adapter registers the beta `create_ui_spec` contract. Its structured
`data` is the validated `UiSpec`; `content[0]` is the requested rendering:

- `serializationFormat: "brief"` returns `DESIGN.md`;
- `serializationFormat: "tokens"` returns the stable JSON handoff.

The HTTP adapter returns the safe artifact envelope with both renderings so the
Playground can offer downloads without another generation request. The public
beta catalog follows the existing no-alias rule: the old
`generate_design_prompt` implementation may remain as an internal helper, but
it is not a second public name for the new tool.

## Playground experience

The first Playground surface is a focused composer, not a dashboard.

### Idle

- brief textarea with an 8-character minimum;
- optional platform, implementation framework, design-system, and constraint
  controls;
- collapsed advanced reference override;
- Generate disabled until input is valid.

### Generating

The UI reports only real lifecycle stages: resolving references, preparing
sanitized evidence, assembling the spec, validating, and rendering. It does
not show fabricated percentage progress. Submit controls are disabled and
status changes are announced through `aria-live`.

### Success

The composer transitions to a result view with actions to download
`DESIGN.md`, download JSON, copy markdown, and start over. The result presents
the design direction, key decisions, acceptance criteria, warnings, and safe
aggregate evidence summary. It never displays private corpus cards,
screenshots, IDs, paths, or source identities.

### Partial success

Fallback output remains downloadable. The UI names unavailable provider-
dependent fields and explains why they are unavailable. It never labels a
fallback artifact as fully model-generated.

### Failure

Input and contract failures are inline and actionable. Fatal retrieval errors
preserve the brief and offer retry. Provider failures use the deterministic
fallback path instead of entering the fatal state.

## Security and privacy

- The public static site never bundles or imports the private corpus.
- The local HTTP route runs beside the operator-controlled server and uses the
  same sanitized service boundary as MCP.
- Sanitization runs before model calls, rendering, and response serialization.
- Private markers, paths, source URLs, and internal IDs are rejected by
  boundary tests over the complete serialized envelope.
- User screenshots, uploads, credentials, and raw provider output are outside
  this slice and are not persisted.
- Multi-tenant authentication, tenant isolation, retention policy, and BYOK
  are deferred to hosted-service work.

## Testing and release gates

### Core

- input normalization and automatic/explicit evidence selection;
- product-diverse retrieval bounds and truthful fallback metadata;
- private-evidence sanitization and response-scoped IDs;
- candidate evidence membership and deterministic authority assignment;
- deterministic behavior for absent, malformed, timed-out, and rejected
  providers;
- strict `UiSpec` validation;
- stable artifact IDs and byte-identical JSON/Markdown rendering;
- absence of private markers and raw corpus material.

### MCP

- exact `create_ui_spec` input/output schema;
- standard envelope invariants;
- `data` equals the validated `UiSpec`;
- `content[0]` matches the requested rendering;
- retrieval metadata and warning coupling;
- beta catalog contains the intended public names and no legacy alias.

### HTTP and browser

- adapter mapping uses the same producer service;
- idle, generating, success, fallback, validation-error, and retry states;
- downloaded bytes match returned hashes;
- keyboard-complete controls, visible focus, live status, and mobile layout;
- no private evidence appears in DOM or HTTP response.

### Release gates

- default tests and builds make zero network or paid provider calls;
- live provider use requires explicit configuration;
- `npm test`, site tests, typecheck, build, and public-boundary checks pass;
- local dogfood records the exact build SHA and provider/configuration state.

## Delivery boundaries

This design is intentionally limited to the first testable C3 slice. Later
work gets separate designs and plans for:

- project persistence and immutable revisions;
- user questions and revision diffs;
- hosted multi-user tenancy and retention;
- Decision Lab;
- specification-aware critique;
- companion skill and agent routing;
- corpus-wide retagging or disposition.

No implementation begins until this design is converted into an approved
implementation plan.
