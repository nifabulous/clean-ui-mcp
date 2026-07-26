# Labeling vocabulary and tie-break rules

Read this fully before labeling. Every list is **closed** — pick only from these
values. Inventing a tag creates fake disagreement: two reviewers who both saw a
navigation bar but typed `top-nav` and `topnav` register as disagreeing, which
drags the measured baseline down for no real reason.

> **Operator:** the tie-break rules in §6 are a draft. Edit them to match your
> intent **before** anyone labels, then freeze this file. Changing them
> mid-labeling invalidates the passes already done.

## 1. patternType — exactly one

```
auth  calculator  chat-interface  checkout  command-palette  dashboard
data-table  editor-canvas  empty-state  forms  gallery  interstitial
landing-page  marketing-hero  mobile-nav  modal  navigation  notifications
onboarding  pricing  profile  search  settings
```

This is the single hardest field and the main source of disagreement. See §6.

## 2. categories — 1 to 4

```
auth  chat-interface  checkout  dashboard  data-table  editor-canvas
empty-state  forms  landing-page  marketing-hero  mobile-nav  navigation
notifications  onboarding  pricing  profile  search  settings
```

Unlike `patternType`, this is a set — a screen that is both a dashboard and a
data table gets both. Include the `patternType` value here **only if it also
appears in the categories list above**. Five patternType values are
patternType-only and have no categories equivalent: `calculator`,
`command-palette`, `gallery`, `interstitial`, `modal`. For those, describe the
screen's nature with the closest categories value instead (e.g. a `modal`
sign-in dialog is `patternType: modal`, `categories: [auth]`, not
`categories: [modal]`).

Use one category by default. Add a second only when the screen genuinely spans
two distinct patterns. Use three or four only when each one describes a
substantial, visible part of the screen; do not add categories merely because
the product or its chrome could be described that way. This is guidance only:
the schema still permits 1–4 values.

## 3. components — 1 to 8, only what is visibly rendered

```
area-chart  avatar  avatar-group  badge  banner  bar-chart  bottom-nav
carousel  card-list  chart  checklist  command-palette  cta-button
data-table  donut-chart  drawer  empty-state  feed-list  filter-controls
form-controls  icon-button  illustration  kpi-card  line-chart  list-row
media-grid  metric-grid  modal-dialog  notification-bell  pricing-card
primary-button  progress-bar  report-list  search-command  search-input
segmented-control  sidebar-nav  status-chip  stepper  summary-card  tab-nav
timeline  toggle-switch  top-nav
```

Do not infer components that are plausibly present but not on screen. If a chart
type is unclear, use the generic `chart` rather than guessing `line-chart`.

### Component disambiguation

Use the narrowest visibly supported value. These close pairs are deliberately
different:

| Component | Use it when | Do not use it for |
| --- | --- | --- |
| `kpi-card` | A compact tile shows one quantitative metric and its label, such as `Revenue $12,450`. | A general account, status, or descriptive summary without one primary metric. |
| `summary-card` | A compact tile summarizes an account, status, balance, or state. | A repeated collection of cards or a single isolated metric tile. |
| `card-list` | A visible collection of repeated cards is arranged as a list or grid. | One card, or a page that merely contains several unrelated panels. |
| `cta-button` | The primary conversion or promotional action on a marketing, upsell, or feature-education screen. | The main submit or confirm action inside a functional workflow. |
| `primary-button` | The main submit, confirm, or task action in a functional workflow. | A promotional action whose role is conversion rather than task completion. |

`card-list` describes the collection; `kpi-card` and `summary-card` describe its
visible children. Use both only when both levels are actually rendered and
clear. Do not infer a component from a likely interaction that is not visible.

## 4. domainTags — 1 to 4

```
ai-ml  analytics  banking  communication  crypto  developer-tools  ecommerce
education  enterprise-saas  fintech  healthcare  hr  infrastructure  insurance
investing  marketing  media  payments  productivity  recruiting  security
social
```

Tag the product's domain, not the screen's function. A payments company's
settings page is still `fintech` / `payments`.

Tag the product's primary domain and at most one clearly evidenced secondary
domain. Do not add `banking` to every fintech or payments screen: use it only
when accounts, cards, balances, or banking operations are a distinct visible
function. `payments` describes money moving between parties; `banking`
describes holding or managing money.

Unlike the three lists above, this one is **not** inherited from the corpus
taxonomy — the corpus populates `domainTags` on only 2 of the 40 entries. It was
built by identifying the actual product behind every one of the 40 screens and
covering each. `insurance`, `investing`, `hr` and `recruiting` exist because 14
of the 40 entries (Alan, Wealthsimple, Workable, PAYCHECK, Juicebox) had no
accurate tag without them.

### Boundaries between the close pairs

| Pair | Rule |
| --- | --- |
| `insurance` vs `healthcare` | `insurance` = coverage, claims, premiums, policies. `healthcare` = clinical care delivery. A health insurer is **both** — tag both. |
| `investing` vs `banking` | `investing` = holding or growing assets (portfolios, brokerage, retirement). `banking` = accounts, transfers, cards, balances. |
| `recruiting` vs `hr` | `recruiting` = the candidate pipeline before hire (sourcing, applicants, interviews). `hr` = people already employed (payroll, benefits, reviews). An applicant-tracking product is **both**. |
| `payments` vs `banking` | `payments` = moving money between parties. `banking` = holding it. |

### Deliberately absent: `sales`

Go-to-market and demo tooling is `marketing`. A separate `sales` tag would be a
coin flip against `marketing` on the same screens, manufacturing disagreement
without adding meaning. Same reasoning excludes `personal-finance`, `payroll`,
`project-management` and `wealth-management` — each is a near-synonym of a tag
already in the list.

## 5. Remaining fields

| Field | Value |
| --- | --- |
| `visualFields.density` | `sparse` / `moderate` / `dense` |
| `visualFields.color-scheme` | `light` / `dark` / `mixed` |
| `visualFields.layout` | closed list — see below |
| `visualFields.typography` | the one free-text field: a short phrase, e.g. `geometric sans, tight tracking` |
| `critiqueQuality` | `insufficient` / `acceptable` / `strong` — how well this screenshot alone supports a substantive UI critique |
| `groundedClaimIds` | leave as `["claim:visual-inspection"]` |
| `accessibilityEvidenceIds` | `[]` unless an a11y affordance is visibly rendered; then any of `a11y:visible-focus`, `a11y:skip-link`, `a11y:contrast-control` |
| `protectedFieldExpectation` | always `"unchanged"` |

### `visualFields.layout` — exactly one

```
single-column  two-column  three-column  modal-overlay
```

These are the frozen corpus snapshot's own `layout.form` values, and all four
occur across the 40 selected entries (`single-column` 17, `two-column` 11,
`modal-overlay` 5, `three-column` 3; 4 entries carry no corpus layout at all —
classify those into one of the four yourself).

Count the screen's top-level content columns, ignoring chrome. A sidebar plus a
main region is `two-column`. A sidebar, a main region and a detail rail is
`three-column`. Use `modal-overlay` when a dialog is the focused foreground
element — consistent with the §6a overlay rule.

## 6. Tie-break rules for `patternType`

The rules below come from a diagnostic disagreement analysis of this selection.
The underlying reviewer files were not a canonical, independently sealed pair,
so its counts and metrics are not a baseline and must not be used as evidence
for the C2 gate. The rules are being recorded because they address recurring
ambiguities; freeze this document before the next labeling pass.

### 6a. Overlay vs. what is underneath

Diagnostic examples included `modal` vs `auth`, `modal` vs `forms`,
`modal` vs `dashboard`, and `modal` vs `search`.

**Rule: the overlay wins.** If a dialog, sheet, or drawer is the focused
foreground element, `patternType` is `modal` regardless of what it contains or
what is dimmed behind it. Record the content's nature in `categories` — a
sign-in dialog is `patternType: modal`, `categories: [auth]`.

Note that `modal` exists in the §1 patternType list but **not** in the §2
categories list, because §2 is the corpus taxonomy verbatim and the corpus has
no such category. So do not try to repeat `modal` in `categories`; `patternType`
already carries it. Add `modal-dialog` to `components` instead — that one does
exist, and it is where the overlay shows up as a rendered element. If you are
tempted to classify by the dialog's content, remember: content goes in
`categories`; the focused overlay determines `patternType`.

### 6b. `onboarding` as a catch-all

Diagnostic examples included `onboarding` paired against `empty-state`,
`editor-canvas`, `forms`, `modal`, and `dashboard`.

**Rule: `onboarding` requires visible first-run scaffolding** — a step
indicator, a numbered progress trail, an explicit welcome/setup heading, or a
skip control. A screen that is merely unpopulated, or that a new user happens to
meet first, is not `onboarding`. Label it by what it structurally is.

### 6c. `empty-state` vs the populated pattern

**Rule: `empty-state` wins when the screen's primary content region is
empty and shows a zero-state message or illustration.** Chrome that is still
visible (nav, sidebar) goes in `components`, not `patternType`.

### 6d. Chrome vs content

Diagnostic example: `mobile-nav` vs `dashboard`.

**Rule: classify by the content region, not the chrome.** A dashboard
behind a top nav is `dashboard`; `top-nav` goes in `components`. Use
`navigation` or `mobile-nav` as `patternType` only when navigation *is* the
screen — a full-screen menu, a nav drawer covering the viewport.

### 6e. Residual ambiguity

If two values still fit after 6a–6d, pick the one that appears **earlier** in
the §1 list. Arbitrary, but deterministic and identical for both reviewers,
which is the point.

### 6f. New patternType values added 2026-07-25

Two values were added to §1 to resolve recurring gaps flagged across the
40-entry selection:

- **`gallery`** — a browsable catalog or grid of non-metric items grouped for
  discovery, such as presets, products, integrations, or assets. Use it when
  browsing the items is the primary purpose. If KPI or metric tiles are the
  primary content, use `dashboard`; if rows of structured records are the
  primary content, use `data-table`.

- **`interstitial`** — a dismissible full-screen in-app promotional or
  feature-education screen whose primary purpose is promotion or education.
  Use it for authenticated upsells, feature introductions, and dismissible
  education overlays. Do not use it for a functional screen that merely fills
  the viewport: use `checkout`, `profile`, `forms`, or another content pattern
  when that is the screen's primary purpose. It also differs from
  `marketing-hero` (public marketing/landing content) and `onboarding` (which
  requires first-run scaffolding per §6b).

## 7. When nothing in a list fits — flag the gap

**These lists are known to be incomplete.** They were lifted from the corpus
taxonomy, and that taxonomy was machine-generated: across the 40 entries,
`provenance.taggedBy` is `auto` on 24, absent on 15 and `auto-reviewed` on 1.
An earlier audit found many descriptions of bottom navigation, tab bars, and
other primitives that the original taxonomy could not represent. The current
measurement vocabulary now includes `bottom-nav`, `carousel`, `list-row`,
`avatar`, `badge`, and `stepper`; `breadcrumb` remains unrepresented.

So when no option is right:

1. **Still pick the nearest value.** Leaving a field blank breaks the
   measurement; a near-miss does not.
2. **Then click “⚑ Flag a missing option”** at the bottom of that entry, choose
   the field, and name the value you actually wanted.

Do not add a new vocabulary value during an active pass. Gap flags are evidence
for a later operator amendment; after an amendment, both reviewers must use the
same frozen revision or the pass must be repeated.

Flags are exported alongside your labels, never inside them. They have **no
effect** on your labels, on the agreement metrics, or on whether an entry counts
as complete. They exist so the vocabulary can be fixed on evidence rather than
guesswork.

Flag generously. A gap that both reviewers hit independently is the strongest
signal we can get that the taxonomy — not the reviewer — is wrong.

## 8. Independence

Do not discuss entries, compare files, or agree on conventions beyond this
document while labeling. The measurement is only meaningful if the two passes
are genuinely independent. Questions about the rules go to the operator, who
should answer by amending §6 for both reviewers or not at all.
