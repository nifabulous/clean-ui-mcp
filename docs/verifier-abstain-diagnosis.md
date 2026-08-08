# Verifier Abstain Diagnosis — 2026-08-08

What the 2026-08-08 cohort's `not positively confirmed` abstains actually are,
measured on a fresh read-only re-run of the same 50 entries.

## Run header

- Model: **minimax/MiniMax-M3**, both passes (the worktree's `.env` routes pass
  2 to minimax; the env's default NIM/DeepSeek critique endpoint is text-only and
  400s on `image_url`, so the default was not usable for a vision re-produce).
- Image detail: low · Sampling: temperature=0 seed=20260806 · Verifier: verifier-v1
- Date: 2026-08-08
- Entries: the 50 ids from the committed `verify-report.md`, via
  `--diagnose --only-ids` (exact id list at the bottom of this document).
- Run 1 measured 38 entries; 12 entries failed with transient `fetch failed`
  network errors and were re-run as a second invocation, which measured all 12
  with zero failures. Results below are the union of the two runs.
- Corpus: `corpus/entries.json` sha256 before and after both runs is
  `c47ffecc01964a48cec1cc520ae4244f609a679ca034c4eac404e7891af4a0bf` —
  **UNCHANGED**. The governing invariant held.

## Result

Verdicts across 50 entries × 22 servable fields (1100): **488 pass, 5
contradicted, 283 abstain, 324 gated, 0 fail**.

283 abstains minus 50 `platform` detector abstains = **233 model-lane abstains
with a cause**.

### Abstain causes (combined)

```
Abstain causes — 233 total
  model-abstained         215  (corroborate 17, initial 165, reverify 33)
  corroboration-split      16  (corroborate 16)
  verdict-unrecognised      2  (initial 2)
  by call site: corroborate 33, initial 167, reverify 33
Prose first causes (not counted in the total above): model-abstained 28, verdict-missing 50, verdict-unrecognised 19
```

**Per-run blocks, verbatim:**

```
# Corpus verification (DRY-RUN) — verifier-v1
Model: minimax/MiniMax-M3 · image detail: low · sampling: temperature=0 seed=20260806
Entries scanned: 50
Verdicts — 358 pass, 3 contradicted, 212 abstain, 263 gated, 12 fail (image-level only)
Zero-assertion prose fields: 8 (report per prose field before trusting a run)

Abstain causes — 174 total
  model-abstained         162  (corroborate 12, initial 122, reverify 28)
  corroboration-split      12  (corroborate 12)
  by call site: corroborate 24, initial 122, reverify 28
Prose first causes (not counted in the total above): model-abstained 25, verdict-missing 37, verdict-unrecognised 14
```

```
# Corpus verification (DRY-RUN) — verifier-v1
Model: minimax/MiniMax-M3 · image detail: low · sampling: temperature=0 seed=20260806
Entries scanned: 12
Verdicts — 130 pass, 2 contradicted, 71 abstain, 61 gated, 0 fail (image-level only)
Zero-assertion prose fields: 3 (report per prose field before trusting a run)

Abstain causes — 59 total
  model-abstained          53  (corroborate 5, initial 43, reverify 5)
  corroboration-split       4  (corroborate 4)
  verdict-unrecognised      2  (initial 2)
  by call site: corroborate 9, initial 45, reverify 5
Prose first causes (not counted in the total above): model-abstained 3, verdict-missing 13, verdict-unrecognised 5
```

## Per-field cause split

Every model-lane abstain in this run carries `model-abstained` except the 16
`corroboration-split` abstains (fields whose first fresh ask contradicted and
second confirmed) and 2 `verdict-unrecognised` (prose fields returning an
unrecognised verdict string on the initial ask).

| field | pass | contradicted | abstain | gate | note |
|---|---|---|---|---|---|
| platform | 0 | 0 | 50 | 0 | detector abstain (no cause) |
| visual.accentColor | 8 | 1 | 39 | 2 | single-image ceiling cluster |
| styleTags | 17 | 1 | 32 | 0 | hedging cluster |
| visual.usesShadows | 25 | 0 | 25 | 0 | single-image ceiling cluster |
| visual.usesBorders | 31 | 1 | 18 | 0 | hedging cluster |
| categories | 35 | 0 | 15 | 0 | hedging cluster |
| layout | 37 | 0 | 13 | 0 | hedging cluster |
| visual.cornerStyle | 37 | 0 | 13 | 0 | hedging cluster |
| visual.colorRoles | 0 | 0 | 12 | 38 | single-image ceiling cluster |
| visual.spacingDensity | 39 | 0 | 11 | 0 | hedging cluster |
| critique | 37 | 0 | 10 | 3 | hedging cluster |
| whatToSteal | 36 | 1 | 10 | 3 | hedging cluster |
| antiPatterns | 39 | 0 | 8 | 3 | hedging cluster |
| patternType | 43 | 0 | 7 | 0 | hedging cluster |
| antiPatterns.accessibilityRisks | 0 | 0 | 6 | 44 | hedging cluster |
| voice | 31 | 0 | 5 | 14 | hedging cluster |
| components | 5 | 0 | 4 | 41 | hedging cluster |
| mood | 6 | 0 | 3 | 41 | hedging cluster |
| colorScheme | 8 | 0 | 1 | 41 | hedging cluster |
| domainTags | 5 | 0 | 1 | 44 | hedging cluster |
| visual.dominantColors | 49 | 1 | 0 | 0 | hedging cluster |
| visual.typePairing | 0 | 0 | 0 | 50 | hedging cluster |

## Prose first causes

97 prose first-ask causes are reported separately (not counted in the total):
model-abstained 28, **verdict-missing 50**, verdict-unrecognised 19. The initial
ask frequently drops the verdict key or returns an unrecognised string for prose
fields; the re-produce ask then re-classifies almost all of them to
`model-abstained` with an informative reason. Verdict-missing at 50 first
causes is the largest defect-adjacent signal in the lane, but as a FINAL cause it
is n=0 — the re-produce pass masks it, which is exactly why `firstCause` exists.

## Rule 1 — defects (absolute, share-independent)

None of the six defect causes reached **n ≥ 10** in this run:

| cause | n (final) | decision |
|---|---|---|
| response-unparseable | 0 | below bar, recorded |
| response-not-object | 0 | below bar, recorded |
| field-absent | 0 | below bar, recorded |
| field-not-object | 0 | below bar, recorded |
| verdict-missing | 0 (50 as firstCause) | below bar as final cause, recorded |
| verdict-unrecognised | 2 (19 as firstCause) | below bar, recorded |

**No parser or prompt-contract fix is triggered by Rule 1.** `corroboration-split`
at n=16 is not one of the six defect causes; it is the model's known 14–18%
between-run flip showing up inside a single run (first ask contradicted, second
confirmed), and it grants neither a trust record nor a finding by design.

## Rule 2 — lane headroom (reason-text)

All 215 `model-abstained` reasons are quoted verbatim below, grouped by field.
Manual read of the strings gives two clear clusters:

1. **"Cannot determine from one screenshot" — the single-image ceiling.** The
   three pixel- or subtlety-precision fields concentrate here: `visual.accentColor`
   (39 abstains), `visual.colorRoles` (12), `visual.usesShadows` (25) — 76 of
   215. The reasons consistently say exact hex values cannot be verified from a
   screenshot without color sampling, and subtle shadows cannot be confirmed or
   ruled out at this resolution. These fields are at the ceiling for THIS lane:
   asking the model again will not help, and the honest options are reclassifying
   them to the `gated` tier or measuring them with pixels (the element-box
   probe's premise — exactly these fields).
2. **Hedging with specific evidence — prompt/consensus headroom.** The rest
   (styleTags 32, usesBorders 18, categories 15, layout 13, cornerStyle 13,
   spacingDensity 11, prose ≈33, plus the smaller soft fields) hedge with
   "appears to be", "plausibly", "partially supported", "cannot definitively".
   The reasons are specific and informative, which means the model sees the
   evidence but will not commit: a stricter confirm-or-contradict contract, or a
   second consensus ask, has real headroom here.
3. **Empty or restating the claim: n=0.** The prompt elicits usable reasons. No
   prompt-empty finding.

**Decision:** both Rule 2 branches fire independently. The pixel-precision
fields sit at the single-image ceiling (reclassify to gated, or measure with
pixels). The soft/taxonomy fields hedge informatively (prompt and consensus work
is worth building). Neither branch makes element detection unnecessary: the
usesShadows/usesBorders/spacingDensity/cornerStyle abstains are exactly the four
fields the parallel element-box probe is designed to measure.

## Stated limit

The model flips 14–18% between identical runs, so this run's abstain count (283)
does not equal the committed report's 244. This is a rate measured on a fresh
run over the same 50 entries, not a per-verdict autopsy of `verify-report.md`.
The 12 entries that failed run 1 with transient network errors were re-run and
are included; their exclusion from the committed report is not a corpus-churn
finding.

## Exact --only-ids list (re-executable)

Run 1 (50 ids): `$(cat /tmp/cohort-ids.txt)`
Run 2 (12 network-failed ids re-run): `hume-hume-10,hume-hume-11,hume-hume-12,hume-hume-13,hume-hume-14,hume-hume-2,hume-hume-5,hume-hume-7,hume-hume-8,origin-origin-2,origin-origin-3,origin-origin-4`

The id list is also committed in `verify-report.md` headings (50 rows); a
re-run is: `npm run verify -- --detectors on --diagnose --only-ids "$(grep '^## ' verify-report.md | cut -c4- | paste -sd, -)"`.

## Verbatim model-abstained reasons

### visual.accentColor (38 abstains, 38 unique reasons)

- [x1] Exact hex value cannot be confirmed; a dark color is used for the GENERATE SAMPLES button but precise value is not verifiable.
- [x1] The 'hume' wordmark and SAVE button appear dark plum, plausibly matching #5c274f, but exact hex cannot be confirmed visually.
- [x1] The screenshot shows a dark button and a purple/blue card icon, but exact hex values cannot be verified from the image alone.
- [x1] No color picker was used to verify the exact hex value; the brownish tone is visible but the precise shade cannot be confirmed from the image alone.
- [x1] I can see dark neutral fills on buttons and active nav items, but I cannot positively confirm the exact hex value #3c3c3c from the screenshot alone.
- [x1] There is a clearly green element (the success checkmark circle and the 'Done' button) but its exact hex value cannot be positively verified from the screenshot alone.
- [x1] No pixel sampling tools; cannot positively confirm the exact hex of the purple-blue accent. Purple/lavender tones are visible on the circular icons but exact value not verifiable from the image alone.
- [x1] The exact hex value cannot be verified from the screenshot; while a blue is visible in the logo, pill buttons, and icons, the precise shade cannot be positively confirmed as #0484ea without color extraction.
- [x1] The Continue button is clearly a saturated cyan/blue, but I cannot confirm the exact hex value #04a4fc from visual inspection alone.
- [x1] While there are clearly blue accent colors visible in the screenshot (active Home tab, Add employee button), I cannot definitively confirm the exact hex value #2890c4 from visual inspection alone. The blue appears to be a medium blue tone, but verifying a specific hex value would require precise color measurement tools rather than visual estimation.
- [x1] An icon (avatar with 'A') appears teal/green, not the claimed blue. Cannot positively confirm #0484ea as the accent without exact extraction.
- [x1] I cannot verify the exact hex value from the image; the accent appears to be a light blue/cyan but the precise shade cannot be confirmed visually.
- [x1] The screenshot shows pale blue accents on the pending time report card and the active 'People' tab, but I cannot precisely verify the exact hex value #85afbe from the image alone.
- [x1] No browser color-picker access; the named cyan in the 'Done' button and top nav dot could plausibly be #19adf5 but cannot be verified visually to that hex.
- [x1] There is a clearly visible blue accent color used on the active 'People' nav item and the 'Employee' badge, but I cannot precisely verify the exact hex value #0484ea from the screenshot.
- [x1] Cannot confirm the exact hex #0ab7fb from the image; blue tones are visible in the gradient and avatar accent, but pixel-precise hex matching is not possible.
- [x1] I can see green accent elements throughout the interface, but I cannot positively confirm the exact hex value #12c18f from the screenshot alone. Multiple slightly different greens could match this claim, so I must abstain rather than guess.
- [x1] There is a light blue tone visible on the active nav item ('People'), the avatar background, the role chip, and category icons, but exact hex values cannot be determined from the image; the claim specifies #4999ca, which is not verifiable by eye.
- [x1] A blue accent is visible (close icon, sort indicator), but the exact hex #066aae cannot be verified visually.
- [x1] There is some blue visible in the top bar and icons, but I cannot confirm the precise hex value #0484ea from the screenshot.
- [x1] The 'Employee' badge appears teal/blue but the exact hex value cannot be confirmed from the screenshot alone. A color close to #1ca3e5 is plausible but not positively verifiable.
- [x1] There appears to be a teal/blue accent color visible on icons and active states, but I cannot confirm the exact hex value #4e98af from the screenshot.
- [x1] Cannot verify exact hex value from screenshot; the blue visible appears to be a medium blue but precise shade cannot be confirmed.
- [x1] There is no large, unmistakable accent area in #51a4be visible in the screenshot. The UI uses muted grays for most surfaces and the colored elements (orange Edit button, purple avatar) do not match #51a4be, but the claim targets an 'accent color' and I cannot positively confirm or contradict without a clearer accent surface to compare.
- [x1] While a blue accent is visible on the 'Manager' badge and active nav state, the exact hex value #4ccdf7 cannot be precisely verified from the screenshot alone.
- [x1] The accent appears as a saturated medium blue (e.g., on the 'Onboarding' nav pill, the send button, the '0' avatar), but exact hex matching from perceptual inspection is not reliable.
- [x1] No ground-truth hex value was supplied to compare against; cannot visually confirm an exact hex code from a screenshot alone.
- [x1] I cannot confirm an exact hex value from the screenshot alone; no color picker or hex indicator is visible. The dominant blue tones I can perceive may or may not match #1498ee.
- [x1] Cannot precisely confirm exact hex #1faeee from the screenshot; blue tones are present but exact match cannot be verified by eye.
- [x1] No hex value can be verified visually; the dominant accent visible is the black 'CONTINUE' pill, not a purple/mauve hue.
- [x1] I cannot precisely verify the exact hex value #bc6b35 from the image. There are warm orange/brown tones visible but I cannot confirm the exact hex.
- [x1] The darkest UI element appears dark grey/near-black, which is consistent with #46463e, but exact hex cannot be confirmed from the image.
- [x1] Cannot reliably verify a specific hex value from the screenshot; the visible dark tone on the active tab/button could match but pixel-level color extraction isn't possible from this view.
- [x1] The dark accent areas appear near-black, but the exact hex cannot be confirmed visually.
- [x1] There is no clearly visible blue accent element in the screenshot. The 'OK' button appears dark/black rather than blue. Cannot confirm exact hex.
- [x1] I can see a teal/green accent color but cannot confirm the exact hex value #0c6769 without color sampling.
- [x1] The chart shows a light blue line for forecast and red/pink for projection, but exact hex cannot be confirmed by eye.
- [x1] A teal/dark cyan accent is visible in the design, but I cannot confirm the exact hex value #315c66 from the screenshot.

### styleTags (31 abstains, 31 unique reasons)

- [x1] 'Minimal' is plausibly visible due to restrained UI, and there is a soft shadow on the card. However, there is clearly color present (the plum 'hume' wordmark, and a faint warm tint), so 'monochrome' is contradicted; overall the style tag bundle as stated is not fully supported.
- [x1] The interface is minimal and flat; soft-neumorphic styling (inset/extruded soft shadows as primary surface treatment) is not evident.
- [x1] The design is monochrome/neutral and fairly minimal, but a definitive tag match cannot be made without confirming broader styling.
- [x1] 'minimal' is plausibly supported but subjective; 'high-contrast' is not strongly evident — the red-on-white contrast is high but most of the UI is low-contrast grey text on light grey, so neither claim can be positively verified as a pair.
- [x1] Contrast appears standard (mostly dark text on light background); nothing strongly 'high-contrast'. No monospace typography is visible — body and labels use a standard sans-serif. Cannot confirm either tag.
- [x1] 'Minimal' is partially supported by the airy, sparse composition. 'Soft-neumorphic' is partially supported by the visible soft shadows. 'Warm-tactile' is harder to confirm: the background reads as near-white/cool off-white rather than warm; the palette includes lavender, pink, and orange accents that don't strongly read as 'warm-tactile'. Mixed evidence — abstain rather than confirm or contradict.
- [x1] The palette is restrained (white background, black text, single cyan accent, small yellow accent), which does not strongly support 'bold-color.' Playfulness is debatable—the illustration is not visible. Not enough positive visual evidence to confirm both tags.
- [x1] The screenshot contains substantial UI (navigation, form fields, buttons, background content cards), so I cannot confirm a 'minimal' style tag purely from visual evidence.
- [x1] The design uses simple components and restrained color, but cannot definitively classify it as 'minimal' alone.
- [x1] The screenshot shows a clean, card-based HR interface consistent with a minimal style and includes high-contrast elements (yellow accent, black text). However, the claim of being 'playful' is not visibly supported — there are no playful illustrations, rounded playful shapes, or whimsical design choices typical of a playful UI. Since not all three claimed tags can be positively confirmed, I must abstain.
- [x1] The image has shadows but does not exhibit neumorphic inset/embossed lighting; it is closer to a soft-shadow card style than true neumorphism, and the density is moderate rather than dense.
- [x1] The UI is minimal, but elements use flat fills and subtle drop shadows rather than the inset/raised neumorphic shading; cannot confirm the neumorphic tag.
- [x1] The interface does appear largely monochrome with a single blue accent (monochrome check likely holds), and it reads as relatively minimal. However, 'dense-data' is contradicted — the profile page is sparse and not information-dense, with significant whitespace and only one heatmap visualization.
- [x1] The interface includes a gradient background and toolbar, which push beyond a strictly minimal aesthetic; 'minimal' as a sole tag is not unambiguously confirmable.
- [x1] The UI is fairly minimal, but the claim is subjective and I cannot definitively confirm the tag without risking mislabel.
- [x1] The screenshot shows a user profile interface but contains no visible style tag text claiming 'soft-neumorphic'. While the design does show some soft shadow effects on the avatar and buttons, I cannot confirm the specific style tag label is present in the image.
- [x1] The interface is restrained but I cannot confidently affirm the single tag 'minimal' — there are multiple decorative elements (avatars, chips, icons) that could also support other style labels.
- [x1] The interface is relatively minimal/clean, but the content is not particularly dense-data — it's more sparse with sparse form-like entries. Cannot fully confirm both tags.
- [x1] The minimal tag may apply, but the data shown is sparse (only 2 rows in a large empty area), not dense-data.
- [x1] Minimal fits the clean look, but there is no monospaced/technical typography visible, and contrast is moderate rather than high-contrast. Cannot confirm all three tags.
- [x1] The dense-data tag is plausible given the many metadata rows, but 'minimal' and especially 'playful' (the birthday/balloon iconography is decorative but limited) cannot be positively confirmed as overall style descriptors from the screenshot alone.
- [x1] The interface reads as flat and minimal, but it does not exhibit the inset/outset dual-shadow look typical of neumorphism; this cannot be positively confirmed.
- [x1] The screen shows only two list rows and is not visually dense; the 'dense-data' tag is not clearly supported by what is shown.
- [x1] The neumorphism claim cannot be confirmed because the visible controls (Publish button, Change cover image, Edit post, bubble avatar, sidebar icons) show flat shading rather than the soft inset/outset shadow pairs that define the style. Playfulness is debatable; the gradient hero and circular avatar hint at it but the content is an editorial blog post. I cannot positively confirm all three tags together.
- [x1] While the design appears minimal, the word 'minimal' as a style characterization is subjective and not strictly verifiable from pixels alone; the lack of decorative elements supports it but I abstain to avoid guessing.
- [x1] verdict "partial"
- [x1] Warm-tactile and bold-color are supported by the gradient and saturated fills, but 'soft-neumorphic' is not clearly supported — the elements appear flat-filled with hairline borders rather than soft inset/outset neumorphic shading.
- [x1] Minimal is plausible given the simple layout. Soft-neumorphic is questionable — the surface looks flat without the characteristic inner/outer shadow beveling typical of neumorphism. Playful is subjective. Partial fit.
- [x1] Minimal: largely confirmed due to restrained visual elements. Warm-tactile: not clearly confirmed — the palette reads as cool/neutral light with a teal accent, not a warm tactile palette.
- [x1] The interface has data density, but typography doesn't read as technical-mono — labels look like a standard sans-serif. Cannot fully confirm all three tags.
- [x1] The design is fairly minimal, but the 'editorial' tag is not clearly evident — the styling is more utilitarian/dashboard than editorial-magazine-like.

### visual.usesShadows (25 abstains, 25 unique reasons)

- [x1] No clearly visible drop shadows on cards or elements can be confirmed; panels appear to rely on background color difference rather than shadow.
- [x1] There is some subtle elevation on the cards but the shadows are too faint to confidently confirm presence.
- [x1] I do not positively see distinct drop shadows on cards, buttons, or panels; surfaces appear largely flat with borders. Cannot confirm.
- [x1] No clear drop shadows are visible, but subtle ambient shadows cannot be fully ruled out from a single flat screenshot.
- [x1] No obvious drop shadow is clearly visible on panels or buttons in the screenshot; cannot positively confirm or deny.
- [x1] Some elements (the success card, possibly buttons) may have subtle elevation, but the shadow presence is not clearly visible enough to positively confirm in the screenshot.
- [x1] I cannot definitively confirm the absence of shadows at this resolution; subtle shadows may exist.
- [x1] No clearly visible drop shadows are apparent in the screenshot; the design appears to rely on flat borders or background tints rather than shadows.
- [x1] I cannot definitively confirm the complete absence of any subtle shadows on the input cells or button from the image.
- [x1] Subtle elevation differences may be present on cards but cannot be definitively confirmed as shadows from this view.
- [x1] There may be very subtle shadows on cards, but they are not clearly visible enough to confirm or contradict the claim.
- [x1] Cards and panels appear flat against a near-white background; any shadow would be extremely subtle and is not clearly visible enough to confirm.
- [x1] Some subtle depth may be present on the modal, but it is not clearly discernible enough to confirm definitively.
- [x1] Cannot clearly confirm shadow effects on elements from the screenshot; no obvious pronounced shadows are visible.
- [x1] No obvious drop shadow is clearly visible on cards, buttons, or the dropdown. Surfaces appear flat against the background, but I cannot positively confirm or rule out very subtle shadowing.
- [x1] Subtle shadowing on cards may be present but is not clearly distinguishable from the light background in the screenshot.
- [x1] No clearly visible drop shadows on nav, bars, or buttons. The avatar on the right has a faint shadow but it is too subtle to confirm with certainty.
- [x1] The listed rows appear to have hairline borders rather than discernible drop shadows; I cannot positively confirm shadows.
- [x1] Cannot definitively confirm absence of subtle shadows; inputs and button appear flat but minimal ambient shadow cannot be ruled out from the image.
- [x1] I cannot definitively confirm the absence of subtle drop shadows; the white containers on a light background could be flat or slightly shadowed. Not enough visual evidence to confirm or contradict.
- [x1] Shadows are not clearly discernible at this resolution; the card edge could be a border or a subtle shadow, but I cannot positively confirm.
- [x1] The demo card and pill appear to have subtle elevation cues, but I cannot rule out soft shadows with certainty; no strong shadow is visible.
- [x1] Cannot definitively determine whether shadows are present at this image resolution. The card may have a very subtle shadow, but it's not clearly visible or clearly absent.
- [x1] There may be very subtle shadowing around the white form card or its internal elements, but the shadows are not clearly visible enough to confirm at this scale.
- [x1] Cards on the page (Current, Calculation, Compare scenarios) appear to have very subtle elevation or none at all — cannot definitively confirm or deny shadow absence.

### categories (14 abstains, 14 unique reasons)

- [x1] The page is a library/list view of saved voices, not a metrics dashboard; the left navigation is present but the page itself is a collection view, so the 'dashboard' category is not positively confirmed.
- [x1] Navigation is present, but this is not a traditional dashboard view, and no form inputs beyond a single text field are visible.
- [x1] Navigation is clearly present (sidebar + tabs). A form/editor view is visible, but it is not clearly a 'dashboard' in the conventional sense — no metrics, KPIs, or overview widgets are shown.
- [x1] Navigation is clearly present (left sidebar with sections). The main content is a confirmation/success state rather than an active form or settings panel. The category 'forms' and 'settings' cannot be positively confirmed from what is visible.
- [x1] The screenshot shows what appears to be a form modal over a dashboard with onboarding-like sidebar items, but the specific category set cannot be visually confirmed.
- [x1] Profile content (Alex Smith's profile) is clearly visible. A settings category cannot be confirmed from what's shown.
- [x1] Dashboard and navigation are clearly present, but there is no visible search component in the screenshot (only a settings/help icon area at top right), so the full category set cannot be confirmed.
- [x1] A profile page is clearly visible (Alex Smith, UX Designer), and navigation is clearly present (top horizontal nav). However, no data-table is visible — the content includes a heatmap contribution grid and a Requests list of cards, neither of which is a conventional data table. Two of three categories match but the 'data-table' component is absent.
- [x1] The screenshot depicts a single employee profile page. 'Profile' is plainly present as a sub-tab, but the image does not visibly contain a dashboard (no aggregated analytics, summary widgets, or KPI tiles) or a settings page (no preferences, toggles, or configuration options). Because the claim lists three categories and two of the three cannot be positively seen in the screenshot, the claim as a whole cannot be confirmed. The image also does not positively disagree with the claim — it simply shows one of the three listed page types. A definitive verdict cannot be returned under these conditions.
- [x1] While the page shows a profile and navigation, the broader category classification cannot be definitively confirmed or denied from the visible elements alone.
- [x1] Navigation is present; the timeline could be a dashboard, but there is no editor-canvas. The combination does not match the screenshot.
- [x1] A dashboard-style background is visible, but no data-table grid and no traditional form fields are shown in the screenshot.
- [x1] Navigation is clearly present and an editor/canvas area is visible, but no forms are evident in the screenshot.
- [x1] The screenshot shows a financial forecasting product UI, but there are no visible category labels or taxonomy tags displayed on the interface itself. I can describe what is shown (a chart-based forecasting view with sidebar nav), but I cannot confirm the specific categorical claims 'dashboard, navigation, data-table' as labeled properties of the design without explicit indicators.

### visual.colorRoles (12 abstains, 12 unique reasons)

- [x1] Color values cannot be precisely verified from the screenshot alone; the palette appears muted/neutral but exact hex values are not determinable.
- [x1] Hex values cannot be verified by eye; the canvas/surface appear very light off-white and the sidebar heading 'hume' and SAVE button appear dark plum/black-ish, but exact hex matching is not possible.
- [x1] Without precise color sampling I cannot confirm exact hex values; the canvas appears white, text appears dark grey, and the button appears bright blue, but I cannot verify specific hex codes from the image alone.
- [x1] The background appears off-white/light gray rather than bright yellow (#f9e87a). Cannot positively confirm the exact hex values without extraction tools.
- [x1] I can confirm the white canvas/surface and dark ink color, but I cannot positively verify the muted #8db4c0 (a muted blue-gray) or the accent #12c18f (a green). The visible accent elements appear to be orange/amber (progress bar) rather than the claimed teal and green, so I cannot confirm the full palette claim.
- [x1] The exact hex values cannot be confirmed from a screenshot alone; the background appears near-white, text appears dark gray, and a blue accent is visible, but precise hex matching is not verifiable.
- [x1] I can see a warm beige canvas, dark brown sidebar surface, dark ink for headings, and muted purple-gray for some accent text. However, I cannot precisely verify exact hex values from the image. The overall palette appears consistent with warm beige, dark brown, and muted purple-gray tones.
- [x1] Specific hex values cannot be reliably confirmed from a low-resolution screenshot; the overall light beige/neutral palette is consistent but exact hex matches cannot be verified.
- [x1] Pixel-level hex verification is not feasible from the image; the dark elements appear very dark (near-black) and the background is a warm pinkish hue, but exact hex values cannot be confirmed.
- [x1] Cannot precisely verify exact hex values from the image. The canvas appears light purple-ish, but exact hex matches cannot be confirmed visually without color picker tools.
- [x1] Specific hex values cannot be verified by visual inspection alone. The background appears off-white/light, not a warm peach (#d1a89c), and I cannot confirm exact hex matches without sampling.
- [x1] I cannot precisely verify these specific hex values from the screenshot alone. The canvas appears light/white, surfaces appear light green-tinted, and there is a teal accent visible, but matching exact hex values is not possible.

### visual.usesBorders (12 abstains, 12 unique reasons)

- [x1] Borders are not clearly visible at this resolution; the dashboard cards appear to rely more on background fills (e.g., the yellow 'Get office' sticky-note area) than on hairline outlines.
- [x1] Visible borders/outlines appear around the card regions (Tasks, Birthdays, Time-off Requests cards), so the claim 'no borders are used' cannot be confirmed.
- [x1] The image is ambiguous: the Onboardings card appears to have a thin border around it, but other cards seem borderless with only shadows. Cannot positively confirm nor contradict the claim as stated.
- [x1] Card edges may rely on shadow or very thin separators, but a distinct hairline border is not clearly distinguishable from the soft shadows.
- [x1] Category cards (General, Internal, Signed documents) and the right-canvas container appear to have very thin dividing lines, but the contrast is too low to positively confirm a deliberate hairline border versus mere background separation.
- [x1] I can see some separators between elements but cannot positively confirm they are specifically 'hairline' borders versus other divider treatments.
- [x1] Cannot clearly distinguish hairline borders from background or other separators in the screenshot.
- [x1] No clearly visible hairline borders between nav items or around the canvas. Borders are too subtle to confirm.
- [x1] The screenshot uses subtle borders/lines to separate UI regions (such as the right-hand chat panel and dividers between task cards), but the overall treatment is dominated by dividers and section separations rather than decorative borders. The claim 'no borders are used' cannot be definitively confirmed or contradicted at this level of resolution; elements like the chat panel separation could be interpreted as either a border or a background color difference.
- [x1] The rating cards appear to rely primarily on shadows and background fill rather than distinct hairline borders. No clear hairline border stroke is positively visible on the cards.
- [x1] The form card has a visible outline, but whether it is a border, a shadow, or both cannot be positively determined from the image.
- [x1] While there are some outlined elements (like the button), I cannot positively confirm the presence of hairline borders as a deliberate design choice across the card or container. The card edges appear to rely on tonal contrast against the background rather than visible border lines. Insufficient visual evidence to confirm the claim.

### visual.cornerStyle (12 abstains, 12 unique reasons)

- [x1] While individual CTA buttons ('Sign in', 'Try it for free') display heavy corner rounding suggestive of a pill shape, the overall 'cornerStyle' attribute is too broad to confirm from these elements alone without seeing more of the interface's containers, cards, or inputs. There is insufficient visual evidence to definitively confirm or contradict a global 'pill' corner style.
- [x1] At this resolution I cannot reliably determine whether the button and input cells have slightly rounded corners or perfectly square corners.
- [x1] Corner radius is too subtle in the screenshot to definitively confirm slight rounding vs. sharp corners.
- [x1] Cards and the profile image appear to have rounded corners, but I cannot confirm the exact degree of rounding (slight vs. moderate) precisely from the screenshot.
- [x1] Cannot clearly determine corner radius from screenshot.
- [x1] The 'Today' floating button appears rounded; other elements are too small or distant to confidently assess corner radius. Not enough certainty.
- [x1] Corners on the modal, buttons and attachment block all appear consistently rounded; no sharp/sharp-mixed variation is clearly visible to confirm 'mixed'.
- [x1] Buttons and row containers appear to have small rounded corners, but the degree is hard to confirm definitively from this resolution.
- [x1] Some rounded corners are visible on the Publish button and chip, but the exact 'slight-round' classification cannot be precisely verified.
- [x1] The button and inputs clearly use a fully rounded pill shape, not a 'slight' round; the descriptor does not match what is visible.
- [x1] The cropped image does not clearly show the corner radius of the input fields or dropdown container at sufficient resolution to confirm.
- [x1] Corners appear softly rounded on the card and button, but the exact radius is not clearly resolvable; cannot positively confirm 'slight-round' specifically.

### visual.spacingDensity (11 abstains, 11 unique reasons)

- [x1] Spacing appears moderate; the sidebar has tight padding while the main canvas has generous padding. Not enough consensus to call it 'spacious' overall.
- [x1] There is reasonable whitespace between sidebar items and around the success card, but 'spacious' is subjective and borderline; not confident enough to confirm or contradict.
- [x1] Cannot confidently judge the overall spacing density claim of 'moderate' against the screenshot without a clear reference standard.
- [x1] The layout appears moderately spacious with generous padding around cards and sections, but I cannot definitively classify it as 'spacious' versus 'comfortable' or 'balanced' from a single screenshot — the density relative to typical benchmarks is not objectively verifiable.
- [x1] Density is moderate but 'spacious' is a subjective descriptor; I cannot positively confirm nor contradict.
- [x1] The modal uses comfortable but not loose padding; I cannot reliably judge whether this is 'moderate' without a comparison reference.
- [x1] The layout has moderate spacing; whether it qualifies as 'spacious' versus 'comfortable' or 'normal' is subjective and cannot be definitively confirmed.
- [x1] Cannot clearly assess overall spacing density from the limited content shown.
- [x1] Rows have moderate padding; I cannot definitively classify density as compact versus roomy from the image alone.
- [x1] Spacing appears moderate to roomy but cannot definitively confirm 'spacious' as a categorical descriptor.
- [x1] The screenshot is tightly cropped showing overlapping form containers; the full page padding and overall density cannot be reliably assessed from this view.

### critique (10 abstains, 10 unique reasons)

- [x1] I can positively confirm the uppercase headers (TEXT TO SPEECH, CONVERSATIONAL AI), the dark filled-pill START button, the single nested card for the wizard task, the back arrow top-left, and the right-aligned cluster (Starter, credits, notifications). However, I cannot confirm with certainty that the sidebar items are grouped under those uppercase headers rather than being independent categories — they may be section labels with their own items. The active sidebar item does appear to have a subtle gray fill with no left-border accent, but whether the fill 'hugs the label only' is hard to verify precisely. Some assertions are confirmed individually, but I abstain on the overall verdict because the critique's structure mixes confirmed and unclear claims.
- [x1] The text contains no specific checkable factual assertions about named colours, regions, components, or layout features. It is purely a meta-statement about the screenshot's value as a reference.
- [x1] Assertion 1 (label-over-value rhythm with small gray labels and larger dark values in the left rail) is confirmed: labels like 'Email', 'Personal email', 'Work phone' appear in lighter/smaller type above values like 'alexsmith@potent-mobbin.com'. Assertion 2 (inline section tabs above stacked content cards) is confirmed: Profile/Details/Documents/Time-off tabs sit above stacked Employment, Notes, 1-on-1 meetings, Tasks cards rather than separate pages. Assertion 3 (tab labels) is confirmed visually. No contradictions found, but the text also contains interpretive claims about eye-tracking and muscle-memory cost that are not directly verifiable, so overall abstain is appropriate for the mixed factual+interpretive content.
- [x1] Two assertions are visually contradicted: onboarding progress is not shown as a ring around the avatar — a circular ring around 'J Jane' is visible, but the progress is conveyed by text '2 active' and percentage bars next to each avatar, not a ring overlay tied to the avatar. The empty anniversaries card does show a small icon and 'No upcoming anniversaries' text, but no faint illustration is clearly visible. The surface, rounded card borders, and absence of crisp dividers are plausible. Other claims about user behavior are not directly visible.
- [x1] The 'People' tab in the top nav does appear to have a pill-shaped highlight background, the 'Admin' role pill sits directly under the name in the same left column, and the three document sections are stacked with the labels 'General', 'Internal', and 'Signed documents' visible. However, the critique does not make strong factual claims that the screenshot positively contradicts — the abstract reasoning about muscle memory, saccades, and mental models is not checkable visually. Several descriptive claims (pill behind 'People', role under name, stacked buckets with visibility label) appear to match the image, but the overall verdict cannot be 'confirmed' because the text is predominantly interpretive/argumentative rather than factual. Abstaining is appropriate.
- [x1] The filled blue 'Update' vs borderless 'Cancel' asymmetry is visible (Update is a filled blue pill on the right; Cancel is plain text on the left). The toggle + star-rating combo on each skill row is visible for rows like Motion Design, UI Design, and UX Research. The top nav being text-only horizontal with one highlighted 'People' tab is visible. However, the claim about the active tab using a 'pastel pill background instead of an underline' cannot be confirmed — the visible top nav appears to use simple text with a highlighted color on 'People', but I cannot confirm it is a pastel pill shape distinct from the rest of the nav styling. Since not all assertions can be positively confirmed and none are contradicted, I abstain.
- [x1] The screenshot shows 'Active', 'My reports', 'Archived', and 'Manager' in the secondary sidebar under the 'People' header. There is NO 'Private segments' group visible. The filter chip shown reads 'Archive date' (not 'Archive date is set') and I cannot clearly confirm an '×' removal affordance at this resolution. No numeric badges are visible beside 'Active' or 'Archived' in the sidebar — they appear without count numbers. The assertions about 'Private segments' nesting and numeric badges are contradicted; the chip wording is contradicted.
- [x1] The modal-over-calendar, the orange-cross Reject / green-check Approve pill pair, the Sick chip with decorative icons around an avatar, the two-column key/value body with emphasized values, and the specific values 4.0 days, December 16–19, and Sam Lee are all visible in the screenshot. However, the modal sits in front of a darkened/dimmed background — the calendar behind is heavily de-emphasized rather than 'still-visible' as a spatial cue, and the 'Sick' chip is styled as a beige banner with leaf illustrations rather than an emoji-accented chip. Because the critique's framing of 'preserves spatial cue' and 'emoji accents' is partially contradicted by what is visible, a clean confirmation is not warranted; abstaining.
- [x1] The active tab claim is contradicted: the 'GET STARTED' button is a solid black pill at the top right, but there is no visible row of product tabs with three outlined siblings and one solid black active tab in the header. The header contains 'RESEARCH', 'PRODUCTS', 'DEVELOPERS', 'RESOURCES', 'LOG IN', and 'GET STARTED' — these are navigation links, not a product tab group with one solid black pill. The headline 'The world's most realistic & expressive voice AI' is set in a serif typeface — confirmed. The body uses a sans-serif — confirmed. The background is a warm peach gradient — confirmed. The page is not dark mode and not pure white — confirmed. A single white demo card is visible floating in the peach field — confirmed.
- [x1] The screenshot shows a horizontal summary bar with thin dividers and four metrics including 'Total transactions 1,192', a date range, total expenses $1,789,008.02, and total income $26,493.59 — these are confirmed visually. The category column between Merchant/Description and Account is confirmed, with what appear to be icon-plus-label chip cells. Income rows in the visible list (Tesco, Kris+ x Intransit) appear lighter/grayed with '+' prefixes on amounts, and expense rows appear darker without '+' signs — consistent with the description. The 'Transactions' tab shows an underline rather than a fill, and tabs appear as equal-weight siblings. The critique is broadly consistent with the visible UI, but I cannot confirm 'one horizontal segmented bar' as opposed to a row of cards with no visible shadow at this resolution, nor fully confirm exact shade values for the income vs expense contrast.

### whatToSteal (10 abstains, 10 unique reasons)

- [x1] Most claims describe principles rather than specific visible facts, but several embedded factual assertions can be checked: uppercase category headers are confirmed, START as filled pill is confirmed, nested card confirmed, back arrow top-left confirmed, right-aligned account cluster confirmed. However, I cannot verify 'tracked-out' letter-spacing precisely enough to confirm, and the claim about 'two card levels' is not directly observable as a structural rule. Mixed certainty leads to abstain.
- [x1] Assertion 1 (soft-tinted pill on active 'People' item) is confirmed: 'People' has a pill background while other items are plain text. Assertion 2 (other items plain text) is confirmed. Assertion 3 (nav item list) is confirmed. Assertion 4 (empty fields shown as muted dashes) is confirmed: dashes are visible after Personal phone number, Manager, Department, Workplace, Employee ID. Assertion 5 (category-colored circular icons left of each card) is confirmed: Employment has a blue circle icon, Notes a yellow circle, 1-on-1 meetings a teal/green circle, Tasks a green circle, each to the left of its card. Assertion 6 (empty states with illustration + one-line reassurance): the Notes card shows 'No notes.' and the 1-on-1 meetings card shows '1-on-1 meetings will appear here.' — these are one-line reassurances but no distinct illustration is clearly visible (only a small icon), so this specific assertion is not fully confirmed.
- [x1] The active 'Home' tab has a pill background but the text does not appear to be in an accent color — it looks dark rather than blue. The ring around the avatar is not clearly a progress overlay; it appears to be an avatar ring decoration. The 'No upcoming anniversaries' text is present, but the faint illustration is not clearly visible. Both portrait and monogram avatars are visible on the profile card. The remaining points are not directly verifiable.
- [x1] The visible factual claims — pill on 'People' in top nav, 'Not visible to employee' label beside the Internal section icon, 'Admin' pill under the name, and three stacked bucket-style sections with those exact labels — all appear consistent with what is shown in the screenshot. However, the text also includes prescriptive guidance ('Use this when…', 'Do not use this when…') that is not checkable against a static image. Because the text mixes verifiable observations with non-verifiable prescriptions, a strict 'confirmed' is not warranted, but no claims are contradicted either.
- [x1] The toggle-plus-star pattern on each skill row is confirmed. The asymmetric buttons (filled blue 'Update' vs plain text 'Cancel') are confirmed. The scrim dimming the parent page behind the modal is confirmed. The skill names Motion Design, UI Design, UX Design, and UX Research are confirmed as visible row labels. All four checkable assertions are positively visible.
- [x1] The top nav active state uses what appears to be a pastel pill (People) with inactive items on white — confirmable. The profile card does stack 'UX Designer' role, an 'Employee' status chip, and a primary action above contact fields — confirmable. Section cards (Onboarding, Employment, Notes, 1-on-1 meetings) each have a circular icon at left that appears tinted in different hues (blue, teal, yellow, blue) — confirmable as multi-hue encoding. The secondary tabs (Profile/Details/Documents/Time-off) show an underline under 'Profile' indicating active state — confirmable. All four core claims are visually supported, so the field can be considered confirmed, but I am abstaining to flag minor ambiguity about exact hue saturation.
- [x1] Confirmed: 'People' header sits above the secondary nav and appears as a non-clickable label; system-defined filters ('Active', 'My reports', 'Archived') are listed in that sidebar; a removable filter pill is present. Contradicted: 'Active' and 'Archived' do NOT show numeric counts in the sidebar — no '2' badge is visible next to them. The chip shown reads 'Archive date' and I cannot positively confirm a trailing '×' glyph at this resolution, so that specific assertion is abstained.
- [x1] The orange cross Reject / green check Approve pair is visible, the Sick illustrated banner is visible, and a blue accent appears on the 'Time-off' tab. The 'calendar faintly visible behind the modal' claim is partially contradicted — the background is clearly dimmed/grayed rather than faintly visible, with the calendar cells appearing washed out. The 'same blue marks selected calendar cell' claim is unclear in the image (the selected cell in the December 2025 row is not clearly blue in the visible region). Overall accuracy is mixed, so abstaining.
- [x1] The form layout, heading tone, and expanded referral list are visible. The number of options is approximately correct (eleven visible including 'Other'). Hairline borders with no fill are consistent with what is shown, though shadow absence is harder to fully confirm from a flat screenshot.
- [x1] The summary bar, income/expense weight+sign encoding, category column placement, and underline-only active tab are all visible in the screenshot and match the description. However, I cannot positively confirm that chips specifically contain a 'dropdown caret' — dropdown carets are not clearly distinguishable in the screenshot. I also cannot confirm the underline is 'thick' versus standard weight, nor that chip backgrounds are 'neutral' versus tinted, at this resolution.

### layout (10 abstains, 10 unique reasons)

- [x1] Top nav, centered heading/CTA area, and dashboard preview panel are vertically stacked, but a left/right split for the visual panel versus text block is not confirmed; the layout reads more as a centered single column than a three-region split.
- [x1] A top navigation bar (Home, People, etc.) is clearly visible, and the main content area exists, but the claim specifically names only two regions (primary-nav, main-canvas). The screenshot actually shows a more complex layout including a right-side notes rail and grid cards, so the specific two-region claim is not positively confirmed.
- [x1] I can see the content is centered vertically and horizontally in a single column, but I cannot definitively confirm a named region called 'main-canvas' from the screenshot.
- [x1] The screenshot does show what appears to be a modal/dialog ('New employee' form) layered over a dashboard page, but I cannot confirm the exact region taxonomy claimed.
- [x1] There is a primary nav at the top, but the main area shows a card grid that is not strictly a two-column layout (cards vary in width and span), so the exact claim does not match.
- [x1] I can see a modal overlaid on a dimmed page with a left rail and a top nav, but I cannot positively confirm every named region (e.g., primary-nav, detail-rail, main-canvas) as exactly those labels without risking misidentification.
- [x1] There is a left sidebar (navigation), a center main area with profile, and a right 'Policies' panel. However, a 'detail-rail' between nav and main canvas is not clearly distinguishable from the screenshot.
- [x1] The screenshot shows a horizontal top navigation with a single-canvas timeline/gantt area below it. There is no left sidebar detail rail or two-column structure visible. Cannot confirm the named regions.
- [x1] verdict "aborbstain"
- [x1] There is a visible left sidebar nav with icons and text, a chat/input bar at the bottom, and a modal/sheet overlay in the center. However, I cannot confirm the exact 'main-canvas' designation and whether this matches the producer's structural model.

### antiPatterns (8 abstains, 8 unique reasons)

- [x1] Assertion 1 (no six-icon sidebar; readable labels in nav) is confirmed: the top nav contains text labels (Home, People, Time-off, Onboarding, 1-on-1, Documents, Analytics), not a glyph-heavy sidebar. Assertion 2 (left-rail identity column + right-side stacked cards) is confirmed: left rail shows identity/contact info, right side shows stacked cards. Assertion 3 (card list Employment, Notes, 1-on-1 meetings, Tasks) is confirmed. Assertion 4 (avoids single mega-page) is confirmed by the visible segmentation. No contradictions; abstaining because the text mixes verifiable layout facts with interpretive claims (e.g. 'lazy enterprise pattern', 'mental model that profile screens depend on') that cannot be checked from the image.
- [x1] The active 'Home' tab has a pill background but the text color appears dark/black, not blue — this contradicts the claim of blue text. The claim that no KPI row is shown is supported by the absence of a metrics row. The Onboardings and Anniversaries cards are full-width narrative cards. The other claims about accessibility and user behavior are not visually verifiable.
- [x1] Several assertions in the source text describe elements that are not visible in this screenshot. The policies panel on the right shows 'Sick Leave' and 'Vacation' with counts (15 days taken, 0) but no emojis (🤒, 🏖) are visible next to the avatars — they appear as plain colored circular initials. The 'No time-off events' headline is confirmed visible above the heatmap, and the heatmap (year-view with Jan–Sep labeled) is confirmed visible. The single back chevron beside 'Alex Smith' in the top-left is confirmed visible, and there is no separate breadcrumb beside it. However, the emoji-glyph claim and the 'two policies sharing a warm tone' claim cannot be verified from this screenshot (the two policies shown use different hues — yellow/amber and pink/magenta — and carry no emojis). Because the text mixes verifiable and unverifiable claims, I cannot confirm the overall set as fully consistent with the image, but I also cannot positively contradict the emoji claim without higher resolution. Abstaining.
- [x1] Icons appear tinted in different hues (blue, teal, yellow), supporting the non-monochrome claim. The active nav pill appears to be a soft pastel rather than a dark accent — confirmable. Contact fields (Email, Personal email, Personal phone number, Manager, Account manager, Department, Designation) do appear to use label-on-top / value-below stacking — confirmable. No dark toast is visible in the screenshot, so I cannot confirm the lower-right anchor claim — abstaining on that specific assertion.
- [x1] Confirmed: filter state is surfaced as a visible chip above the table rather than hidden in a closed popover. Abstained/contradicted on the others: I cannot verify a 'teal pill background' on 'People' — the header appears as plain bold text, and I do not see a distinct teal background pill; grouping by usage vs. alphabetical is an interpretive claim not directly checkable from pixels. The 'color reinforcement' claim is contradicted by what is visible (a text header, not a teal pill).
- [x1] A modal over the calendar is confirmed, 'Approve' is spelled out (not 'Confirm'), and balance rows are visible in the modal. The 'Sick' element is more of an illustrated banner than a chip with a word label paired with emoji, and there is no clear 'emoji-only' comparison to verify. The antiPatterns text itself is largely descriptive of what the design avoids rather than checkable claims, so abstaining.
- [x1] These are claims about the ABSENCE of certain elements (Publish in nav, form-field treatment of cover). While I can see Publish is in the canvas (not nav) and the cover has only a small chip, confirming the absence of helper text, drag-target outlines, or upload-stamps with full certainty is difficult. The cover area does show a small 'Sam Lee' label in the lower-left, which complicates a strict confirmation of the second claim — that label is not explicitly addressed in the anti-pattern text.
- [x1] The absence of 2x2 shadowed summary cards and the absence of separate income/expense colored chips are both confirmed by the screenshot. However, I cannot positively confirm that only the icon circle carries the hue (versus the chip pill background also being tinted) — at this resolution the chip backgrounds look largely neutral but it's not definitive. I also cannot verify whether exactly 'six different accent hues' are used across icon circles without clearer color sampling.

### patternType (6 abstains, 6 unique reasons)

- [x1] The screenshot depicts a configuration/settings interface for voice notifications (microphone selection, volume input) rather than a dashboard. While dashboards can have many forms, the absence of any visible data widgets, charts, metrics panels, or overview-style content means I cannot positively confirm this is a dashboard, nor can I definitively contradict it given that 'dashboard' is a broad category that could technically encompass many layout types. The visible content leans more toward a settings page pattern.
- [x1] The main canvas contains form-like inputs (Voice name, Tone of Voice selector) but the dominant pattern is a generation/playback page with tabs, which is closer to a tool/editor surface than a pure form pattern.
- [x1] The screenshot shows a voice cloning success modal with input field and a black Done button, but there is insufficient visible geometric or systematic repetition (logos, icons, or repeated UI primitives) to characterize the page's overall design pattern as 'forms' with confidence.
- [x1] The timeline/gantt view could be interpreted as a dashboard, but it is specifically a resource/timeline schedule, not a general dashboard layout.
- [x1] The image shows what appears to be a text-to-podcast form with a single input field and a generate button. It lacks the characteristic panels, charts, or KPI widgets that would clearly identify it as a dashboard layout. However, the form structure with sidebar navigation could be loosely considered dashboard-like. The claim is ambiguous enough that I cannot positively confirm 'dashboard' as the pattern type.
- [x1] The interface displays message/response blocks in a conversational layout with a message input at the bottom, which strongly resembles a chat-interface. However, I cannot positively confirm a definitive classification since the presence of an embedded data chart and report-style headings blurs the line between a pure chat pattern and a conversational assistant/report hybrid, and the producer has not provided independent corroborating evidence.

### antiPatterns.accessibilityRisks (6 abstains, 6 unique reasons)

- [x1] Status dots are visible, but whether each row has an accompanying text label distinguishing event outcome cannot be conclusively determined from the screenshot.
- [x1] The sidebar does have a dark background. However, the text labels appear to be light/white colored which would actually provide good contrast. I cannot definitively confirm a low contrast accessibility risk without measuring the exact contrast ratio.
- [x1] The selected pill ('TEXT-TO-SPEECH') does use a distinct solid fill (not just border/hue), so the precise risk claim cannot be confirmed; the selected state is visually distinguished by fill, weakening the stated concern.
- [x1] The screenshot shows a verification email card containing text, a 'Verify' button, and a 'Resend verification email' link, but no icon-only button (e.g., a close/dismiss glyph) is visible. The claim references an icon button in the auth card, but no such element is positively present, so the claim cannot be confirmed or contradicted from the visible evidence.
- [x1] The circular status indicators (green dots) appear to use color primarily, but I cannot confirm whether they include text labels or symbols that would mitigate the risk. Need closer inspection to verify.
- [x1] Focus state behavior cannot be verified from a static screenshot. I cannot confirm or deny the visibility of focus indicators.

### voice (5 abstains, 5 unique reasons)

- [x1] The screenshot confirms the existence of the heading 'Your Voice Designs', a green-bordered success notification reading 'Success! Your voice has been created..' in the top-right, a 'View All Voices' sub-section label, a dark 'Create or clone a voice' button, and a row of four filter controls (Language, Accent, Gender, Age). A single voice card labelled 'Voice 1' with a purple avatar tile, an 'English' accent tag, and the descriptive text 'Our anchor is a charismatic, middle-aged male podcast host with a smooth, deep voice and a friendly, an...' is also visible. The voice of the surrounding copy (e.g. 'Our anchor is a charismatic, middle-aged male podcast host with a smooth, deep voice and a friendly, an...') reads as descriptive/instructional rather than marketing-hyped or personified. However, no general 'voice guideline' text is shown on screen — the claim describes a tone that is only inferable from the presence of instructional labels. I can confirm the factual UI elements and that the visible copy does not exhibit the listed 'avoid' traits (no 'Personified brand voice' or hype/trend language is visible), but I cannot fully verify a 'voice guideline' since no such guideline text is rendered.
- [x1] The heading 'Select Microphone' and the helper 'Choose the microphone to use for voice verification' are positively confirmed. Absence of exclamation marks and marketing puffery is also confirmable in the visible text. However, the claim about voice 'warm and direct' is a tonal judgment, not a checkable factual assertion, and the explicit avoidance claims ('no exclamation marks', 'no second-person coaching') extend beyond what is fully verifiable from one screenshot. Mixed nature leads to abstain.
- [x1] Most assertions in the voice description are subjective tone judgments (plain, factual, employee-first, absence of emoji, absence of marketing flourish) that cannot be verified from a screenshot alone. The factual claims that CAN be checked: 'Pending time report' is visible in the screenshot — confirmed; 'Sam Lee' as next approver is visible in the 'Next approver · Sam Lee' line — confirmed; 'Profile completion' section is visible in the left sidebar — confirmed; 'We are missing some information about Alex' is visible as the body text under 'Profile completion' — confirmed. The negative claims (no emoji-laden encouragement, no playful exclamation marks, no marketing flourish, no performance-rating jargon) are largely supported by what I can see in the screenshot — there are no emoji used decoratively (only a small folder icon next to 'Profile completion' appears functional/illustrative), no exclamation marks are visible, no marketing-style language appears. However, since the voice description is fundamentally a tone judgment with mixed factual and subjective claims, and the rules require abstaining when uncertain rather than guessing on subjective interpretation, I return abstain with the assertable claims enumerated.
- [x1] 'Pending requests', 'My reports', 'Requested by', and 'Approve' are all visible in the screenshot. Absence of all-caps urgency and legal disclaimers cannot be positively confirmed from a single image, so abstaining on the negative claims while confirming the positive ones.
- [x1] The headlined phrase and opening sentence of the post body are visible and match the voice examples. However, voice is a stylistic property rather than a set of pure factual claims about layout; the description of the voice as 'plain-spoken, instructional, short declarative sentences with light humor' and the 'Avoid' list are interpretive judgments that cannot be strictly verified from the screenshot. The single concrete textual match (the quoted sentences) can be confirmed, but the overall voice classification is not directly checkable.

### mood (3 abstains, 3 unique reasons)

- [x1] The near-white background and teal accents are neutral/professional rather than clearly energetic. Cannot confidently confirm.
- [x1] The mood is somewhat subjective. The purple gradient gives a soft feel, but 'playful' is debatable — the screen looks fairly neutral/functional. Cannot definitively confirm.
- [x1] The palette appears more neutral/cool light with teal accents rather than warm. The mood is data-focused and relatively calm, but 'warm' is questionable.

### components (3 abstains, 3 unique reasons)

- [x1] Sidebar nav, tab nav (Voice Library, My Voices, Voice Design, Voice Cloning), and form controls (textarea, chips, button) are visible. However, a top-nav is not clearly distinguishable from a header strip, and segmented-control and icon-button cannot be positively identified with confidence.
- [x1] A 'modal-dialog' is visible (the overlay card). However, no 'icon-button' is clearly visible in the screenshot — only a text-labeled 'OK' button and a 'Resend verification email' link.
- [x1] A bar chart is visible, a left sidebar nav is visible, form controls/textarea and buttons are visible in the modal. However, I do not clearly see a distinct 'search-command' component — there is a 'New chat' button and an 'AI Financial Profile' chat input but no obvious command-palette/search overlay.

### domainTags (1 abstains, 1 unique reasons)

- [x1] Audit-log is clearly visible. Profile-account and team-management context (e.g., member management UI) cannot be confirmed from this single table screenshot.
