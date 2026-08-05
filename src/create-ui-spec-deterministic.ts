import type { SanitizedEvidence } from "./create-ui-spec-contracts.js";
import type { CreateUiSpecRequest } from "./create-ui-spec-contracts.js";
import type { CorpusEntryT } from "./schema.js";
import { buildDeniedNames, screenProse } from "./corpus-prose-screen.js";
import { isVerified, trustedEvidenceIdsOf } from "./corpus-trust.js";

export interface DeterministicColorTokens {
  primary: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
}

export interface DeterministicLayoutRegion {
  name: string;
  type: string;
  components: readonly string[];
  responsive: readonly string[];
}

export interface DeterministicSynthesis {
  /** null → keep the recipe's brief echo (no corpus match). */
  designDirection: string | null;
  /** null → tokens stay unavailable; {@link colorTokensRefusal} says why. */
  colorTokens: DeterministicColorTokens | null;
  /**
   * WHY `colorTokens` is null, so the served `unavailableDecisions` reason can
   * state the real cause instead of guessing. THREE causes are reachable and none
   * is interchangeable with another:
   *   - `untrusted` — entries were matched and every one was refused by the trust
   *     gate. This is the DEFAULT production state (0 of 787 entries carry a
   *     verification record), so it is the most common cause by far.
   *   - `insufficient-contributors` — fewer than three entries contributed roles.
   *   - `no-plurality` — three or more contributed and did not agree.
   * Reporting "fewer than three" for either of the others tells a caller that
   * retrieval was thin and invites a re-query that cannot help.
   * null when tokens are served.
   */
  colorTokensRefusal: "untrusted" | "insufficient-contributors" | "no-plurality" | null;
  layoutRegions: readonly DeterministicLayoutRegion[];
  responsiveBehavior: readonly string[];
  /** Corpus whatToSteal rows, screened, capped at 5, cited via sourceIds. */
  techniques: readonly { readonly text: string; readonly sourceIds: readonly string[] }[];
  /** Corpus antiPatterns rows, screened, capped at 5, cited via sourceIds. */
  antiPatterns: readonly { readonly text: string; readonly sourceIds: readonly string[] }[];
  /**
   * One composed voice string ({tone}. Avoid: …. Examples: ….), each segment
   * omitted when its source is absent. null when no entry carries usable voice.
   */
  contentVoiceGuidance: string | null;
  /** Evidence ids of the entries whose voice content contributed. */
  contentVoiceEvidenceIds: readonly string[];
  /** Corpus accessibility-risk rows (screened prose), all present. */
  accessibilityConstraints: readonly string[];
  /** Evidence ids of the entries whose accessibility rows survived the screen. */
  accessibilityEvidenceIds: readonly string[];
  /** Corpus component tokens (closed vocabulary, no screen needed). */
  componentInventory: readonly { readonly name: string; readonly pattern: string }[];
  /** Evidence ids of the entries whose components contributed. */
  componentInventoryEvidenceIds: readonly string[];
  /** Evidence ids of the entries whose responsiveBehavior contributed. */
  responsiveBehaviorEvidenceIds: readonly string[];
  /** Evidence ids of the entries whose colorRoles plurality produced colorTokens. */
  colorRoleEvidenceIds: readonly string[];
  /** Evidence ids of the entries whose clauses produced designDirection. */
  designDirectionEvidenceIds: readonly string[];
}

/**
 * Direction size guard (PR review round 2). Serving every matched entry's
 * critique and type notes verbatim produced a 3,783-char mean / 5,642-char max
 * direction on production-shaped 5-entry windows — 96.8% over 2,000 chars,
 * against a 358-char baseline. A field that is populated but unreadable is the
 * presence-not-usability failure CLAUDE.md forbids, so the corpus-signal
 * section carries a character budget and per-signal count caps.
 *
 * The budget covers the SIGNAL SECTION ONLY. The caller's own brief (up to
 * 8,000 chars) and the fixed template are not corpus growth and are not
 * bounded here; bounding them would silently rewrite the caller's own words.
 */
const MAX_DIRECTION_SIGNAL_CHARS = 1_200;
/** Corpus mood is a short phrase (p50 24 chars); three is a signal, ten is a list. */
const MAX_DIRECTION_MOODS = 3;
/** typePairing.notes p50 is 319 chars — one carries the reasoning, five repeat it. */
const MAX_DIRECTION_TYPE_NOTES = 1;
/** critique p50 is 947 chars, so five would be ~4,700 on their own. */
const MAX_DIRECTION_CRITIQUES = 1;
/** The separator between signal clauses, counted against the budget. */
const SIGNAL_JOIN = "; ";
/**
 * The separator INSIDE a multi-value prose clause. It must differ from
 * {@link SIGNAL_JOIN}, or a reader cannot tell where the mood list ends and the
 * next signal begins — corpus moods contain commas ("warm, calm, data-focused")
 * so a comma cannot serve either.
 */
const VALUE_JOIN = " / ";

/**
 * Drop the trailing sentence punctuation so the composed clause list does not
 * read "…without mixing typefaces.. Let those signals lead". The whole trailing
 * run goes, not one character: corpus prose that trails off ("…trails off...")
 * would otherwise still collide with the appended period.
 *
 * This is punctuation normalization at a join, not redaction: no word is
 * removed, and the segment was already identity-screened whole.
 */
function withoutTrailingPeriod(value: string): string {
  return value.replace(/[.…]+$/, "");
}

const MAX_TECHNIQUES = 5;
const MAX_ANTI_PATTERNS = 5;
const MAX_VOICE_EXAMPLES = 3;
const MIN_VOICE_EXAMPLE_LENGTH = 20;
const MAX_VOICE_EXAMPLE_LENGTH = 140;
/** Screenshot data ("52,420") is not copy; the identity screen cannot see it. */
const DATA_ONLY_VOICE_EXAMPLE = /^[\d\s.,%$£€+-]+$/;

/**
 * `plurality` with no tie-breaking: undefined unless ONE value strictly beats
 * every other. `design-prompt.ts:51` keeps the first-inserted value on a tie,
 * which turns retrieval order into a consensus claim.
 */
function strictPlurality<T>(values: readonly T[]): T | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<string, { value: T; count: number }>();
  // Every vote that reaches this today is a STRING (`typePairing` is the derived
  // `"${display} + ${body}"` string, `create-ui-spec-contracts.ts:313`), so the
  // keying below is equivalent to the raw-value Map `plurality` used. It is
  // written generically so a future non-string vote compares by value rather than
  // by reference. Caveat if that day comes: `JSON.stringify` is not value
  // equality — `{a,b}` and `{b,a}` key differently, and `0` collides with `"0"` —
  // so a structural key would be needed rather than this one.
  for (const v of values) {
    const key = typeof v === "string" ? v : JSON.stringify(v);
    const hit = counts.get(key);
    if (hit) hit.count += 1;
    else counts.set(key, { value: v, count: 1 });
  }
  let best: T | undefined;
  let bestCount = 0;
  let tied = false;
  for (const { value, count } of counts.values()) {
    if (count > bestCount) { best = value; bestCount = count; tied = false; }
    else if (count === bestCount) { tied = true; }
  }
  return tied ? undefined : best;
}

function majority(values: readonly boolean[]): boolean | undefined {
  const yes = values.filter(Boolean).length;
  const no = values.length - yes;
  if (yes === no) return undefined;
  return yes > no;
}

/**
 * Pure, deterministic body synthesis from matched corpus observations.
 * Structured signals (direction, tokens, layout) read closed structuredFacts
 * tokens from the sanitized rows; the six prose fields (C3 Phase 1, Task 4)
 * read RAW matched entries through `matchedEntries` — the INTERNAL channel
 * that never reaches a transport projection — and every prose string passes
 * the identity screen (drop whole, never redact) before it is emitted. Cited
 * evidence ids are the response-scoped ids already in the sanitized rows.
 */
export function createUiSpecDeterministic(
  evidence: readonly SanitizedEvidence[],
  allMatchedEntries: readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[],
  corpusEntries: readonly CorpusEntryT[],
  request: CreateUiSpecRequest,
): DeterministicSynthesis {
  // ----- C3 trust gate (Stage 2a): per-field selectors behind the same shadow -----
  // Stage 1 shadowed `allMatchedEntries` behind ONE trusted list. Stage 2a
  // corrects that shape: verification attaches to the FIELD, not the entry, and
  // the body has no single trusted list. The ungated parameter is reachable
  // ONLY through the two accessors below — `verifiedFor(field)` (the matched
  // entries verified for exactly that field) and `anyMatchedEntries` (the
  // matched/refused distinction the colorTokensRefusal reason needs). Every
  // selector below therefore names the claim it reads, and no selector can
  // silently reach the ungated list. Each selector is the only place that
  // knows which field it reads.
  //
  // `corpusEntries` is deliberately NOT gated. It feeds `buildDeniedNames` for
  // the identity screen, which must stay corpus-wide; narrowing it would shrink
  // the denied-name set and weaken identity screening.
  // A prose claim serves only when its response-scoped row survived the strip:
  // the row is the citation anchor, and `techniques[].sourceIds` must be
  // members of `spec.provenance.evidenceIds` (`refineEnvelope`). A claim
  // without a row cannot be attributed, so it is withheld fail-closed.
  const servedRowIds = new Set(evidence.map((e) => e.id));
  const anyMatchedEntries = allMatchedEntries.length > 0;
  const verifiedFor = (field: string): readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[] =>
    allMatchedEntries.filter((m) => isVerified(m.entry, field) && servedRowIds.has(m.evidenceId));
  // `colorTokens`, `layoutRegions` and the direction's structured clauses derive
  // from SanitizedEvidence rows, which do not carry their entry. Bridge the same
  // per-field filter through the evidence id so plurality votes run over trusted
  // observations only. The bridge reads the gated view (`verifiedFor`), never
  // the ungated parameter directly.
  const observationsFor = (field: string): readonly SanitizedEvidence[] => {
    const trustedIds = trustedEvidenceIdsOf(verifiedFor(field), field);
    return evidence.filter(
      (e) => e.kind === "corpus-observation" && e.structuredFacts && trustedIds.has(e.id),
    );
  };

  // Color-token plurality over the CORPUS role shape (canvas/surface/ink/
  // muted/accent, muted nullable — src/schema.ts:420-426), then mapped into
  // UiSpec ColorTokens with the same defaults the existing design-prompt.ts
  // merge uses. The three-contributor guard counts entries verified FOR
  // `visual.colorRoles` — counting entries verified for anything would derive a
  // palette from entries whose colour was never checked (the over-claim this
  // program exists to stop).
  const colorRoleObservations = observationsFor("visual.colorRoles");
  const colorRoleEvidenceIds = colorRoleObservations.map((o) => o.id);
  const withRoles = colorRoleObservations
    .map((o) => o.structuredFacts)
    .filter((f) => f.colorRoles && f.colorRoles.muted !== null);
  const roleVotes = withRoles.length >= 3
    ? {
        accent: strictPlurality(withRoles.map((f) => f.colorRoles!.accent)),
        surface: strictPlurality(withRoles.map((f) => f.colorRoles!.surface)),
        ink: strictPlurality(withRoles.map((f) => f.colorRoles!.ink)),
        muted: strictPlurality(
          withRoles.map((f) => f.colorRoles!.muted).filter((v): v is string => v !== null),
        ),
      }
    : null;
  const colorTokens =
    roleVotes && roleVotes.accent && roleVotes.surface && roleVotes.ink && roleVotes.muted
      ? {
          primary: roleVotes.accent,
          surface: roleVotes.surface,
          ink: roleVotes.ink,
          muted: roleVotes.muted,
          accent: roleVotes.accent,
        }
      : null;
  const colorTokensRefusal: DeterministicSynthesis["colorTokensRefusal"] =
    colorTokens !== null ? null
      : roleVotes === null
        ? (colorRoleObservations.length === 0
            ? (anyMatchedEntries ? "untrusted" : "insufficient-contributors")
            : "insufficient-contributors")
        : "no-plurality";

  // Layout regions from the wireframe roles (closed enum), deduped in order.
  // `layoutRegions` and the responsive-behavior `form` clause both read the
  // `layout` claim, so both gate on the same key.
  const layoutObservations = observationsFor("layout");
  const seen = new Set<string>();
  const layoutRegions: DeterministicLayoutRegion[] = [];
  for (const f of layoutObservations.map((o) => o.structuredFacts)) {
    for (const role of f.layoutRoles ?? []) {
      if (seen.has(role)) continue;
      seen.add(role);
      layoutRegions.push({ name: role, type: role, components: [], responsive: [] });
    }
  }
  const layoutForms = layoutObservations
    .map((o) => o.structuredFacts.layoutForm)
    .filter((v): v is NonNullable<typeof v> => Boolean(v));
  const layoutForm = strictPlurality(layoutForms);
  const responsivePairs = verifiedFor("responsiveBehavior");
  const responsiveModes = [...new Set(
    responsivePairs
      .map((m) => m.entry.responsiveBehavior)
      .filter((v): v is NonNullable<typeof v> => typeof v === "string"),
  )];
  const responsiveBehaviorEvidenceIds: string[] = [];
  for (const { evidenceId, entry } of responsivePairs) {
    if (typeof entry.responsiveBehavior === "string") responsiveBehaviorEvidenceIds.push(evidenceId);
  }
  // The layout-form clause is derived from every layout-verified observation's
  // structuredFacts, so when it contributes, every layout observation id is
  // cited.
  if (layoutForm) {
    for (const id of layoutObservations.map((o) => o.id)) {
      if (!responsiveBehaviorEvidenceIds.includes(id)) responsiveBehaviorEvidenceIds.push(id);
    }
  }
  const responsiveBehavior = [
    ...responsiveModes.map((mode) => `mode: ${mode}`),
    ...(layoutForm ? [`form: ${layoutForm}`] : []),
  ];

  // Direction: one recipe-voice sentence built from pluralities of the closed
  // facts (structured signals) plus the group-B corpus signals folded in as
  // cited signals (design spec §1B): styleTags, categories, mood, colorScheme,
  // typePairing.notes and critique. The group-B values live only in the RAW
  // matched entries — they are deliberately absent from structuredFacts — so
  // they are read through the per-field matched channel, exactly like the six
  // prose fields below. Each structured clause reads observations verified for
  // ITS OWN key (spacingDensity, cornerStyle, usesShadows, usesBorders,
  // typePairing, layout) — one claim, one selector.
  const densityObs = observationsFor("visual.spacingDensity");
  const cornersObs = observationsFor("visual.cornerStyle");
  const shadowsObs = observationsFor("visual.usesShadows");
  const bordersObs = observationsFor("visual.usesBorders");
  const pairingObs = observationsFor("visual.typePairing");
  const density = strictPlurality(
    densityObs.map((o) => o.structuredFacts.spacingDensity).filter((v): v is NonNullable<typeof v> => Boolean(v)),
  );
  const corners = strictPlurality(
    cornersObs.map((o) => o.structuredFacts.cornerStyle).filter((v): v is NonNullable<typeof v> => Boolean(v)),
  );
  const shadows = majority(
    shadowsObs.filter((o) => typeof o.structuredFacts.usesShadows === "boolean")
      .map((o) => o.structuredFacts.usesShadows as boolean),
  );
  const borders = majority(
    bordersObs.filter((o) => typeof o.structuredFacts.usesBorders === "boolean")
      .map((o) => o.structuredFacts.usesBorders as boolean),
  );
  const pairings = pairingObs
    .map((o) => o.structuredFacts.typePairing)
    .filter((v): v is NonNullable<typeof v> => Boolean(v));
  const pairing = strictPlurality(pairings);
  // Shared identity screen for every corpus-prose string (drop whole, never
  // redact). Built once so the direction's prose segments (including the
  // font-family clause, which can carry a product name) and the six prose
  // fields below use the same denied-name set. The denied set is CORPUS-WIDE
  // (design spec §3), not just the matched entries — a prose row naming a
  // corpus product outside the top matches must still be dropped.
  const deniedNames = buildDeniedNames(corpusEntries);
  const screen = (text: string, entry: CorpusEntryT): string | null =>
    screenProse(text, entry, deniedNames);

  // Every clause tracks the evidence ids of the observations/entries that
  // produced it, so the composed direction cites exactly the references that
  // grounded it — never an entry whose only verified claim did not contribute.
  const clauses: string[] = [];
  const clauseIds: string[] = [];
  const pushClause = (clause: string, ids: readonly string[]): void => {
    if (clause.length > 0) {
      clauses.push(clause);
      clauseIds.push(...ids);
    }
  };
  if (density) pushClause(`${density} spacing`, densityObs.map((o) => o.id));
  if (corners) pushClause(`${corners} corner treatment`, cornersObs.map((o) => o.id));
  if (shadows !== undefined) pushClause(shadows ? "soft shadows" : "no shadows", shadowsObs.map((o) => o.id));
  if (borders !== undefined) pushClause(borders ? "hairline borders" : "no borders", bordersObs.map((o) => o.id));
  if (layoutForm) pushClause(`a ${layoutForm} layout`, layoutObservations.map((o) => o.id));
  // The font-family clause is the ONE closed-token clause that can carry a
  // product name (the "Alan" product's font is "Alan Sans" — review finding
  // #2/#4). The pairing clause is therefore screened like prose: if it names a
  // product it is DROPPED as a clause, while the direction survives.
  const pairingClause = pairing ? `${pairing} typography` : null;
  let pairingDropped = false;
  if (pairingClause !== null) {
    for (const { entry } of verifiedFor("visual.typePairing")) {
      if (screenProse(pairingClause, entry, deniedNames) === null) {
        pairingDropped = true;
        break;
      }
    }
  }
  if (pairing && !pairingDropped) pushClause(`${pairing} typography`, pairingObs.map((o) => o.id));

  // Group-B signals (design spec §1B), distinct in rank order. Closed-token
  // signals (styleTags, categories, colorScheme, the structuredFacts clauses
  // and the typePairing font) carry no identity and are NOT screened (design
  // spec §2b). The PROSE signals (mood, typePairing.notes, critique) are
  // screened per source entry BEFORE composing. Each signal reads entries
  // verified for its own key.
  const styleTagPairs = verifiedFor("styleTags");
  const categoryPairs = verifiedFor("categories");
  const schemePairs = verifiedFor("colorScheme");
  const moodPairs = verifiedFor("mood");
  const typePairingPairs = verifiedFor("visual.typePairing");
  const critiquePairs = verifiedFor("critique");
  const styleTags = [...new Set(styleTagPairs.flatMap((m) => m.entry.styleTags ?? []))];
  const categories = [...new Set(categoryPairs.flatMap((m) => m.entry.categories ?? []))];
  const schemes = [...new Set(
    schemePairs.map((m) => m.entry.colorScheme).filter((v): v is NonNullable<typeof v> => typeof v === "string"),
  )];
  const moods = [...new Set(
    moodPairs
      .map((m) => (typeof m.entry.mood === "string" ? screen(m.entry.mood, m.entry) : null))
      .filter((v): v is string => v !== null),
  )].slice(0, MAX_DIRECTION_MOODS);
  const typeNotes = [...new Set(
    typePairingPairs
      .map((m) => {
        const note = m.entry.visual?.typePairing?.notes;
        return typeof note === "string" && note.length > 0 ? screen(note, m.entry) : null;
      })
      .filter((v): v is string => v !== null),
  )].slice(0, MAX_DIRECTION_TYPE_NOTES);
  const critiques = critiquePairs
    .map((m) => (typeof m.entry.critique === "string" ? screen(m.entry.critique, m.entry) : null))
    .filter((v): v is string => v !== null)
    .slice(0, MAX_DIRECTION_CRITIQUES);

  // Signal clauses in PRIORITY order, appended under a character budget. The
  // closed-token signals come first: they are short, dense, and cannot carry
  // identity. Then critique — the corpus's actual design judgment. typePairing
  // notes come LAST because the structural typography clause above already
  // states the pairing.
  const signalClauses: string[] = [];
  let signalChars = 0;
  const pushSignal = (clause: string, ids: readonly string[]): void => {
    const cost = clause.length + (signalClauses.length > 0 ? SIGNAL_JOIN.length : 0);
    if (signalChars + cost > MAX_DIRECTION_SIGNAL_CHARS) return;
    signalClauses.push(clause);
    clauseIds.push(...ids);
    signalChars += cost;
  };
  if (styleTags.length > 0) pushSignal(`style tags: ${styleTags.join(", ")}`, styleTagPairs.map((m) => m.evidenceId));
  if (categories.length > 0) pushSignal(`categories: ${categories.join(", ")}`, categoryPairs.map((m) => m.evidenceId));
  if (schemes.length > 0) {
    pushSignal(
      schemes.length === 1 ? `a ${schemes[0]} color scheme` : `${schemes.join(" and ")} color schemes`,
      schemePairs.map((m) => m.evidenceId),
    );
  }
  if (moods.length > 0) pushSignal(`mood: ${moods.map(withoutTrailingPeriod).join(VALUE_JOIN)}`, moodPairs.map((m) => m.evidenceId));
  if (critiques.length > 0) pushSignal(`critique: ${withoutTrailingPeriod(critiques.join(" "))}`, critiquePairs.map((m) => m.evidenceId));
  if (typeNotes.length > 0) pushSignal(`type notes: ${withoutTrailingPeriod(typeNotes.join(" "))}`, typePairingPairs.map((m) => m.evidenceId));

  // Template fix (plan Task 5 Step 2): the brief must never be spliced
  // mid-sentence. It now stands as a quoted noun phrase, so ANY brief — single
  // or multi-sentence — leaves the rest of the sentence grammatically intact.
  const designDirectionEvidenceIds = [...new Set(clauseIds)];
  const composedDirection = clauses.length > 0 || signalClauses.length > 0
    ? `For the brief "${request.productContext}", the matched corpus references (${designDirectionEvidenceIds.join(", ")})`
      + (clauses.length > 0 ? ` point to ${clauses.join(", ")}` : "")
      + ". "
      + (signalClauses.length > 0 ? `The shared signals include ${signalClauses.join(SIGNAL_JOIN)}. ` : "")
      + `Let those signals lead the layout before adding anything not evidenced by the matched examples.`
    : null;
  const designDirection: string | null = composedDirection;

  // ----- C3 Phase 1 prose selection (Task 4): six existing UiSpec fields. -----
  // Everything that carries corpus prose goes through the identity screen
  // (drop whole, never redact); closed-token fields (components,
  // responsiveBehavior) do not, per design spec §2b.

  // techniques ← whatToSteal, capped at 5 response-wide, rank order.
  const techniques: { text: string; sourceIds: string[] }[] = [];
  for (const { evidenceId, entry } of verifiedFor("whatToSteal")) {
    for (const raw of entry.whatToSteal ?? []) {
      const text = screen(raw, entry);
      if (text === null) continue;
      techniques.push({ text, sourceIds: [evidenceId] });
      if (techniques.length >= MAX_TECHNIQUES) break;
    }
    if (techniques.length >= MAX_TECHNIQUES) break;
  }

  // antiPatterns ← antiPatterns.antiPatterns, capped at 5 response-wide.
  const antiPatterns: { text: string; sourceIds: string[] }[] = [];
  for (const { evidenceId, entry } of verifiedFor("antiPatterns")) {
    for (const raw of entry.antiPatterns?.antiPatterns ?? []) {
      const text = screen(raw, entry);
      if (text === null) continue;
      antiPatterns.push({ text, sourceIds: [evidenceId] });
      if (antiPatterns.length >= MAX_ANTI_PATTERNS) break;
    }
    if (antiPatterns.length >= MAX_ANTI_PATTERNS) break;
  }

  // contentVoiceGuidance ← voice.tone + voice.avoid + voice.examples. ONE
  // composed string; each segment omitted entirely when its source is absent.
  let tone: string | undefined;
  const avoid: string[] = [];
  const examples: string[] = [];
  const voiceEvidenceIds: string[] = [];
  for (const { evidenceId, entry } of verifiedFor("voice")) {
    const voice = entry.voice;
    if (!voice) continue;
    let contributed = false;
    if (typeof voice.tone === "string" && voice.tone.length > 0) {
      const screenedTone = screen(voice.tone, entry);
      if (tone === undefined && screenedTone !== null) {
        tone = screenedTone;
        contributed = true;
      }
    }
    for (const raw of voice.avoid ?? []) {
      const text = screen(raw, entry);
      if (text !== null) {
        avoid.push(text);
        contributed = true;
      }
    }
    for (const raw of voice.examples ?? []) {
      if (examples.length >= MAX_VOICE_EXAMPLES) break;
      if (raw.length < MIN_VOICE_EXAMPLE_LENGTH || raw.length > MAX_VOICE_EXAMPLE_LENGTH) continue;
      if (DATA_ONLY_VOICE_EXAMPLE.test(raw)) continue;
      const text = screen(raw, entry);
      if (text === null) continue;
      examples.push(text);
      contributed = true;
    }
    if (contributed) voiceEvidenceIds.push(evidenceId);
  }
  const voiceSegments: string[] = [];
  if (tone !== undefined) voiceSegments.push(`${tone}.`);
  if (avoid.length > 0) voiceSegments.push(`Avoid: ${avoid.join("; ")}.`);
  if (examples.length > 0) voiceSegments.push(`Examples: ${examples.join(" · ")}.`);
  const contentVoiceGuidance = voiceSegments.length > 0 ? voiceSegments.join(" ") : null;

  // accessibilityConstraints ← accessibilityRisks (the risk statement is the
  // constraint; screened prose, all present, response-wide).
  const accessibilityConstraints: string[] = [];
  const accessibilityEvidenceIds: string[] = [];
  for (const { evidenceId, entry } of verifiedFor("antiPatterns.accessibilityRisks")) {
    for (const risk of entry.antiPatterns?.accessibilityRisks ?? []) {
      const text = screen(risk.risk, entry);
      if (text !== null) {
        accessibilityConstraints.push(text);
        if (!accessibilityEvidenceIds.includes(evidenceId)) accessibilityEvidenceIds.push(evidenceId);
      }
    }
  }

  // componentInventory ← components (closed enum tokens; deduped in order).
  const seenComponents = new Set<string>();
  const componentInventory: { name: string; pattern: string }[] = [];
  const componentInventoryEvidenceIds: string[] = [];
  for (const { evidenceId, entry } of verifiedFor("components")) {
    let contributed = false;
    for (const component of entry.components ?? []) {
      if (seenComponents.has(component)) continue;
      seenComponents.add(component);
      componentInventory.push({ name: component, pattern: component });
      contributed = true;
    }
    if (contributed) componentInventoryEvidenceIds.push(evidenceId);
  }

  return {
    designDirection,
    colorTokens,
    colorTokensRefusal,
    layoutRegions,
    responsiveBehavior,
    techniques,
    antiPatterns,
    contentVoiceGuidance,
    contentVoiceEvidenceIds: voiceEvidenceIds,
    accessibilityConstraints,
    accessibilityEvidenceIds,
    componentInventory,
    componentInventoryEvidenceIds,
    responsiveBehaviorEvidenceIds,
    colorRoleEvidenceIds,
    designDirectionEvidenceIds,
  };
}
