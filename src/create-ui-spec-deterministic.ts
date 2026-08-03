import type { SanitizedEvidence } from "./create-ui-spec-contracts.js";
import type { CreateUiSpecRequest } from "./create-ui-spec-contracts.js";
import type { CorpusEntryT } from "./schema.js";
import { buildDeniedNames, screenProse } from "./corpus-prose-screen.js";
import { plurality } from "./design-prompt.js";

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
  /** null → tokens stay unavailable (fewer than 3 contributing entries). */
  colorTokens: DeterministicColorTokens | null;
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
 * Drop one trailing sentence period so the composed clause list does not read
 * "…without mixing typefaces.. Let those signals lead". This is punctuation
 * normalization at a join, not redaction: no word is removed, and the segment
 * was already identity-screened whole.
 */
function withoutTrailingPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

const MAX_TECHNIQUES = 5;
const MAX_ANTI_PATTERNS = 5;
const MAX_VOICE_EXAMPLES = 3;
const MIN_VOICE_EXAMPLE_LENGTH = 20;
const MAX_VOICE_EXAMPLE_LENGTH = 140;
/** Screenshot data ("52,420") is not copy; the identity screen cannot see it. */
const DATA_ONLY_VOICE_EXAMPLE = /^[\d\s.,%$£€+-]+$/;

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
  matchedEntries: readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[],
  corpusEntries: readonly CorpusEntryT[],
  request: CreateUiSpecRequest,
): DeterministicSynthesis {
  const observations = evidence.filter((e) => e.kind === "corpus-observation" && e.structuredFacts);
  if (observations.length === 0) {
    return {
      designDirection: null,
      colorTokens: null,
      layoutRegions: [],
      responsiveBehavior: [],
      techniques: [],
      antiPatterns: [],
      contentVoiceGuidance: null,
      contentVoiceEvidenceIds: [],
      accessibilityConstraints: [],
      accessibilityEvidenceIds: [],
      componentInventory: [],
      componentInventoryEvidenceIds: [],
      responsiveBehaviorEvidenceIds: [],
    };
  }

  const ids = observations.map((o) => o.id);
  const facts = observations.map((o) => o.structuredFacts);

  // Color-token plurality over the CORPUS role shape (canvas/surface/ink/
  // muted/accent, muted nullable — src/schema.ts:420-426), then mapped into
  // UiSpec ColorTokens with the same defaults the existing design-prompt.ts
  // merge uses. NEVER run on fewer than 3 contributing entries, and never when
  // zero entries have colorRoles (Math.min over empty arrays is Infinity —
  // that bug would fabricate a default palette).
  // `muted` is the ONLY nullable role in the corpus shape, so it is the one
  // field a plain `f.colorRoles` filter cannot protect: three entries can
  // contribute colorRoles while every `muted` is null, emptying the filtered
  // array and letting a `??` default invent a token nothing derived. Requiring
  // a non-null muted to COUNT toward the >= 3 threshold folds that case back
  // under the same guard — the block goes null with its reason row instead.
  const withRoles = facts.filter((f) => f.colorRoles && f.colorRoles.muted !== null);
  const colorTokens = withRoles.length >= 3
    ? {
        primary: plurality(withRoles.map((f) => f.colorRoles!.accent)) ?? "#3b82f6",
        surface: plurality(withRoles.map((f) => f.colorRoles!.surface)) ?? "#f8f8f8",
        ink: plurality(withRoles.map((f) => f.colorRoles!.ink)) ?? "#111111",
        muted: plurality(withRoles.map((f) => f.colorRoles!.muted).filter((v): v is string => v !== null)) ?? "#888888",
        accent: plurality(withRoles.map((f) => f.colorRoles!.accent)) ?? "#3b82f6",
      }
    : null;

  // Layout regions from the wireframe roles (closed enum), deduped in order.
  const seen = new Set<string>();
  const layoutRegions: DeterministicLayoutRegion[] = [];
  for (const f of facts) {
    for (const role of f.layoutRoles ?? []) {
      if (seen.has(role)) continue;
      seen.add(role);
      layoutRegions.push({ name: role, type: role, components: [], responsive: [] });
    }
  }
  const layoutForms = facts.map((f) => f.layoutForm).filter((v): v is NonNullable<typeof v> => Boolean(v));
  const layoutForm = plurality(layoutForms);
  // Responsive-behavior rows: the corpus's closed responsiveBehavior enum plus
  // the layout-form plurality, both in the existing "label: value" style. The
  // enum is a closed token (design spec §2b) — no identity screen needed.
  const responsiveModes = [...new Set(
    matchedEntries
      .map((m) => m.entry.responsiveBehavior)
      .filter((v): v is NonNullable<typeof v> => typeof v === "string"),
  )];
  const responsiveBehaviorEvidenceIds: string[] = [];
  for (const { evidenceId, entry } of matchedEntries) {
    if (typeof entry.responsiveBehavior === "string") responsiveBehaviorEvidenceIds.push(evidenceId);
  }
  // The layout-form clause is derived from every matched observation's
  // structuredFacts, so when it contributes, every observation id is cited.
  if (layoutForm) {
    for (const id of ids) {
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
  // they are read through the internal matchedEntries channel, exactly like
  // the six prose fields above.
  const density = plurality(facts.map((f) => f.spacingDensity).filter((v): v is NonNullable<typeof v> => Boolean(v)));
  const corners = plurality(facts.map((f) => f.cornerStyle).filter((v): v is NonNullable<typeof v> => Boolean(v)));
  const shadows = majority(facts.filter((f) => typeof f.usesShadows === "boolean").map((f) => f.usesShadows as boolean));
  const borders = majority(facts.filter((f) => typeof f.usesBorders === "boolean").map((f) => f.usesBorders as boolean));
  const pairings = facts.map((f) => f.typePairing).filter((v): v is NonNullable<typeof v> => Boolean(v));
  const pairing = plurality(pairings);
  // Shared identity screen for every corpus-prose string (drop whole, never
  // redact). Built once so the direction's prose segments (including the
  // font-family clause, which can carry a product name) and the six prose
  // fields below use the same denied-name set. The denied set is CORPUS-WIDE
  // (design spec §3), not just the matched entries — a prose row naming a
  // corpus product outside the top matches must still be dropped.
  const deniedNames = buildDeniedNames(corpusEntries);
  const screen = (text: string, entry: CorpusEntryT): string | null =>
    screenProse(text, entry, deniedNames);

  const clauses: string[] = [];
  if (density) clauses.push(`${density} spacing`);
  if (corners) clauses.push(`${corners} corner treatment`);
  if (shadows !== undefined) clauses.push(shadows ? "soft shadows" : "no shadows");
  if (borders !== undefined) clauses.push(borders ? "hairline borders" : "no borders");
  if (layoutForm) clauses.push(`a ${layoutForm} layout`);
  // The font-family clause is the ONE closed-token clause that can carry a
  // product name (the "Alan" product's font is "Alan Sans" — review finding
  // #2/#4). Enum-token clauses (density, corners, shadows, borders, layout
  // form) cannot. The pairing clause is therefore screened like prose: if it
  // names a product it is DROPPED as a clause, while the direction survives.
  const pairingClause = pairing ? `${pairing} typography` : null;
  let pairingDropped = false;
  if (pairingClause !== null) {
    for (const { entry } of matchedEntries) {
      if (screenProse(pairingClause, entry, deniedNames) === null) {
        pairingDropped = true;
        break;
      }
    }
  }
  if (pairing && !pairingDropped) clauses.push(`${pairing} typography`);

  // Group-B signals (design spec §1B), distinct in rank order. Closed-token
  // signals (styleTags, categories, colorScheme, the structuredFacts clauses
  // and the typePairing font) carry no identity and are NOT screened (design
  // spec §2b). The PROSE signals (mood, typePairing.notes, critique) are
  // screened per source entry BEFORE composing: a screened string is dropped
  // whole, never redacted, and only that segment is omitted. A whole-direction
  // screen was tried and measured at 26.1% direction loss on production-shaped
  // 5-entry windows (review finding #2) — e.g. the font clause "Alan Sans
  // typography" trips the own-name check for the "Alan" product — so the
  // direction is composed from screened segments instead.
  const styleTags = [...new Set(matchedEntries.flatMap((m) => m.entry.styleTags ?? []))];
  const categories = [...new Set(matchedEntries.flatMap((m) => m.entry.categories ?? []))];
  const schemes = [...new Set(
    matchedEntries.map((m) => m.entry.colorScheme).filter((v): v is NonNullable<typeof v> => typeof v === "string"),
  )];
  const moods = [...new Set(
    matchedEntries
      .map((m) => (typeof m.entry.mood === "string" ? screen(m.entry.mood, m.entry) : null))
      .filter((v): v is string => v !== null),
  )].slice(0, MAX_DIRECTION_MOODS);
  const typeNotes = [...new Set(
    matchedEntries
      .map((m) => {
        const note = m.entry.visual?.typePairing?.notes;
        return typeof note === "string" && note.length > 0 ? screen(note, m.entry) : null;
      })
      .filter((v): v is string => v !== null),
  )].slice(0, MAX_DIRECTION_TYPE_NOTES);
  const critiques = matchedEntries
    .map((m) => (typeof m.entry.critique === "string" ? screen(m.entry.critique, m.entry) : null))
    .filter((v): v is string => v !== null)
    .slice(0, MAX_DIRECTION_CRITIQUES);

  // Signal clauses in PRIORITY order, appended under a character budget. The
  // closed-token signals come first: they are short, dense, and cannot carry
  // identity. Then critique — the corpus's actual design judgment, and the
  // reason C3 folds group-B signals into the direction at all. typePairing
  // notes come LAST because the structural typography clause above already
  // states the pairing, so the notes are the most redundant thing to lose when
  // the budget binds.
  const signalClauses: string[] = [];
  let signalChars = 0;
  /**
   * Append a clause only if it FITS. An over-budget clause is dropped WHOLE —
   * never truncated — for the same reason the identity screen drops whole: half
   * a sentence of design judgment is worse than none, and a mid-word cut is the
   * "confidently wrong output" the project's output standard forbids.
   */
  const pushSignal = (clause: string): void => {
    const cost = clause.length + (signalClauses.length > 0 ? SIGNAL_JOIN.length : 0);
    if (signalChars + cost > MAX_DIRECTION_SIGNAL_CHARS) return;
    signalClauses.push(clause);
    signalChars += cost;
  };
  if (styleTags.length > 0) pushSignal(`style tags: ${styleTags.join(", ")}`);
  if (categories.length > 0) pushSignal(`categories: ${categories.join(", ")}`);
  if (schemes.length > 0) {
    pushSignal(schemes.length === 1 ? `a ${schemes[0]} color scheme` : `${schemes.join(" and ")} color schemes`);
  }
  if (moods.length > 0) pushSignal(`mood: ${moods.map(withoutTrailingPeriod).join(VALUE_JOIN)}`);
  if (critiques.length > 0) pushSignal(`critique: ${withoutTrailingPeriod(critiques.join(" "))}`);
  if (typeNotes.length > 0) pushSignal(`type notes: ${withoutTrailingPeriod(typeNotes.join(" "))}`);

  // Template fix (plan Task 5 Step 2): the brief must never be spliced
  // mid-sentence ("Ground this A login screen. in the matched corpus
  // references"). It now stands as a quoted noun phrase, so ANY brief — single
  // or multi-sentence — leaves the rest of the sentence grammatically intact.
  const composedDirection = clauses.length > 0 || signalClauses.length > 0
    ? `For the brief "${request.productContext}", the matched corpus references (${ids.join(", ")})`
      + (clauses.length > 0 ? ` point to ${clauses.join(", ")}` : "")
      + ". "
      + (signalClauses.length > 0 ? `The shared signals include ${signalClauses.join(SIGNAL_JOIN)}. ` : "")
      + `Let those signals lead the layout before adding anything not evidenced by the matched examples.`
    : null;

  // Every corpus-prose segment was screened before composing (above); the
  // remaining parts are closed tokens, the template, and the caller's own
  // brief. No whole-string re-screen — see the measurement note above.
  const designDirection: string | null = composedDirection;

  // ----- C3 Phase 1 prose selection (Task 4): six existing UiSpec fields. -----
  // Everything that carries corpus prose goes through the identity screen
  // (drop whole, never redact); closed-token fields (components,
  // responsiveBehavior) do not, per design spec §2b.

  // techniques ← whatToSteal, capped at 5 response-wide, rank order.
  const techniques: { text: string; sourceIds: string[] }[] = [];
  for (const { evidenceId, entry } of matchedEntries) {
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
  for (const { evidenceId, entry } of matchedEntries) {
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
  // Examples are windowed (20-140 chars), reject data-only strings, capped at
  // 3 response-wide, then identity-screened. Tone comes from the first
  // voice-carrying entry in rank order; avoid strings aggregate across entries.
  let tone: string | undefined;
  const avoid: string[] = [];
  const examples: string[] = [];
  const voiceEvidenceIds: string[] = [];
  for (const { evidenceId, entry } of matchedEntries) {
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
  // constraint; screened prose, all present, response-wide). The contributing
  // evidence ids are returned so assembleSpec can attribute the served prose
  // (governing invariant: every served observation is attributed).
  const accessibilityConstraints: string[] = [];
  const accessibilityEvidenceIds: string[] = [];
  for (const { evidenceId, entry } of matchedEntries) {
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
  for (const { evidenceId, entry } of matchedEntries) {
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
  };
}
