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
