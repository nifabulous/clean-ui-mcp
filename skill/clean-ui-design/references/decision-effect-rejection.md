# DECISION + EFFECT + REJECTION — the critique format

The corpus's critiques follow a specific structure. Each notable design choice
is named as three things:

1. **DECISION** — the specific choice made (not "good spacing," but "24px gaps").
2. **EFFECT** — why it works perceptually or functionally (what it does to the
   reader's eye, cognition, or workflow).
3. **REJECTION** — the conventional default it replaces (what most UIs do
   instead, and why that's worse).

This format is what makes a corpus entry worth reading. Without it, a critique
is just opinion. With it, a critique is a reproducible instruction.

## Worked examples — sloppy vs grounded

### Example 1: spacing

**Sloppy** (banned-phrase soup):
> The dashboard has a clean layout with good spacing and a nice visual hierarchy.

**Grounded** (DECISION + EFFECT + REJECTION):
> 24-32px inter-card gaps treat each metric as an isolated scannable object
> rather than tightly packing information. This rejects the dense-dashboard
> default where cards touch or nearly touch, improving individual metric
> legibility at the cost of information density.

- DECISION: 24-32px inter-card gaps
- EFFECT: each metric reads as an isolated scannable object
- REJECTION: dense-dashboard default (cards touching)

### Example 2: color

**Sloppy:**
> Uses a nice accent color that draws the eye to important elements.

**Grounded:**
> The accent hue (#3b82f6) is reserved for a single component class — active
> toggles only — so it signals affordance, not decoration. This rejects the
> common default of accent-everywhere (links, icons, badges, headings all blue),
> which flattens the signal: when everything is accent, nothing is.

- DECISION: accent on active toggles only
- EFFECT: accent = affordance signal
- REJECTION: accent-everywhere default

### Example 3: typography

**Sloppy:**
> The typography is clean and modern with good hierarchy.

**Grounded:**
> Hierarchy emerges from color contrast rather than size or weight modulation:
> muted gray (#7c7474) labels sit above darker (#3c3c3c) values within the same
> point size, forcing the eye to parse meaning through luminance delta alone.
> This rejects the conventional bold-for-emphasis + larger-for-importance
> ladder, eliminating optical noise from weight/scale jumps.

- DECISION: luminance-delta hierarchy, same point size
- EFFECT: separation without weight/scale noise
- REJECTION: bold-for-emphasis + size-for-importance ladder

## How to apply it

When reading a corpus entry's critique, extract the DECISION + EFFECT +
REJECTION for each choice the entry makes. When synthesizing across entries,
carry forward the decisions that recur (consensus) and surface the rejections
explicitly — the rejections are the "what to avoid" half of the brief.

When writing (in a synthesis, a review, or feedback), check every claim: does it
name a specific decision? Does it explain the effect? Does it name the default
being rejected? If not, it's banned-phrase territory — rewrite it.
