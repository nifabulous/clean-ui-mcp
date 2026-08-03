import type { SanitizedEvidence } from "./create-ui-spec-contracts.js";
import type { CreateUiSpecRequest } from "./create-ui-spec-contracts.js";
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
}

function majority(values: readonly boolean[]): boolean | undefined {
  const yes = values.filter(Boolean).length;
  const no = values.length - yes;
  if (yes === no) return undefined;
  return yes > no;
}

/**
 * Pure, deterministic body synthesis from matched corpus observations.
 * Reads ONLY closed structuredFacts tokens — never critique/whatToSteal/voice
 * prose (C3 served-content posture). Cited evidence ids are the response-
 * scoped ids already in the sanitized rows.
 */
export function createUiSpecDeterministic(
  evidence: readonly SanitizedEvidence[],
  request: CreateUiSpecRequest,
): DeterministicSynthesis {
  const observations = evidence.filter((e) => e.kind === "corpus-observation" && e.structuredFacts);
  if (observations.length === 0) {
    return { designDirection: null, colorTokens: null, layoutRegions: [], responsiveBehavior: [] };
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
  const responsiveBehavior = layoutForm ? [`form: ${layoutForm}`] : [];

  // Direction: one recipe-voice sentence built ONLY from pluralities of the
  // closed facts, citing the evidence ids it draws from.
  const density = plurality(facts.map((f) => f.spacingDensity).filter((v): v is NonNullable<typeof v> => Boolean(v)));
  const corners = plurality(facts.map((f) => f.cornerStyle).filter((v): v is NonNullable<typeof v> => Boolean(v)));
  const shadows = majority(facts.filter((f) => typeof f.usesShadows === "boolean").map((f) => f.usesShadows as boolean));
  const borders = majority(facts.filter((f) => typeof f.usesBorders === "boolean").map((f) => f.usesBorders as boolean));
  const pairings = facts.map((f) => f.typePairing).filter((v): v is NonNullable<typeof v> => Boolean(v));
  const pairing = plurality(pairings);

  const clauses: string[] = [];
  if (density) clauses.push(`${density} spacing`);
  if (corners) clauses.push(`${corners} corner treatment`);
  if (shadows !== undefined) clauses.push(shadows ? "soft shadows" : "no shadows");
  if (borders !== undefined) clauses.push(borders ? "hairline borders" : "no borders");
  if (layoutForm) clauses.push(`a ${layoutForm} layout`);
  if (pairing) clauses.push(`${pairing} typography`);

  const designDirection = clauses.length > 0
    ? `Ground this ${request.productContext} in the matched corpus references (${ids.join(", ")}): `
      + `the strongest shared signals are ${clauses.join(", ")}. `
      + `Let those signals lead the layout before adding anything not evidenced by the matched examples.`
    : null;

  return { designDirection, colorTokens, layoutRegions, responsiveBehavior };
}
