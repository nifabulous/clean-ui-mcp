# Decision Lab Design

Date: 2026-07-10

## Goal

Add Decision Lab to clean-ui: a single-user, pre-launch product-design decision workspace for PMs and designers. Users compare two or three competing designs, state the outcome they want, and receive an evidence-grounded recommendation, simulated-perspective feedback, and an experiment brief.

> Compare product-design directions before you ship.

Decision Lab predicts likely strengths, risks, and research hypotheses. It must never present output as statistically valid A/B-test results; that requires production traffic and experiment data.

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
- A direction contains one screen or an ordered sequence of screens.
- Inputs are uploaded PNG/JPG/WebP screenshots or Figma frames selected from a link.
- Single-screen comparisons, such as homepage concepts.
- Multi-screen flow comparisons, such as onboarding or checkout.
- Per-screen tagging, evidence-grounded scoring, corpus retrieval, fixed simulated perspectives, recommendation, and experiment brief.
- Report export and equivalent MCP workflow.

### Out of scope

- Live experiment assignment, traffic collection, or statistical A/B analysis.
- Interactive prototype playback, direct .fig file parsing, custom personas, collaboration, shared links, team roles, Figma editing, or writing back to Figma.

## Experience

### Decision setup

Users start with a decision rather than an A/B test:

- Title: Choose the homepage direction.
- Target user: First-time visitors.
- Business goal: Make the value proposition understandable in 10 seconds.
- Primary KPI: Trial starts.
- Scope: Single screen or multi-screen flow.

### Competing directions

Each decision has two or three named directions, A through C. A direction can use either source:

- Paste a Figma link, authenticate if private, select frames, and set their order.
- Upload one or more screenshots and set their order.

Figma and uploaded inputs can be mixed in one comparison. Both normalize into the same data model.

### Decision-first report

The default report shows:

- Recommended direction and confidence.
- One-line rationale.
- Scorecard for goal alignment, visual hierarchy, cognitive load, accessibility readiness, copy clarity, consistency, and flow coherence when applicable.
- Three strongest reasons for the recommendation.
- One strongest corpus signal.
- One major risk or uncertainty.
- Post-launch hypothesis, success metric, and guardrails.

Expandable evidence includes per-screen annotations, complete score rationale, simulated-perspective observations, retrieved exceptional and cautionary examples, accessibility findings, model metadata, and score inputs.

## Explainability

No direction gets an unexplained score. Each score must link to at least one source:

- visible screen or flow evidence;
- deterministic extracted tag or fact;
- corpus example or anti-pattern;
- named simulated perspective.

The recommendation must compare its strongest signals with the competing directions. Confidence represents evidence quality and agreement; it never represents experimental certainty.

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
2. Direction importer — Figma-link import or image upload, naming, and ordering.
3. Comparison report — direction grid, recommendation rail, scorecards, and evidence summary.
4. Evidence detail — expandable direction, screen, persona, corpus, and accessibility evidence.

Desktop uses a three-direction grid and a persistent recommendation rail. Narrow layouts stack directions. The user can inspect source material without losing comparison context.

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
  directionScores, recommendation,
  personas, corpusEvidence, experimentBrief
}
~~~

Every evidence record links to its direction and, when applicable, screen.

## Analysis Pipeline

1. Validate and normalize Decision to Direction to Screen.
2. Run the existing image tagger for each screen to extract visual, layout, component, domain, copy, and accessibility signals.
3. When a direction has multiple screens, synthesize sequencing, continuity, commitment points, repeated friction, and consistency.
4. Retrieve relevant exceptional and cautionary corpus examples from decision context and extracted signals.
5. Generate per-direction scorecards with evidence traces.
6. Generate comparison, recommendation, confidence, fixed perspectives, and experiment brief.
7. Persist inputs, report, evidence references, provider metadata, and timestamps.

The model must distinguish direct visual observation from inference, flag weak evidence, and consume deterministic signals and corpus facts instead of relying on freeform image judgment.

## Figma Link Import

Figma links are first-class input. The importer parses and validates a file/node URL, authenticates private access, fetches selectable frame metadata and rendered images, retains file key/node ID/frame name, and lets users order frames before analysis.

On import failure, provide recovery: reconnect access, select another frame, or upload an exported image.

## MCP Surface

The dashboard and MCP share decision-analysis services. Add:

- create_design_decision
- analyze_design_decision
- get_design_decision_report
- compare_design_directions
- generate_experiment_brief
- critique_design_screen

MCP returns the decision-first summary by default, supports evidence detail on demand, and includes the pre-launch guidance caveat.

## Error Handling and Safety

- Require two or three directions and at least one screen per direction.
- Reject unsupported, inaccessible, or oversized images with actionable errors.
- Isolate per-screen tag failures; preserve the decision and allow retry.
- Preserve Figma metadata where possible and offer upload fallback.
- If corpus retrieval fails, complete the visual review but mark corpus evidence unavailable and lower confidence.
- Preserve completed stages and offer retry when model analysis fails; never present a final recommendation from partial evidence.
- Only send Figma URLs, images, and decision content to the configured analysis provider with clear disclosure.

## Verification

Unit tests cover schemas, scope rules, score-to-evidence linkage, corpus fallback/confidence reduction, Figma URL/node parsing, and MCP request/response validation.

Browser tests cover a two-direction uploaded screen comparison, ordered flow comparison, mock Figma import, expandable evidence linked to the correct source, recommendation rail, responsive layout, retries, and report export.

Manual verification confirms that Direction B is explainable from the default report and that the product clearly distinguishes simulated/predicted guidance from real A/B results.

## Delivery Sequence

Deliver in focused increments:

1. Decision model, uploaded screenshots, single-screen comparison, explainable report.
2. Ordered multi-screen flow analysis and experiment-brief export.
3. Figma-link frame import.
4. MCP tools over the shared analysis service.

This establishes the core decision experience before external integration and agent access.
