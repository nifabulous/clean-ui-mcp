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
- Treat `outputFormat: "markdown" | "json"` as the new tool presentation
  option. Do not reuse the legacy `brief`/`tokens` terminology for the new
  handoff contract.

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

The `create_ui_spec` descriptor must be updated to allow the evidence retrieval
states actually used by this resolver: `hybrid/text`, `keyword/text`,
`keyword/metadata`, `structured-fallback/metadata`, and `none/none`. The
automatic path reports the real state and attempted modes. Explicit reference
selection reports `none/none`. The descriptor gets an explicit
`allowNoneWithPositiveResult` capability because the primary result is one
spec artifact even when no retrieval operation was needed. Contract tests must
cover both paths; the envelope must never report `none/none` for automatic
retrieval merely to satisfy the old policy.

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
They are distinct from `citedReferences` and top-level `referenceIds`:

- `evidence-1`-style IDs appear in the standard MCP `evidence` array, the
  `UiSpec` evidence links, and the artifact envelope's `publicEvidenceIds`;
- `citedReferences` and `provenance.sourceReferences` contain only safe,
  user-supplied or public documentation references;
- private corpus IDs are never copied into either category.

The renderer must label response-scoped evidence as “Cited evidence”, not
“Cited references”. Internal corpus IDs are never echoed into `DESIGN.md`,
JSON, browser DOM, logs, or analytics.

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

The candidate schema is strict and bounded. It contains
`candidateVersion: "1.0"`, optional proposed values for the UiSpec sections,
and a `decisions` array of at most 32 entries. Each decision is a
field-specific discriminated union over `designDirection`, `rejectedDefaults`,
`layoutRegions`, `responsiveBehavior`, `componentInventory`, `colorTokens`,
`typographyTokens`, `interactions`, `motionGuidance`,
`accessibilityConstraints`, `contentVoiceGuidance`, `techniques`,
`antiPatterns`, `frameworkNotes`, and `acceptanceCriteria`. There is no generic
`z.unknown()` value escape hatch. Each variant has a non-empty `id`, a
field-appropriate bounded value, a bounded rationale, and at most eight
`evidenceIds`. Text values, array lengths, region/component counts, and nested
evidence-ID counts have explicit maxima in the Zod schema. Unknown keys,
unrecognized fields, empty IDs, structural Markdown, private-path markers,
and evidence IDs outside the sanitized set are rejected before assembly. The
model candidate is never accepted through a type assertion.

Two providers are required:

1. **Deterministic provider:** offline and reproducible. It uses the brief,
   sanitized evidence, existing aggregation/rule helpers, and the checked-in
   `c3-fallback-v1` recipe. The recipe pins the field-by-field assembly rules,
   warning codes, unavailable decisions, and one machine-rule acceptance
   criterion. Fields that cannot be supported remain unavailable; no implicit
   color, typography, or corpus claim is invented.
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

The deterministic recipe version and SHA-256 are safe provenance. They are
included in the artifact identity input so a recipe change cannot silently
reuse an old artifact identity.

## Artifact contract

`UiSpec` 1.0 remains the semantic source of truth. The producer creates a safe
`DesignArtifactEnvelope` around it:

```text
artifactVersion: "1.0"
artifactId: deterministic hash-derived identifier
generatedAt: ISO timestamp
producerVersion: pinned producer/recipe version
assemblyRulesSha256: hash of the checked-in assembly recipe
spec: validated UiSpec 1.0
handoff: validated web target and motion intents
designMarkdown: deterministic DESIGN.md bytes
designJson: deterministic JSON handoff bytes
specSha256: hash of canonical spec bytes
designMarkdownSha256: hash of exact markdown bytes
designJsonSha256: hash of exact JSON handoff bytes
publicEvidenceIds: response-scoped evidence IDs only
retrieval: truthful safe retrieval metadata
warnings: typed public warnings
```

`canonicalSpecBytes` are the UTF-8 bytes of `canonicalJsonStringify(spec)`;
`specSha256` hashes those exact emitted bytes. Because UiSpec 1.0 includes
`provenance.generatedAt`, this hash is an artifact-instance hash and may differ
between requests. `semanticSpecBytes` are the same canonical object with
timestamp-only provenance normalized out; `semanticSpecSha256` is the stable
semantic hash used for identity. The two rendering hashes use the exact UTF-8
bytes returned by the existing renderers. `artifactId` is
`uispec-<sha256>` over canonical JSON containing `artifactVersion`,
`producerVersion`, `assemblyRulesSha256`, `semanticSpecSha256`, the canonical
handoff inputs, and the rendering format version. `generatedAt` is excluded
from identity. Repeated rendering of the same validated envelope is
byte-identical; timestamp-only reruns have stable semantic identity but may
have different instance hashes and JSON `generated_at` bytes.

The public artifact envelope is itself a strict schema and has one constructor:
`DesignArtifactEnvelopeSchema` and `parseDesignArtifactEnvelope()`, located in
`src/create-ui-spec-contracts.ts`. The parser validates the nested UiSpec and
handoff, checks every SHA-256 against the exact bytes, checks that
`publicEvidenceIds` are unique response-scoped IDs, validates retrieval and
warning coupling, and rejects private markers. HTTP responses and MCP adapter
outputs are created only from this parsed envelope. Operator diagnostics are a
separate non-serializable value and cannot enter the public envelope.

The MCP adapter registers the beta `create_ui_spec` contract. Its structured
`data` is the validated `UiSpec`; `content[0]` is the requested rendering:

- `outputFormat: "markdown"` returns `DESIGN.md`;
- `outputFormat: "json"` returns the stable JSON handoff.

The MCP envelope's `referenceIds` remain the safe references extracted from
`UiSpec.citedReferences`; response-scoped evidence IDs are carried by the
standard `evidence` array and `UiSpec` evidence links. The descriptor tests must
assert that the two ID domains cannot be substituted for each other.

The HTTP adapter returns the safe artifact envelope with both renderings so the
Playground can offer downloads without another generation request. The public
beta catalog follows the existing no-alias rule: the old
`generate_design_prompt` implementation may remain as an internal helper, but
it is not a second public name for the new tool.

## Integration and local serving

The implementation must make the producer boundary concrete in these files:

- `src/create-ui-spec-contracts.ts`: strict candidate and artifact-envelope
  schemas, canonical hash helpers, and the sole artifact parser;
- `src/c3/fallback-recipe-v1.json`: checked-in canonical fallback field rules,
  warning codes, unavailable decisions, and the machine-rule acceptance
  criterion;
- `src/c3/fallback-recipe-v1.test.ts`: canonical-byte and expected-SHA test for
  the fallback recipe;
- `src/create-ui-spec.ts`: shared service, input normalization, resolver,
  sanitizer, providers, assembler, artifact envelope, and hash construction;
- `src/tool-contracts.ts`: replace `serializationFormat` with `outputFormat`,
  update the create-tool retrieval policy and `allowNoneWithPositiveResult`,
  remove the legacy name from the beta descriptor, and preserve strict
  reference/evidence invariants;
- `src/__fixtures__/tool-contract-fixtures.ts`, `src/tool-contracts.test.ts`,
  `src/tool-contract-docs.test.ts`, and catalog tests: update fixtures, docs,
  exact tool names, and retrieval-policy coverage;
- `src/server-factory.ts`: register `create_ui_spec` through the canonical
  descriptor contract and remove `generate_design_prompt` from the public beta
  registration; keep legacy generation helpers private;
- `src/scripts/ui-server.ts`: add `POST /api/create-ui-spec` and serve the
  Playground/API through the same operator-controlled local process;
- `site/vite.config.ts`: proxy `/api` to
  `http://127.0.0.1:${CLEAN_UI_PORT:-3131}` during development;
- `site/src/data/create-ui-spec.ts`, `site/src/pages/PlaygroundPage.tsx`, and
  `site/tests/site-browser.test.ts`: use the same-origin API and prove the
  focused composer states;
- `src/create-ui-spec.test.ts`, envelope tests, MCP contract tests, and browser
  tests: prove
  both adapters invoke the same service and no second renderer exists.

The production dogfood command is explicit: build the site with `npm run
site:build`, start the loopback UI server with `CLEAN_UI_SITE_DIST=site/dist
npm run ui`, and serve `/clean-ui-mcp/*` from that same process alongside
`/api/*`. The Vite dev server is only a development convenience; it is never
the production privacy boundary.

The local API binds to `127.0.0.1` only. It rejects unexpected `Origin` values
using an explicit local allowlist and requires a per-process CSRF nonce in a
request header for POST requests. `GET /api/csrf` issues the nonce only to an
allowed origin; the browser sends it in `X-Clean-UI-CSRF` on
`POST /api/create-ui-spec`. The nonce is process-local and invalidated on
restart. Live provider calls are disabled unless the operator explicitly
enables them. The API never accepts credentials, cookies, or authorization
headers from the browser.

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
- Retrieval logging records counts, modes, warning codes, and aggregate hashes
  only. It never persists corpus entry IDs, explicit reference IDs, or raw
  briefs. The existing result-ID query logger must not be reused by this path.
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
- strict candidate-schema rejection for unknown keys, oversized fields,
  Markdown, private markers, and unbound evidence IDs;
- strict `UiSpec` validation;
- envelope hash verification, stable semantic artifact IDs, and byte-identical
  repeated rendering of one envelope;
- absence of private markers and raw corpus material.

### MCP

- exact `create_ui_spec` input/output schema;
- standard envelope invariants;
- `data` equals the validated `UiSpec`;
- `content[0]` matches the requested rendering;
- automatic and explicit-reference retrieval metadata and warning coupling;
- response-scoped evidence IDs cannot appear as private corpus IDs or unsafe
  source references;
- beta catalog contains the intended public names and no legacy alias.

### HTTP and browser

- adapter mapping uses the same producer service;
- idle, generating, success, fallback, validation-error, and retry states;
- downloaded bytes match returned hashes;
- same-origin production serving and Vite proxy behavior;
- CSRF nonce issuance, origin rejection, nonce-restart invalidation, and no
  browser-supplied credentials;
- keyboard-complete controls, visible focus, live status, and mobile layout;
- no private evidence appears in DOM or HTTP response.

### Release gates

- default tests and builds make zero network or paid provider calls;
- live provider use requires explicit configuration;
- local API origin and CSRF checks pass;
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
