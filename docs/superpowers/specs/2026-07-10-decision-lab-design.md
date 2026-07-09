# Decision Lab Design

Date: 2026-07-10

## Goal

Add Decision Lab to clean-ui: a single-user, pre-launch product-design decision workspace for PMs and designers. Users compare two or three competing designs, state the outcome they want, and receive evidence-grounded arguments, risks, simulated-perspective feedback, and an experiment brief.

> Understand the trade-offs between product-design directions before you ship.

Decision Lab is a decision brief, not an automated design verdict. It predicts likely strengths, risks, and research hypotheses. It must never present output as statistically valid A/B-test results; that requires production traffic and experiment data.

## Audience and Job

The MVP serves product managers and product designers choosing a design direction before implementation or launch. It answers:

- Which direction best supports the user and business goal?
- What evidence supports that recommendation?
- What may go wrong for users?
- What must be validated after launch?

## Scope

### In scope

- A single user creates a decision with title, target user, business goal, primary KPI, platform, and optional constraints.
- Two or three directions per decision.
- The first delivery compares one screen per direction.
- Inputs are uploaded PNG/JPG/WebP screenshots.
- Single-screen comparisons, such as homepage concepts.
- Per-screen tagging, evidence-grounded comparative arguments, corpus retrieval where coverage supports it, fixed simulated perspectives, and experiment brief.
- Report export and equivalent MCP workflow.

### Out of scope

- Live experiment assignment, traffic collection, or statistical A/B analysis.
- Multi-screen flow comparisons, interactive prototype playback, Figma integration, direct .fig file parsing, custom personas, collaboration, shared links, team roles, Figma editing, or writing back to Figma.

## Experience

### Decision setup

Users start with a decision rather than an A/B test:

- Title: Choose the homepage direction.
- Target user: First-time visitors.
- Business goal: Make the value proposition understandable in 10 seconds.
- Primary KPI: Trial starts.
- Scope: single-screen comparison in the first delivery.

### Competing directions

Each decision has two or three named directions, A through C. The MVP accepts uploads:

- Upload one or more screenshots and set their order.

Figma-link frame selection is a post-MVP integration. Uploaded frames cover the initial decision job without OAuth, file/node traversal, rendering, and private-access recovery.

### Decision-first report

The default report is a brief. It shows:

- Per-direction arguments, strengths, risks, and evidence coverage.
- Comparative rubric results for goal alignment, visual hierarchy, cognitive load, copy clarity, and consistency. Flow coherence is a later, separately evaluated dimension.
- Cited accessibility risks, not an accessibility score.
- The three most decision-relevant trade-offs.
- Corpus evidence coverage: strong, limited, or unavailable, with the supporting-entry count.
- One major risk or uncertainty.
- Post-launch hypothesis, success metric, and guardrails.

When evidence is sufficiently strong, a secondary **Lean** callout may say: “If forced to choose, lean toward Direction B because …”. It is omitted when evidence is insufficient or materially conflicted. It is never the headline.

Expandable evidence includes per-screen annotations, complete rubric rationale, simulated-perspective observations, retrieved exceptional and cautionary examples, accessibility findings, model metadata, and score inputs.

## Explainability

No direction gets an unexplained rubric result. Each result must link to at least one source:

- visible screen or flow evidence;
- deterministic extracted tag or fact;
- corpus example or anti-pattern;
- named simulated perspective.

The system does not invent a corpus precedent when pattern coverage is thin. Corpus coverage is calculated from retrieved, applicable entries and shown separately from analysis confidence. Thin-pattern output must say “limited corpus evidence” and lead with screen observations and validation questions instead of a Lean.

## Scoring Methodology

Decision Lab uses a fixed, evidence-constrained process:

1. **Deterministic extraction** — the existing first-pass tagger extracts visible, DOM-derived when available, and image-derived facts.
2. **Evidence assembly** — the system gathers only extracted facts, relevant corpus entries, anti-patterns, and decision context for each direction.
3. **Constrained comparative rubric** — one structured synthesis generates the comparative arguments. It may score goal alignment, hierarchy, cognitive load, copy clarity, and consistency only when it cites assembled evidence. It cannot use unsupported visual claims.
4. **Risk presentation** — accessibility remains cited, evidence-backed risks rather than a numeric readiness score. The report must preserve the project’s rule that a valid WCAG citation does not by itself prove a screenshot violation.

Thresholds, weighting, Lean eligibility, and the corpus-coverage threshold are configuration owned by the evaluation harness. They are not hard-coded product claims before validation.

## Simulated Perspectives

Fixed MVP lenses:

1. **New user** — value, next-step, and trade-off comprehension.
2. **Returning/power user** — efficiency, predictability, and scanability.
3. **Accessibility-first user** — perceptibility, navigation, comprehension, and recovery.
4. **Growth-minded PM** — support for the stated KPI and harmful incentives.

Each returns a concise reaction, up to three evidence-linked observations, one concern, confidence, and a question to validate with actual users. The UI labels this as a simulated perspective, not user research.

## UI

Add a Decision Lab route to the existing curator dashboard with four views:

1. Decision setup — context form plus scope selector.
2. Direction importer — image upload, naming, and ordering.
3. Comparison report — direction grid, decision-brief rail, rubric results, and evidence summary.
4. Evidence detail — expandable direction, screen, persona, corpus, and accessibility evidence.

Desktop uses a three-direction grid and a persistent decision-brief rail. Narrow layouts stack directions. The user can inspect source material without losing comparison context.

## Data Model

Persist decisions independently from corpus entries:

~~~ts
Decision {
  id, title, createdAt, updatedAt,
  context: { targetUser, businessGoal, primaryKpi, platform?, constraints? },
  scope: "screen" | "flow",
  directions: Direction[],
  analysis?: DecisionAnalysis
}

Direction { id, name, description?, screens: DecisionScreen[] }

DecisionScreen {
  id, order, source: "upload" | "figma",
  imageRef, figma?: { fileKey, nodeId, frameName },
  tagging?: ScreenAnalysis
}

DecisionAnalysis {
  status, providerMetadata, analyzedAt,
  directionRubrics, evidenceCoverage, lean?,
  personas, corpusEvidence, experimentBrief
}
~~~

Every evidence record links to its direction and, when applicable, screen.

## Analysis Pipeline

1. Validate and normalize Decision to Direction to Screen.
2. Run the existing image tagger for each screen to extract visual, layout, component, domain, copy, and accessibility signals.
3. Retrieve relevant exceptional and cautionary corpus examples from decision context and extracted signals.
4. Generate per-direction comparative rubrics with evidence traces.
5. Generate comparison, optional Lean, evidence coverage, fixed perspectives, and experiment brief.
6. Persist inputs, report, evidence references, provider metadata, and timestamps.

The model must distinguish direct visual observation from inference, flag weak evidence, and consume deterministic signals and corpus facts instead of relying on freeform image judgment.

## Post-MVP: Figma Link Import

Figma links become a first-class input only after the upload-based decision brief is evaluated. The importer will parse and validate a file/node URL, authenticate private access, fetch selectable frame metadata and rendered images, retain file key/node ID/frame name, and let users order frames before analysis.

On import failure, provide recovery: reconnect access, select another frame, or upload an exported image.

## MCP Surface

The dashboard and MCP share decision-analysis services. Keep the initial MCP surface to:

- create_design_decision
- analyze_design_decision
- get_design_decision_report

The report includes the experiment brief. MCP returns the brief summary by default, supports evidence detail on demand, and includes the pre-launch guidance caveat. A standalone screen-critique tool and other convenience tools remain deferred until usage shows that the shared report shape is insufficient.

## Error Handling and Safety

- Require two or three directions and at least one screen per direction.
- Reject unsupported, inaccessible, or oversized images with actionable errors.
- Isolate per-screen tag failures; preserve the decision and allow retry.
- If corpus retrieval fails, complete the visual review but mark corpus evidence unavailable and remove Lean eligibility.
- Preserve completed stages and offer retry when model analysis fails; never present a completed brief from partial evidence.
- Only send uploaded images and decision content to the configured analysis provider with clear disclosure.

## Cost, Latency, and Partial Results

The MVP bounds analysis to two or three directions with one uploaded screen each. It runs deterministic extraction for each screen, then one structured comparative synthesis that includes the four fixed simulated perspectives; it does not run separate persona calls. Existing deferred-critique output is reused where it is relevant.

The UI exposes stages — extracting facts, retrieving evidence, preparing brief — and preserves each completed stage. It gives an estimated provider/model cost before analysis and records actual provider usage after it completes. A missing or failed stage lowers evidence coverage and disables Lean; it does not silently produce a final verdict.

Multi-screen flow comparison is deferred until its own cost envelope, methodology, and evaluation set are defined. It cannot inherit credibility from single-screen analysis.

## Verification

Before implementation, build a held-out evaluation set of 15–25 real design comparisons with expert-judged preference and, where available, a known post-launch outcome. Run the deterministic extraction plus constrained comparative synthesis against that set before changing the Decision Lab prompts or weights.

The evaluation compares at minimum:

- grounded synthesis against ungrounded synthesis;
- corpus-strong versus corpus-limited patterns;
- Lean eligibility against evaluator confidence;
- citation completeness and unsupported-claim rate;
- cost and latency per decision.

The first product increment proceeds only after this evaluation defines acceptable evidence coverage, Lean eligibility, and a cost ceiling. If the corpus grounding does not improve decision-brief quality, ship the tool as screen-observation and validation support rather than a corpus-backed comparator.

Unit tests cover schemas, screen-only scope rules, rubric-to-evidence linkage, corpus fallback/coverage labeling, accessibility-risk citation handling, cost-stage state, and MCP request/response validation.

Browser tests cover a two-direction uploaded screen comparison, expandable evidence linked to the correct source, coverage labeling, retry/partial-result behavior, responsive layout, and report export.

Manual verification confirms that the trade-offs are explainable from the default report, that a Lean never appears with limited evidence, and that the product clearly distinguishes simulated/predicted guidance from real A/B results.

## Delivery Sequence

Deliver in focused increments:

1. Build and calibrate the held-out evaluation set; establish evidence, quality, cost, and latency baselines.
2. Decision model, uploaded screenshots, single-screen decision brief, explainable evidence, and experiment-brief export.
3. Three MCP tools over the shared analysis service.
4. Evaluate a distinct multi-screen methodology before implementing flow comparison.
5. Add Figma-link frame import after the upload workflow proves useful.

Decision records are stored in a decisions.json sidecar using the existing atomic-write and rolling-snapshot durability primitives. This establishes the core decision-brief experience before external integration and expanded agent access.
