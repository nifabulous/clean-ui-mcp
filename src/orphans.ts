/**
 * orphans.ts — the single, shared orphan-inventory function.
 *
 * Two callers used to each roll their own "which private image files are safe
 * to delete?" logic, and both had data-loss bugs:
 *   • src/scripts/ui-server.ts `orphanedPrivateImagePaths` treated anything not
 *     referenced by corpus entries as an orphan — so it deleted Decision Lab
 *     screenshots (referenced by corpus/decisions.json) and un-triaged capture
 *     batches (images-private/captures/{batchId}/…).
 *   • src/scripts/clean-orphans.ts `orphanInventory` protected decisions but
 *     still deleted capture batches and images referenced only by
 *     corpus/entries-draft.json (staged-but-uncommitted imports).
 *
 * This module is the one place that decision lives. It is PURE — no disk I/O —
 * so tests inject fixtures directly and the two callers inject whatever raw
 * strings they read off disk.
 *
 * Fail-closed rules (when in doubt, keep the file):
 *   1. images-private/captures/** is NEVER deletable. Capture batches are
 *      pending triage; only the explicit /api/capture-cleanup flow may remove
 *      them, and only once nothing in the batch is still pending.
 *   2. images-private/decisions/** is deletable ONLY when decisionsRaw parsed
 *      successfully AND it does not reference the file. If decisionsRaw was
 *      supplied but unparseable, protect the entire decisions/ subtree — we
 *      can't tell which files it points at, so we delete none of them.
 *   3. entries-draft.json references are protected the same way: if draftRaw
 *      was supplied but unparseable, fail-closed (delete nothing). Draft
 *      entries can point anywhere, so there's no safe subtree to fall back to.
 */
import { Decisions, type CorpusEntryT } from "./schema.js";

export interface SafeOrphanResult {
  orphans: string[];
  /** How many on-disk files each protection layer held back. Informational,
   *  surfaced by GET /api/orphans so the UI can show "N files protected". */
  protectedCounts: {
    entries: number;
    decisions: number;
    draft: number;
    captures: number;
  };
}

/** Prefix for the always-protected capture-batch subtree. */
const CAPTURES_PREFIX = "images-private/captures/";
/** Prefix for the Decision Lab screenshot subtree. */
const DECISIONS_PREFIX = "images-private/decisions/";

interface ParsedDecisions {
  ok: boolean;
  refs: Set<string>;
}

/** Parse decisions.json leniently. Returns the referenced image set plus a flag
 *  for whether parsing succeeded — the caller fails closed on the decisions/
 *  subtree when it was supplied but didn't parse. */
function parseDecisionRefs(raw: string | null | undefined): ParsedDecisions {
  if (!raw) return { ok: false, refs: new Set() };
  try {
    const parsed = Decisions.safeParse(JSON.parse(raw));
    if (!parsed.success) return { ok: false, refs: new Set() };
    const refs = new Set<string>();
    for (const d of parsed.data.decisions) {
      for (const dir of d.directions) {
        for (const screen of dir.screens) {
          const ref = screen.imageRef;
          if (ref && ref.startsWith("images-private/")) refs.add(ref);
        }
      }
    }
    return { ok: true, refs };
  } catch {
    return { ok: false, refs: new Set() };
  }
}

interface ParsedDraft {
  ok: boolean;
  refs: Set<string>;
}

/** Parse entries-draft.json leniently. Shape (per commit-draft.ts/bulk-import):
 *  { version: 1, exportedAt, entries: [{ image?: { path?: string } }] }. */
function parseDraftRefs(raw: string | null | undefined): ParsedDraft {
  if (!raw) return { ok: false, refs: new Set() };
  try {
    const obj = JSON.parse(raw) as { entries?: Array<{ image?: { path?: string } }> };
    const refs = new Set<string>();
    const list = Array.isArray(obj.entries) ? obj.entries : [];
    for (const e of list) {
      const p = e?.image?.path;
      if (typeof p === "string" && p.startsWith("images-private/")) refs.add(p);
    }
    return { ok: true, refs };
  } catch {
    return { ok: false, refs: new Set() };
  }
}

/**
 * Compute the set of private image files that are safe to delete.
 *
 * Pure: callers pass the raw decision/draft JSON strings they read off disk and
 * the recursive file listing (listImageFilesRecursive). Returns the deletable
 * orphans plus a breakdown of how many on-disk files each protection layer
 * held back.
 */
export function safeOrphanPaths(opts: {
  entries: CorpusEntryT[];
  privateFiles: string[];
  decisionsRaw?: string | null;
  draftRaw?: string | null;
}): SafeOrphanResult {
  const { entries, privateFiles, decisionsRaw = null, draftRaw = null } = opts;

  // Layer 1: corpus entries. A private image any entry points at is kept.
  const entryRefs = new Set<string>();
  for (const e of entries) {
    const p = e?.image?.path;
    if (p && p.startsWith("images-private/")) entryRefs.add(p);
  }

  // Layer 2: Decision Lab screenshots. decisionsRawSupplied lets us fail-closed
  // over the entire decisions/ subtree when the manifest was given but corrupt.
  const decisionsRawSupplied = decisionsRaw != null && decisionsRaw !== "";
  const decisions = parseDecisionRefs(decisionsRaw);

  // Layer 3: staged draft imports.
  const draftRawSupplied = draftRaw != null && draftRaw !== "";
  const draft = parseDraftRefs(draftRaw);

  // Union of every referenced path — anything in this set is kept.
  const referenced = new Set<string>([...entryRefs, ...decisions.refs, ...draft.refs]);

  const orphans: string[] = [];
  let capturesProtected = 0;
  let decisionsProtected = 0;
  let draftProtected = 0;

  for (const f of privateFiles) {
    if (!f.startsWith("images-private/")) continue; // only private files are candidates

    // Rule 1: captures subtree is never deletable.
    if (f.startsWith(CAPTURES_PREFIX)) {
      capturesProtected += 1;
      continue;
    }

    // Rule 2: decisions subtree is deletable ONLY when the manifest parsed AND
    // doesn't reference the file. Fail-closed when corrupt.
    if (f.startsWith(DECISIONS_PREFIX)) {
      if (decisionsRawSupplied && !decisions.ok) {
        // Can't trust the manifest → protect the whole subtree.
        decisionsProtected += 1;
        continue;
      }
      if (referenced.has(f)) {
        // Protected by a decisions.json reference (or coincidentally by an
        // entry/draft ref — attribute to decisions since it owns this subtree).
        decisionsProtected += 1;
        continue;
      }
      orphans.push(f);
      continue;
    }

    // Generic private file (not under captures/ or decisions/).
    if (referenced.has(f)) {
      // Attribute the save to the layer that referenced it, preferring entries
      // over draft so we don't double-count.
      if (entryRefs.has(f)) {
        // counted under entries below; skip here
      } else if (draft.refs.has(f)) {
        draftProtected += 1;
      }
      continue;
    }

    // Rule 3: draft manifest corrupt → fail-closed (delete nothing). A draft
    // can reference any path, so there's no safe subtree to narrow to.
    if (draftRawSupplied && !draft.ok) continue;

    orphans.push(f);
  }

  // entries layer count: on-disk files referenced by an entry.
  let entriesProtected = 0;
  for (const f of privateFiles) {
    if (f.startsWith("images-private/") && entryRefs.has(f)) entriesProtected += 1;
  }

  return {
    orphans: orphans.sort(),
    protectedCounts: {
      entries: entriesProtected,
      decisions: decisionsProtected,
      draft: draftProtected,
      captures: capturesProtected,
    },
  };
}
