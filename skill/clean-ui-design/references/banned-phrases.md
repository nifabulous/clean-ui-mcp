# Banned phrases — the anti-slop list

These phrases are banned because they are the statistical average of design
writing — they sound evaluative but carry no reproducible information. Every
claim in a synthesis must name a **specific, reproducible decision** instead.

If you catch yourself writing any of these, stop and replace with the specific
choice + its effect.

## The list

**Generic evaluatives** — "clean layout", "modern design", "user-friendly",
"intuitive", "sleek", "minimalist", "good spacing", "nice typography",
"visually appealing", "easy to use", "well-organized", "polished look",
"beautiful", "elegant", "professional", "stunning", "gorgeous", "delightful".

**Filler techniques** — "use whitespace", "keep it simple", "avoid clutter",
"be consistent", "good hierarchy", "clear visual hierarchy", "strong typography",
"thoughtful spacing", "attention to detail".

**Vague anti-patterns** — "bad ux", "poor ux", "too busy", "too much going on",
"not intuitive", "confusing".

## The replacement pattern: DECISION + EFFECT + REJECTION

| Banned | Grounded |
|---|---|
| "clean layout" | "1px borders at 10% opacity do the structural work that heavier shadows would, so the eye reads grouping without noticing the borders" |
| "good typography" | "Hierarchy through weight and size, not color — muted gray labels sit above darker values within the same point size, forcing the eye to parse meaning through luminance delta alone" |
| "modern design" | "Reserve the accent hue for a single component class (active toggles only) so it signals affordance, not decoration" |
| "good spacing" | "24-32px inter-card gaps that treat each metric as an isolated scannable object rather than tightly packing information" |

Every grounded claim names: the **decision** (what was chosen), the **effect**
(why it works perceptually or functionally), and the **rejection** (what
conventional default it replaces — implicit in the examples above).

## Why this matters

The corpus's whole reason for existing is to fight generic AI output. A
synthesis that uses banned phrases has failed at the one job it exists to do —
it has produced the statistical average the corpus was built to replace. The
banned list is the enforcement mechanism.

---

## Visual slop — patterns that make UI look "AI-generated"

<!-- © Edu Calvo (educlopez), MIT License — https://github.com/educlopez/ui-craft -->
> Merged from [educlopez/ui-craft](https://github.com/educlopez/ui-craft). These
> are *visual* anti-slop patterns — the design equivalent of the text phrases
> above. When critiquing or synthesizing, flag these patterns the same way you'd
> flag a banned phrase. Not all are hard blocks (some have legitimate exceptions),
> but each requires justification if present.

**The test:** If someone said AI made this, would they believe it immediately?
If yes, the design has a slop problem.

### Critical (immediately reads as AI)

- Identical card grids (icon + heading + text, 3-6× repeated)
- ALL CAPS on headings, labels, tables, nav, buttons (exception: 11-13px category labels)
- Purple/cyan gradient everything
- Emoji as feature icons
- Bounce/elastic easing curves on UI elements
- Glassmorphism on dark backgrounds with neon accents

### Major (designers notice)

- Colored pills on trend percentages — use plain secondary text
- Thick colored left/top borders on cards — use elevation or bg tint
- Uniform border-radius on everything — vary by element type
- Gradient text on hero metrics
- Vertical bar charts for time-series — use area/line
- `transition: all` — list specific properties
- Decorative glow as primary affordance
- Soft blurry gradient blobs/orbs
- Generic CTAs ("Learn more", "Click here") — be specific
- Walls of text — no landing section > 2-3 sentences
- "OR" divider in caps between auth options — lowercase: "or with email"
- Full-bleed saturated brand panel beside a sign-in form — use tinted neutral + one proof asset
- Uppercase tracked eyebrow above *every* section heading — ration to max 1 per 3 sections
- Numbered section eyebrows ("01 · About") — only when content is a real ordered sequence
- Scroll cues ("Scroll to explore", ↓ arrows) — the composition should imply continuation
- Two CTA labels with the same intent on one page — one label per intent
- Fake product screenshots built from styled divs — use real screenshots or mini components
- Logo walls as plain text wordmarks — use real SVG marks or simple monograms
- Carousels without narrative purpose — earns its place only when order tells a story
- Stacked cards instead of a real layout — cards are for peer items, not section wrappers
- Em-dash flood in UI strings (3+ em dashes in visible copy)

### Minor

- No `tabular-nums` on data tables
- Missing `text-wrap: balance` on headings
- Straight quotes instead of smart quotes in copy
- No `&nbsp;` in brand names
- Testimonial star ratings
- Hero metric without adjacent context

### Legitimate exceptions (when the rules break)

- ALL CAPS is OK for small 10-13px category labels with letter-spacing
- "One accent" doesn't apply to multi-tenant dashboards
- Donut charts OK for two-segment proportional comparisons
- Emoji OK when they're user content (reactions)
- Gradient text OK on branded marketing hero metrics
- Three typefaces OK when each family has a named role (display serif + body sans + mono for data)
