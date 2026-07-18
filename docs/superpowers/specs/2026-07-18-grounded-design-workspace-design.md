# Grounded Design Workspace — Design Specification

**Date:** 2026-07-18
**Status:** Approved design
**Scope:** Product direction before C2; implementation is deferred
**Primary artifact:** Versioned `UiSpec` rendered deterministically as `DESIGN.md`

## 1. Summary

Clean UI will evolve from a corpus browser into a hosted design-decision system. A user supplies a product brief. The hosted service privately retrieves relevant corpus evidence, combines it with machine rules and any public references explicitly supplied by the user, and returns an implementation-ready, project-specific `DESIGN.md`.

The structured, versioned `UiSpec` is the canonical source of truth. `DESIGN.md` is its deterministic human- and agent-readable rendering. The first revision is useful immediately, even when the brief is incomplete: it makes bounded assumptions, marks confidence, and then asks up to three high-impact questions. Answers create immutable revisions rather than overwriting history.

Playground becomes the brief-to-`DESIGN.md` creation workspace. Decision Lab evaluates alternative implementations against a selected `UiSpec`, produces a typed `DecisionRecord` and `DECISION.md`, and applies only user-approved decisions to a new `UiSpec`/`DESIGN.md` revision. Critique closes the loop by evaluating implementations against the approved specification.

The private corpus remains server-side. Public outputs may contain aggregated principles but never private screenshots, entry IDs, image paths, source identities learned from the corpus, recognizable quotations, or entry-level critiques.

## 2. Product thesis

Clean UI is not primarily an inspiration gallery or token extractor. It is a design decision engine for humans and implementation agents.

The core workflow is:

```text
product brief
  -> grounded DESIGN.md revision 1
  -> high-impact questions
  -> confirmed DESIGN.md revisions
  -> implementation
  -> Decision Lab and specification-aware critique
  -> accepted decisions and targeted corrections
```

The product succeeds when an independent implementation agent can produce a coherent, usable interface from the artifact with fewer corrective rounds than it needs from an ordinary product prompt.

## 3. Decisions

1. The first release generates a **project-specific** artifact, not a per-reference export.
2. Initial input is a **product brief only**. Reference discovery is automatic.
3. Output covers both the **global design system and screen-level blueprints**.
4. The system generates revision 1 before asking questions.
5. `UiSpec` is canonical; Markdown is derived.
6. Private retrieval occurs only in a hosted Clean UI service.
7. Private corpus sources remain anonymous in every user-visible output.
8. Names and links explicitly supplied by the user may remain visible as user-supplied references without confirming corpus membership.
9. Playground becomes the creation and revision workspace.
10. Decision Lab produces a `DecisionRecord`/`DECISION.md`; accepted decisions create a new `UiSpec`/`DESIGN.md` revision.
11. Questions, answers, assumptions, decisions, critiques, and every artifact revision are preserved in project history.
12. Projects are portable and deletable. Screenshot uploads expire sooner than project artifacts by default.
13. Managed Clean UI credits are the initial execution mode. Bring-your-own-key is a later mode over the same sanitized pipeline.
14. C2 evaluates whether corpus labels enable safe, useful design decisions; C3 implements the hosted synthesis and MCP workflow.
15. Live public websites are first-class user-supplied evidence sources represented by a separate `DesignSourceSnapshot`.
16. Public-site inspection uses a bounded, representative multi-page crawl rather than a single screenshot or an uncontrolled full-domain crawl.
17. Raw pasted passwords, cookies, and session tokens are rejected; authenticated capture is deferred to a user-controlled browser or isolated capture-agent roadmap.
18. Project inspection never ingests content into the global corpus automatically.
19. Corpus growth begins with a maintainer-only Curator Scout and a quarantined human-review queue.

## 4. Scope

### 4.1 First release

- Product-brief normalization
- Private evidence retrieval and aggregation
- Optional user-supplied named references and public URLs
- Public, unauthenticated multi-page website inspection
- Typed `DesignSourceSnapshot` and deterministic `SOURCE-DESIGN.md`
- Typed, versioned `UiSpec`
- Deterministic `DESIGN.md`
- Complete first draft with explicit assumptions
- Up to three prioritized follow-up questions per interaction
- Immutable revisions and revision diffs
- Project history and portable export
- Privacy, evidence, originality, consistency, accessibility, and completeness gates
- Playground creation/revision experience
- Specification-aware Decision Lab integration after the base revision loop is reliable

### 4.2 Deferred

- Codebase inspection and repository-specific adapters
- Automatic design-drift monitoring across a live application
- Tailwind, shadcn, SwiftUI, and other framework exports
- Multi-user approvals and enterprise collaboration
- Automated learning from customer outcomes
- Public exploration of corpus examples unless each item is independently publication-cleared
- BYOK until credential isolation and provider-normalization gates are complete
- Authenticated application inspection through a user-controlled browser extension, local capture agent, or isolated remote browser
- End-user public-site suggestion inbox
- Automatic live-site drift monitoring and scheduled recapture

## 5. Mandatory publication prerequisite

The current website worktree contains a static `site/public/snapshot.json` and hundreds of files under `site/public/entries/`. That bundle exposes corpus images and detailed corpus-derived content independently of the backend publication boundary.

Before any public launch:

1. remove private or uncleared corpus material from public static assets;
2. replace it with deliberately cleared assets or synthetic fixtures;
3. ensure the public build cannot import, copy, or bundle the private corpus;
4. add a build-time static-asset disclosure gate; and
5. keep any future Explore collection separate from the private corpus and subject to explicit publication review.

The public Playground must not depend on a browser-downloadable copy of the private corpus.

## 6. System architecture

```text
user / implementation agent
  -> open-source MCP or Playground client
  -> hosted Clean UI API
       -> brief normalizer
       -> private retrieval planner
       -> private corpus and embeddings
       -> public-reference inspector
       -> aggregate evidence matrix
       -> design synthesizer
       -> UiSpec validators
       -> publication-safety gate
       -> project/revision store
  -> sanitized UiSpec
  -> deterministic DESIGN.md renderer
```

### 6.1 Isolation rule

The private retrieval layer may read private corpus records. The renderer may not. Only a sanitized and validated `UiSpec` crosses from the private synthesis boundary to the response/rendering boundary.

### 6.2 Staged generation

1. Normalize the brief into product, users, jobs, platform, requested screens, constraints, brand attributes, and user-supplied references.
2. Build independent retrieval queries for domain, screen patterns, interaction model, visual character, components, cautionary patterns, and accessibility.
3. Retrieve diverse private evidence; prevent one source or style from dominating.
4. Inspect accessible user-supplied public URLs in an isolated fetcher.
5. Aggregate evidence into recurring patterns, disagreements, suitability, confidence, and limitations.
6. Choose one coherent design direction.
7. Construct the typed `UiSpec`.
8. Validate safety, consistency, originality, accessibility, and completeness.
9. Persist the exact revision.
10. Render `DESIGN.md` deterministically.
11. Rank unresolved decisions and return at most three questions.

### 6.3 Evidence artifact separation

Observation and prescription are separate artifact families:

```text
live website
  -> DesignSourceSnapshot / SOURCE-DESIGN.md (what exists)
  -> UiSpec / DESIGN.md (what the target product should do)
```

A `DesignSourceSnapshot` may inform a `UiSpec`, but it is never itself the target design authority. Synthesis records which source observations were retained, rejected, or adapted and why.

## 7. Evidence and reference policy

Every material recommendation declares one authority lane:

- `user-input`
- `user-supplied-public-reference`
- `anonymous-corpus-pattern`
- `machine-rule`
- `product-inference`
- `editorial-guidance`
- `user-decision`

### 7.1 Private corpus

Public output must not reveal:

- screenshots or reconstructable visual assets;
- private entry, image, or embedding IDs;
- private image paths or source URLs;
- product identities learned from the corpus;
- whether a named product is present in the corpus;
- recognizable excerpts of private critiques; or
- entry-level evidence counts or descriptions that enable reconstruction.

Corpus support is stated only in safe aggregate form, subject to a minimum evidence threshold and anti-inference controls.

### 7.2 User-supplied names and links

If the user names a product such as Revolut or supplies a URL, the artifact may retain that identity because the user introduced it. It must mark the provenance as user-supplied and must not confirm corpus membership.

An accessible public URL may support attributed public observations. An inaccessible, authenticated, or blocked URL remains a stated preference only. The service must not pretend it inspected unavailable content.

The service extracts transferable principles rather than copying proprietary assets, exact layouts, brand language, illustrations, or distinctive component arrangements.

### 7.3 Public URL safety

The fetcher must enforce:

- SSRF and local-network denial;
- scheme and redirect allow-lists;
- response size and time limits;
- content-type enforcement;
- prompt-injection isolation;
- no authenticated browsing in the first release; and
- provenance recording for every observation.

### 7.4 Cookie and authentication policy

The initial hosted API rejects raw user-supplied passwords, cookies, session tokens, and authorization headers. It continues with public inspection and marks inaccessible routes `authentication-required`; it never bypasses the gate or claims those routes were inspected.

An isolated public crawl may accept essential first-party `Set-Cookie` responses for the life of that capture session so ordinary sites can function. Third-party cookies are blocked. The context is never shared across tenants, projects, or origins and is destroyed when capture ends. Cookies never enter logs, prompts, artifacts, exports, or analytics.

When a consent dialog appears, the crawler prefers “Reject non-essential” or its safe equivalent. It records the action. If it cannot determine a safe choice, it stops that route and requests user direction rather than selecting “Accept all.”

Authenticated inspection is a roadmap capability, not a raw-credential API. Approved future mechanisms are:

- a browser extension or local capture agent operating inside the user's existing session, with local redaction and upload preview; or
- an isolated, ephemeral remote browser in which the user signs in directly to the target site while recording is paused.

Both mechanisms require explicit origin/route scope, short-lived authorization, sensitive-field redaction, destructive-action denial, and destruction of browser state at session end.

## 8. Live website source snapshots

### 8.1 `DesignSourceSnapshot`

A source snapshot records observed evidence from a user-supplied live website:

- inspected origin and user-supplied starting URLs;
- capture time, crawl policy, and coverage manifest;
- discovered, selected, skipped, blocked, duplicate, and failed routes;
- inspected viewports and themes;
- site-wide colors, typography, spacing, shape, elevation, and layout primitives;
- template-level information architecture and component families;
- route-specific exceptions and inconsistencies;
- responsive differences;
- interaction affordances and declared motion;
- accessibility observations;
- content-voice characteristics;
- field-level confidence and provenance; and
- missing or inaccessible evidence.

The deterministic human rendering is `SOURCE-DESIGN.md`. It describes the existing source. It does not instruct the target implementation unless a later `UiSpec` explicitly adopts an observation.

### 8.2 Representative multi-page crawl

A supplied URL starts a bounded discovery plan:

1. inspect the supplied route first;
2. discover same-origin routes from primary navigation, footer links, content links, canonical links, `sitemap.xml`, and SPA anchors;
3. normalize URLs, strip tracking parameters, and exclude API/non-HTML resources;
4. classify routes into page archetypes;
5. cluster structurally and visually repetitive pages;
6. select representative routes, normally no more than 20–30 by default;
7. show the route plan and allow explicit user inclusion/exclusion;
8. capture desktop and mobile by default, plus tablet when requested;
9. collect full-page context, important landmarks, DOM/CSS signals, accessibility facts, and declared motion; and
10. record complete coverage and failure provenance.

The crawler remains same-origin unless the user separately supplies another origin. It uses `GET`/`HEAD` navigation only, submits no forms, downloads no arbitrary files, and denies logout, deletion, purchase, invitation, administration, or other state-changing actions.

Repeated detail, article, or catalog routes are sampled rather than exhaustively captured. Users may explicitly authorize a larger bounded crawl.

### 8.3 Source-to-target synthesis

The resulting `UiSpec` distinguishes:

- source observation;
- product-specific target decision;
- retained or adapted source principle;
- rejected source behavior and rationale; and
- migration action: preserve, change, consolidate, or retire.

This enables an “Evolve an existing product” flow that produces an as-is snapshot, a proposed target `DESIGN.md`, and a staged migration plan without treating the current site as automatically correct.

### 8.4 Incremental refresh

Later captures may use a prior source snapshot to identify changed, added, and removed routes; re-inspect only affected representatives; preserve unchanged observations; and report token, component, responsive, accessibility, and content drift.

## 9. Canonical artifact

`UiSpec` is a structured artifact with at least:

- `specVersion`
- `artifactId`
- `projectId`
- `revision`
- `parentRevisionHash`
- `status`
- `productContext`
- `designDirection`
- `experiencePrinciples`
- `informationArchitecture`
- `layoutSystem`
- `responsiveBehavior`
- `colorTokens`
- `typographyTokens`
- `spacingShapeElevation`
- `componentInventory`
- `screenBlueprints`
- `interactionAndMotion`
- `contentVoice`
- `accessibilityConstraints`
- `implementationGuidance`
- `acceptanceCriteria`
- `guardrails`
- `assumptions`
- `openQuestionIds`
- `evidenceSummary`
- `provenance`
- `revisionSummary`

Every cross-reference uses stable IDs. Every token reference resolves. Every screen blueprint uses global decisions unless it declares an explicit, justified override.

### 9.1 `DESIGN.md` outline

```markdown
---
spec_version: "1.0"
artifact_id: "uispec_..."
revision: 1
status: "draft-with-assumptions"
product_context_hash: "..."
platform: "web"
generated_at: "..."
---

# Product Design Specification

## 1. Product and User Context
## 2. Design Direction
## 3. Experience Principles
## 4. Information Architecture
## 5. Responsive Layout System
## 6. Color System
## 7. Typography
## 8. Spacing, Shape, and Elevation
## 9. Component Specifications
## 10. Screen Blueprints
## 11. Interaction and Motion
## 12. Content and Voice
## 13. Accessibility
## 14. Implementation Guidance
## 15. Acceptance Criteria
## 16. Do / Don't Guardrails
## 17. Assumptions and Open Decisions
## 18. Evidence Summary
## 19. Revision History
```

### 9.2 Screen blueprints

Each requested screen defines:

- purpose and primary outcome;
- content hierarchy;
- regions and responsive behavior;
- components and interactive states;
- primary and secondary actions;
- empty, loading, error, and success states;
- keyboard and accessibility behavior;
- mobile adaptation;
- applicable tokens; and
- machine-verifiable or manual acceptance criteria.

## 10. Questions, assumptions, and revisions

Revision 1 is complete enough to implement. Missing brief information becomes a bounded assumption, not a blank section.

Each assumption records:

- ID;
- chosen default;
- authority lane;
- confidence;
- impact if wrong;
- affected sections; and
- confirmation state.

Each question records:

- ID;
- prompt;
- why it matters;
- default used in the current artifact;
- affected sections;
- priority; and
- state: `open`, `answered`, `deferred`, `superseded`, or `withdrawn`.

Answers create a new immutable revision. Accepted decisions remain locked until explicitly reopened. Unaffected sections remain byte-stable where practical. Every revision includes a machine-readable diff and a concise human-readable explanation.

Revision writes require the caller's expected current revision. A stale writer receives a conflict rather than overwriting newer work.

## 11. Playground

Playground becomes the hosted creation workspace rather than a private-corpus browser.

The primary flow is:

1. enter a product brief;
2. observe generation stages;
3. receive revision 1;
4. navigate global rules and screen blueprints;
5. inspect confidence, assumptions, provenance lanes, and open questions;
6. answer questions;
7. review the revision diff;
8. copy or download `DESIGN.md`; and
9. continue to implementation or Decision Lab.

The workspace presents token previews and component/spec structure, but never private corpus cards or screenshots.

A future Explore area may exist only over a separately publication-cleared collection. It is not a filtered view of the private corpus.

Playground supports two starting modes over the same artifact pipeline:

- **Design a new product:** brief-first generation.
- **Evolve an existing product:** brief plus public URL, producing `DesignSourceSnapshot`, `SOURCE-DESIGN.md`, target `UiSpec`, `DESIGN.md`, and migration guidance.

## 12. Decision Lab

Decision Lab consumes a selected `UiSpec` revision and two or three user-supplied candidate implementations or screenshots.

It evaluates candidates against:

- product goals;
- confirmed design decisions;
- screen acceptance criteria;
- accessibility requirements;
- originality guardrails; and
- safe anonymous corpus principles.

Its canonical output is a typed `DecisionRecord`; its deterministic human-readable rendering is `DECISION.md`.

The record contains:

- source `UiSpec` revision;
- candidate identities and private upload references;
- comparison criteria;
- supported findings;
- recommended direction;
- proposed individual decisions;
- accepted and rejected decisions;
- rationale;
- affected `UiSpec` sections; and
- resulting revision ID when applied.

Decision Lab never silently changes `UiSpec`. The user previews proposed changes and accepts decisions individually or as an explicit set. Applying accepted decisions creates a new `UiSpec` and `DESIGN.md` revision. Rejected alternatives remain in history so later agents do not repeat them.

Decision Lab may compare public staging URLs, production versus redesign, responsive implementations, screenshots versus live implementations, or multiple candidate screenshots. Live capture remains subject to the source-snapshot safety boundary.

## 13. Critique

`critique_ui` becomes specification-aware when a project and revision are supplied. It compares implementation screenshots with the selected artifact and returns prioritized findings tied to exact decisions or acceptance criteria.

User screenshots remain private, are never added to the corpus automatically, and follow the project's upload-retention policy.

## 14. Project persistence

A project retains:

- every brief revision;
- every `UiSpec` revision;
- exact `DESIGN.md` bytes and hash;
- every question and answer;
- confirmed, rejected, deferred, superseded, and reopened decisions;
- Decision Lab records and exact `DECISION.md` bytes;
- critique runs;
- revision diffs and provenance; and
- private upload references while they remain within retention.

Project artifacts remain until the user deletes the project. Uploaded screenshots expire sooner by default. Retention windows are explicit and visible. Deletion removes project data and uploads within the documented deletion window and produces a deletion receipt without retaining sensitive content.

Customer data does not enter the global corpus or model-training pipeline without separate, explicit, revocable consent and a curator-controlled ingestion process.

## 15. Portability

Users can export at any time:

```text
clean-ui-project/
  DESIGN.md
  design.spec.json
  manifest.json
  revisions/
    001-DESIGN.md
    001-design.spec.json
  decisions/
    decision-001.md
    decision-001.json
  questions.json
  sources/
    source-001.md
    source-001.json
```

The manifest hashes every file and identifies schema versions. Export/import must round-trip without semantic change. `DESIGN.md` remains useful without Clean UI. The structured companion enables validation and future revisions but is not required to read or implement the design.

Exports exclude API keys, server logs, raw private-corpus evidence, expired uploads, internal model prompts, and tenant metadata.

## 16. Corpus growth and Curator Scout

Project inspection and corpus ingestion are separate trust domains. “Inspect this for my project” does not grant permission to retain, redistribute, or use the source as global product intelligence.

### 16.1 Maintainer-first Scout

Curator Scout builds on the existing batch capture, DOM-signal, tagger, deduplication, bulk-import, and review systems. A maintainer may supply a URL, sitemap, site list, product category, known corpus gap, and route/cost budget.

Scout:

1. plans a representative crawl;
2. captures responsive visual and DOM evidence;
3. extracts structural, accessibility, motion, and design facts;
4. clusters and deduplicates candidates;
5. scans for secrets, PII, account data, unsafe content, and provenance gaps;
6. scores novelty, quality, coverage value, and extraction confidence;
7. writes candidates only to a quarantined review queue; and
8. requires explicit maintainer acceptance before private-corpus ingestion.

Nothing enters the corpus automatically.

### 16.2 Contribution levels

- **Private research entry:** retained in the private corpus after curation; no public redistribution implied.
- **Metadata-only public entry:** separately cleared derived analysis without screenshot bytes.
- **Rights-cleared public entry:** separately cleared metadata plus an owned, licensed, permitted, or public-domain image.

Private-corpus inclusion and public publication are independent decisions.

### 16.3 Demand-driven opportunity queue

Safe, thresholded aggregates may identify corpus gaps such as domains, platforms, patterns, states, components, or evidence fields that frequently produce low-confidence specifications. The opportunity queue contains no customer names, URLs, raw briefs, project descriptions, or private terminology. Hosted users receive an analytics opt-out.

Scout can prioritize state packs, responsive pairs, good/cautionary contradiction pairs, novel component families, stale-source recapture, extraction disagreements, and potential gold candidates. Gold nomination never promotes an entry without the normal C2 review and adjudication process.

### 16.4 Future contribution surface

An end-user “Suggest a public site” inbox is deferred until the Scout safety, deduplication, provenance, and review pipeline is proven. A suggestion grants neither ingestion nor publication permission.

A future explicit contribution flow must preview the exact proposed material, record ownership/permission assertions, run automated checks, require curator review, assign independent corpus lineage, and define withdrawal terms. Anonymous aggregate-statistic contribution also requires explicit consent.

## 17. Managed credits and BYOK

Managed credits are the initial hosted execution mode. Clean UI selects and operates supported models and owns quality normalization.

BYOK is a later execution mode. Even then, provider models receive only:

- user input;
- user-supplied public-reference observations;
- sanitized aggregate evidence;
- machine rules; and
- relevant prior project artifacts.

They never receive raw private corpus screenshots or identifiable private entries.

BYOK credentials are encrypted and session-scoped by default. Persistent storage requires explicit opt-in. Credentials never enter prompts, logs, analytics, exports, or error messages.

Both execution modes produce the same canonical schemas and pass the same validators.

## 18. Failure behavior

- **Sparse evidence:** generate a usable artifact with `evidence-insufficient` warnings and lower confidence.
- **Inaccessible user URL:** preserve it as a user-stated preference; emit no visual observations.
- **Conflicting evidence:** choose based on product suitability and disclose the disagreement.
- **Overly derivative request:** extract general principles and refuse direct replication.
- **Provider failure:** retry within bounded policy, then return the latest valid artifact or a typed failure; never publish partial unsafe content.
- **Privacy-gate failure:** return no new artifact content, retain the previous valid revision, and log a content-free diagnostic.
- **Concurrent update:** reject the stale write and return the latest revision metadata.
- **Hosted outage:** users keep their exported/latest artifact and can continue implementation offline.
- **Cookie credential supplied:** reject the credential, inspect only public routes, and mark authenticated coverage unavailable.
- **Consent banner unresolved:** stop that route and request direction; never default to accepting tracking.
- **Crawl budget reached:** return the representative partial snapshot with exact coverage rather than silently expanding scope.

## 19. Validation and security gates

Every revision must pass:

- canonical schema validation;
- supported-version validation;
- required-section completeness;
- cross-section consistency;
- reference and token resolution;
- ID uniqueness;
- authority-lane and provenance coverage;
- accessibility baseline coverage;
- private-data leakage scanning;
- named-reference originality checks;
- deterministic Markdown rendering;
- parent revision/hash integrity; and
- export/import round-trip validation.

Adversarial tests cover:

- repeated-prompt corpus reconstruction;
- corpus-membership probing;
- private name, ID, critique, path, and screenshot leakage;
- cross-project and cross-tenant access;
- prompt injection and SSRF through supplied URLs;
- malicious Markdown and exported-file content;
- API-key leakage;
- concurrent revision conflicts;
- deleted-project recovery attempts; and
- exports containing uploads or server-only metadata.
- raw-cookie, password, authorization-header, and cross-session credential leakage;
- unsafe consent-banner interaction;
- state-changing crawl behavior;
- crawl-scope, redirect, and same-origin escape;
- source-snapshot claims unsupported by inspected routes; and
- automatic or unauthorized corpus ingestion.

## 20. C2 and C3 boundary

C2 must evaluate whether corpus labels support the decisions required by this product:

- information hierarchy;
- layout and responsive behavior;
- component and interaction selection;
- visual character and token recommendations;
- accessibility and failure-state guidance;
- anti-pattern avoidance; and
- product-context suitability.

Gold evaluation includes realistic briefs across marketing, SaaS, fintech, mobile, onboarding, forms, dense tools, sparse evidence, conflicting references, inaccessible links, and derivative requests.

It also includes live-site cases: single-page and multi-page sites, responsive disagreement, repeated-route deduplication, cookie banners, blocked/authenticated routes, incomplete crawl coverage, DOM/screenshot disagreement, and source-to-target migration decisions.

Human scoring covers product appropriateness, coherence, implementation clarity, originality, accessibility, evidence discipline, and consistency between independent implementations.

C2 establishes that the evidence can support the product safely. C3 implements the hosted synthesis boundary, `create_ui_spec`, revisions, Playground integration, and later Decision Lab integration. C2 does not publish the private corpus or implement the hosted service.

## 21. Success metrics

Primary:

- time from brief to first usable implementation;
- number of corrective rounds before acceptance;
- acceptance-criterion pass rate; and
- blinded preference versus implementation from a brief-only prompt.

Secondary:

- question-answer conversion;
- revision count and abandonment;
- artifact export rate;
- Decision Lab recommendation acceptance;
- design-drift reduction;
- privacy-gate and originality-gate intervention rates; and
- sparse-evidence frequency.
- representative-crawl coverage and deduplication efficiency;
- source-snapshot factual accuracy;
- Scout candidate acceptance and duplicate-rejection rates; and
- corpus opportunity closure without customer-data retention.

Prose quality alone is not a success metric.

## 22. Rollout order

1. Remove uncleared corpus content from public static assets and add disclosure gates.
2. Amend the parent product/C2 authority to incorporate this specification.
3. Redefine C2 gold evaluation around safe `DESIGN.md` decision quality.
4. Execute and approve C2.
5. Implement hosted generation, artifact validation, persistence, and export in C3.
6. Refactor existing capture/DOM/SSRF capabilities into the bounded public source-snapshot service.
7. Transform Playground into the creation/revision workspace with synthetic demos until hosted generation is enabled.
8. Add “Evolve an existing product” with representative public-site crawling.
9. Launch maintainer-only Curator Scout and quarantined review.
10. Integrate specification-aware critique.
11. Integrate Decision Lab with typed decisions and revision application.
12. Launch managed credits.
13. Add authenticated user-controlled capture, BYOK, end-user suggestions, drift monitoring, and other deferred roadmap capabilities only after their dedicated gates pass.

## 23. Launch criteria

- No private or uncleared corpus material exists in public static assets.
- Public builds cannot import or package the private corpus.
- Adversarial privacy suite has zero leakage.
- Brief -> revision -> questions -> revision works end to end.
- Identical `UiSpec` input renders byte-identical `DESIGN.md`.
- Export/import preserves artifact semantics and hashes.
- Decision Lab applies only explicit user-approved decisions.
- Complete deletion and upload-retention enforcement are verified.
- Sparse evidence and provider failure produce honest degraded behavior.
- Blinded trials show measurable improvement over brief-only prompting.
- Public multi-page crawling is bounded, same-origin, non-mutating, and provenance-complete.
- Raw credential inputs are rejected and ephemeral cookies cannot cross sessions.
- Project inspection cannot write directly to the corpus.
- Scout candidates remain quarantined until explicit maintainer acceptance.

## 24. Non-goals

- Revealing or browsing the private corpus
- Confirming whether a named product exists in the private corpus
- Reproducing a user-named product exactly
- Treating generated prose as unvalidated design authority
- Automatically training on customer artifacts
- Requiring permanent hosted-service access to use an exported design
- Replacing human decisions with hidden automatic revisions
- Treating a source snapshot as automatic target-design authority
- Crawling an entire origin without a visible bounded plan
- Accepting pasted raw authentication credentials in the initial hosted API
- Adding inspected project material to the corpus without separate explicit curation
