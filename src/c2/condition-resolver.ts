/**
 * C2 condition resolver (Task 6, Steps 4–5).
 *
 * Converts a model-visible brief + a control condition into an immutable,
 * content-addressed `C2ConditionInput`. The three control conditions:
 *
 *   - brief-only       — no evidence, no retrieval metadata.
 *   - current-grounded — deterministic query over the brief only, ranked
 *                         retrieval via the injected `CorpusReader.searchRanked`
 *                         pinned to `searchMode: "keyword-only"`, full ranking
 *                         + corpus snapshot preserved privately.
 *   - gold-evidence    — the descriptor's JSON pointers resolved against the
 *                         bound source artifact, exact equality with the
 *                         label's `goldEvidenceIds`, evidence records only for
 *                         the resolved gold IDs.
 *
 * Adversarial properties (spec §5):
 *   - The current-grounded query is derived ONLY from model-visible brief
 *     fields. Reviewer-only label data (gold IDs, rubric anchors, adjudication
 *     notes, required decision IDs, forbidden claims) NEVER enters the query,
 *     the ranking, or the selection. This is structural: `resolveCurrentGrounded`
 *     reads the brief and nothing else.
 *   - Mutating the corpus entries, ranking order, source snapshot bytes, or a
 *     gold-evidence descriptor pointer changes `inputSha256`. Mutating a
 *     reviewer-only gold label does NOT change a current-grounded input.
 *   - The retrieval pin is the literal `searchMode: "keyword-only"` so the run
 *     makes ZERO Voyage requests even when a key + index would otherwise enable
 *     hybrid search. The shipped `searchRanked` enforces this (Task 6 Step 3).
 *   - The corpus hash is captured before and after ranking; a mid-resolution
 *     mutation of `corpus/entries.json` aborts the run.
 *
 * The resolver returns a metadata-safe `C2ConditionInput` plus a private
 * payload string. The metadata is the only thing that may become durable; the
 * private payload (full ranking, corpus snapshot path, evidence content) stays
 * under `.c2-private/`.
 */
import { sha256Hex, canonicalJsonStringify } from "../readiness/contracts.js";
import type { CorpusReader } from "../corpus-reader.js";
import type { SearchResult } from "../corpus.js";
import type {
  C2CaseBrief,
  C2DecisionLabel,
  C2GoldEvidenceDescriptor,
} from "./case-contracts.js";
import type {
  C2ConditionInput,
  C2EvidenceRecord,
} from "./condition-contracts.js";
import type { ArtifactFileRef } from "./primitives.js";
import { writePrivateArtifact } from "./private-artifacts.js";

// ---------------------------------------------------------------------------
// Public request / dependency / return shapes
// ---------------------------------------------------------------------------

/** Discriminated request: the shared refs + the condition-specific fields. */
export interface ResolveConditionInputRequest {
  /** Case package manifest reference (hash-bound). */
  casePackageRef: ArtifactFileRef;
  /** Model-visible brief artifact reference. */
  briefRef: ArtifactFileRef;
  /** The brief itself (already parsed + validated by the caller). */
  brief: C2CaseBrief;
  /** The control condition to resolve. */
  condition: "brief-only" | "current-grounded" | "gold-evidence";

  // Condition-specific optional fields:

  /** Reviewer-only label. Required for gold-evidence; ignored by brief-only and current-grounded. */
  label?: C2DecisionLabel;
  /** Source snapshot reference. Required for migration cases (any condition). */
  sourceSnapshotRef?: C2CaseBrief["sourceSnapshotRef"];
  /** Gold-evidence descriptor (Task 3). Required for gold-evidence. */
  goldEvidenceDescriptor?: C2GoldEvidenceDescriptor;
  /** Hash-bound reference to the descriptor on disk. Required for gold-evidence. */
  goldDescriptorRef?: ArtifactFileRef;
}

/**
 * Injected dependencies. Every side effect is injected so tests can pin the
 * reader, the artifact reader, the private writer, and the clock.
 */
export interface ResolveConditionDeps {
  /** Corpus access — the shipped text-search path. */
  reader: CorpusReader;
  /** Read an artifact's raw bytes by repo-relative path. */
  readArtifact: (path: string) => Buffer;
  /** Write a private artifact (bytes) under the campaign's private dir. */
  writePrivate: (relPath: string, bytes: Buffer) => Promise<void> | void;
  /** Fixed timestamp factory (ISO 8601) for deterministic private-path naming. */
  now: () => string;
}

/** The resolved condition input plus its private half. */
export interface ResolvedConditionInput {
  /** Metadata-safe condition input. Carries hashes + ordering only. */
  metadata: C2ConditionInput;
  /** Private payload string (full ranking, corpus snapshot path, evidence content). */
  privatePayload: string;
}

// ---------------------------------------------------------------------------
// Constants — the pinned retrieval configuration
// ---------------------------------------------------------------------------

/**
 * The literal retrieval pin. C2 current-grounded runs use keyword-only search
 * regardless of the environment's Voyage key or index state. The shipped
 * `searchRanked` honors this via the `searchMode: "keyword-only"` gate added
 * in Task 6 Step 3.
 */
export const C2_RETRIEVAL_MODE = "keyword-only" as const;
/** Rank budget for current-grounded retrieval. Pinned to 10. */
export const C2_RETRIEVAL_LIMIT = 10 as const;
/** The path (relative to the repo root) of the corpus entries file. */
const CORPUS_ENTRIES_PATH = "corpus/entries.json";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function resolveConditionInput(
  request: ResolveConditionInputRequest,
  deps: ResolveConditionDeps,
): Promise<ResolvedConditionInput> {
  switch (request.condition) {
    case "brief-only":
      return resolveBriefOnly(request, deps);
    case "current-grounded":
      return resolveCurrentGrounded(request, deps);
    case "gold-evidence":
      return resolveGoldEvidence(request, deps);
  }
}

// ---------------------------------------------------------------------------
// Brief-only
// ---------------------------------------------------------------------------

async function resolveBriefOnly(
  request: ResolveConditionInputRequest,
  deps: ResolveConditionDeps,
): Promise<ResolvedConditionInput> {
  // No retrieval, no corpus hash, no evidence. The input hash binds only the
  // case package, brief, source snapshot refs, and the literal condition.
  const sourceSnapshotRefs = sourceRefsFor(request);
  const metadata: Extract<C2ConditionInput, { condition: "brief-only" }> = {
    schemaVersion: "1.0",
    artifactType: "c2-condition-input",
    artifactId: `c2-condition-input-${request.brief.caseId}-brief-only`,
    casePackageRef: request.casePackageRef,
    briefRef: request.briefRef,
    sourceSnapshotRefs,
    inputSha256: "PLACEHOLDER", // filled in after canonical serialization below
    condition: "brief-only",
    evidence: [],
    corpusSha256: null,
    retrievalIndexSha256: null,
    retrieval: null,
  };
  metadata.inputSha256 = computeInputSha256(metadata);
  return { metadata, privatePayload: "" };
}

// ---------------------------------------------------------------------------
// Current-grounded
// ---------------------------------------------------------------------------

async function resolveCurrentGrounded(
  request: ResolveConditionInputRequest,
  deps: ResolveConditionDeps,
): Promise<ResolvedConditionInput> {
  const brief = request.brief;

  // 1. Capture the corpus snapshot BEFORE ranking. Copy the exact
  //    `corpus/entries.json` bytes into the private campaign dir and record
  //    their SHA-256. The snapshot is the content-addressed source for every
  //    corpus evidence record produced below.
  const corpusBytes = deps.readArtifact(CORPUS_ENTRIES_PATH);
  const corpusSha256 = sha256Hex(corpusBytes);
  const corpusEntryCount = safeEntryCount(corpusBytes);
  const snapshotRelPath = `corpus-snapshots/${corpusSha256}/entries.json`;
  await deps.writePrivate(snapshotRelPath, corpusBytes);

  // 2. Derive the deterministic query from the model-visible brief ONLY.
  //    Reviewer-only label data does not enter this string. Field order is
  //    fixed so the same brief yields byte-identical queries.
  const query = briefToQuery(brief);

  // 3. Run the pinned keyword-only retrieval. The shipped `searchRanked` makes
  //    ZERO Voyage requests under `searchMode: "keyword-only"` (Task 6 Step 3).
  const ranked = await deps.reader.searchRanked({
    query,
    limit: C2_RETRIEVAL_LIMIT,
    reviewStatus: "approved",
    rerank: false,
    searchMode: C2_RETRIEVAL_MODE,
  });

  // 4. Re-hash `corpus/entries.json` AFTER ranking. If the corpus mutated
  //    during resolution, abort — the evidence would bind to a moving target.
  const postBytes = deps.readArtifact(CORPUS_ENTRIES_PATH);
  const postSha256 = sha256Hex(postBytes);
  if (postSha256 !== corpusSha256) {
    throw new Error(
      `[c2-resolver] corpus ${CORPUS_ENTRIES_PATH} mutated during current-grounded `
      + `resolution (before=${corpusSha256.slice(0, 12)}… after=${postSha256.slice(0, 12)}…). `
      + `Aborting to avoid binding evidence to a moving target.`,
    );
  }

  // 5. Convert ranked results into evidence records with canonical content
  //    hashes. The complete ranked result is preserved; the durable metadata
  //    carries the ranking (entryId + rank + score + contentSha256) and the
  //    per-record evidence metadata. The actual content bytes are stored
  //    privately and surfaced through the private payload.
  const evidence: C2EvidenceRecord[] = [];
  const rankedResult: Array<{
    entryId: string;
    rank: number;
    score: number;
    contentSha256: string;
  }> = [];
  const evidenceContent = new Map<string, string>();

  for (let i = 0; i < ranked.length; i += 1) {
    const result = ranked[i]!;
    const rank = i + 1;
    const content = entryToContent(result.entry);
    const contentSha = sha256Hex(Buffer.from(content, "utf-8"));
    const evidenceId = `corpus:${result.entry.id}`;
    evidence.push({
      id: evidenceId,
      authorityLane: "adapt",
      sourceType: "corpus-entry",
      sourceArtifactId: "corpus",
      sourceSha256: corpusSha256,
      contentSha256: contentSha,
      rank,
      score: result.score,
    });
    rankedResult.push({
      entryId: result.entry.id,
      rank,
      score: result.score,
      contentSha256: contentSha,
    });
    evidenceContent.set(evidenceId, content);
  }

  // The retrieval index SHA-256 binds the keyword-only scorer configuration.
  // We pin it to the canonical hash of the literal mode + limit so a future
  // mode change (e.g. enabling hybrid) flips the input hash by construction.
  const retrievalIndexSha256 = sha256Hex(
    Buffer.from(canonicalJsonStringify({
      mode: C2_RETRIEVAL_MODE,
      limit: C2_RETRIEVAL_LIMIT,
      reviewStatus: "approved",
      rerank: false,
    }), "utf-8"),
  );

  // selectedEntryIds: every ranked entry is model-visible evidence. The
  // contract requires at least one selected entry for current-grounded; if the
  // corpus produced zero results, that is a legitimate coverage gap and the
  // resolver MUST NOT inject hand-curated results (spec §5.2). The schema's
  // `min(1)` constraint on current-grounded evidence will then reject the
  // input at validation time — surfacing the gap honestly.
  const selectedEntryIds = ranked.map((r) => r.entry.id);

  // 6. Assemble the metadata. Use the variant type directly so the discriminated
  //    union narrows correctly.
  const metadata: Extract<C2ConditionInput, { condition: "current-grounded" }> = {
    schemaVersion: "1.0",
    artifactType: "c2-condition-input",
    artifactId: `c2-condition-input-${brief.caseId}-current-grounded`,
    casePackageRef: request.casePackageRef,
    briefRef: request.briefRef,
    sourceSnapshotRefs: sourceRefsFor(request),
    inputSha256: "PLACEHOLDER",
    condition: "current-grounded",
    evidence,
    corpusSha256,
    retrievalIndexSha256,
    retrieval: {
      query,
      configurationSha256: retrievalIndexSha256,
      rankedResult,
      selectedEntryIds,
    },
  };
  metadata.inputSha256 = computeInputSha256(metadata);

  // 7. Assemble the private payload. Carries the full ranking, the snapshot
  //    path, and the actual evidence content bytes keyed by evidence ID.
  const privatePayload = canonicalJsonStringify({
    condition: "current-grounded",
    caseId: brief.caseId,
    corpusSnapshotPath: snapshotRelPath,
    corpusSha256,
    corpusEntryCount,
    retrievalMode: C2_RETRIEVAL_MODE,
    rankedResult,
    evidenceContent: Object.fromEntries(evidenceContent),
  });

  return { metadata, privatePayload };
}

// ---------------------------------------------------------------------------
// Gold-evidence
// ---------------------------------------------------------------------------

async function resolveGoldEvidence(
  request: ResolveConditionInputRequest,
  deps: ResolveConditionDeps,
): Promise<ResolvedConditionInput> {
  const brief = request.brief;
  const label = request.label;
  const descriptor = request.goldEvidenceDescriptor;
  const descriptorRef = request.goldDescriptorRef;

  if (!label) {
    throw new Error("[c2-resolver] gold-evidence requires a reviewer-only label");
  }
  if (!descriptor) {
    throw new Error("[c2-resolver] gold-evidence requires a gold-evidence descriptor");
  }
  if (!descriptorRef) {
    throw new Error("[c2-resolver] gold-evidence requires a hash-bound descriptor reference");
  }

  // 1. Verify the descriptor hash against the on-disk bytes. A mismatch means
  //    the descriptor was edited after the manifest was bound — abort.
  const descriptorBytes = deps.readArtifact(descriptorRef.path);
  const descriptorSha256 = sha256Hex(descriptorBytes);
  if (descriptorSha256 !== descriptorRef.sha256) {
    throw new Error(
      `[c2-resolver] gold-evidence descriptor hash mismatch: bound `
      + `${descriptorRef.sha256.slice(0, 12)}… but on-disk bytes hash to `
      + `${descriptorSha256.slice(0, 12)}…. Refusing to resolve against a mutated descriptor.`,
    );
  }

  // 2. For every descriptor record, resolve every JSON pointer against the
  //    bound source artifact and compute the canonical content hash. Reject
  //    duplicate pointers, duplicate record IDs, and unresolvable pointers.
  const seenRecordIds = new Set<string>();
  const evidence: C2EvidenceRecord[] = [];
  const evidenceContent = new Map<string, string>();

  for (const record of descriptor.records) {
    if (seenRecordIds.has(record.id)) {
      throw new Error(
        `[c2-resolver] duplicate gold-evidence record ID: ${record.id}`,
      );
    }
    seenRecordIds.add(record.id);

    // The descriptor record names its source artifact. We resolve pointers
    // against the bound source: the brief for brief-sourced records, or the
    // source snapshot for snapshot-sourced records. The source artifact id on
    // the record MUST match one of the bound artifacts.
    const sourceDoc = resolveSourceDoc(record.sourceArtifactId, request, deps);
    const seenPointers = new Set<string>();
    const resolvedParts: string[] = [];
    for (const pointer of record.jsonPointers) {
      if (seenPointers.has(pointer)) {
        throw new Error(
          `[c2-resolver] duplicate JSON pointer ${pointer} on record ${record.id}`,
        );
      }
      seenPointers.add(pointer);
      const resolved = resolveJsonPointer(sourceDoc, pointer);
      if (resolved === undefined) {
        throw new Error(
          `[c2-resolver] gold-evidence pointer ${pointer} on record ${record.id} `
          + `did not resolve against source artifact ${record.sourceArtifactId}`,
        );
      }
      resolvedParts.push(canonicalJsonStringify(resolved));
    }
    const content = resolvedParts.join("\n");
    const contentSha256 = sha256Hex(Buffer.from(content, "utf-8"));
    const sourceSha256 = sha256Hex(
      deps.readArtifact(artifactPathFor(record.sourceArtifactId, request)),
    );

    evidence.push({
      id: record.id,
      authorityLane: "retain",
      sourceType: record.sourceArtifactId === brief.artifactId ? "brief-fragment" : "source-snapshot",
      sourceArtifactId: record.sourceArtifactId,
      sourceSha256,
      contentSha256,
      rank: null,
      score: null,
    });
    evidenceContent.set(record.id, content);
  }

  // 3. Exact equality: the resolved gold IDs MUST equal the label's gold IDs
  //    (as sets, order-independent — the label is the authority).
  const resolvedGoldIds = evidence.map((e) => e.id);
  const labelGoldSet = new Set(label.goldEvidenceIds);
  const resolvedSet = new Set(resolvedGoldIds);
  if (resolvedSet.size !== labelGoldSet.size || [...resolvedSet].some((id) => !labelGoldSet.has(id))) {
    throw new Error(
      `[c2-resolver] gold-evidence resolved IDs do not exactly match the label's `
      + `gold IDs. Resolved: ${JSON.stringify(resolvedGoldIds.sort())}. `
      + `Label: ${JSON.stringify([...labelGoldSet].sort())}.`,
    );
  }

  // 4. The corpus hash pins the corpus state at resolution time (gold-evidence
  //    also binds the corpus so the input hash flips if the corpus changes).
  const corpusBytes = deps.readArtifact(CORPUS_ENTRIES_PATH);
  const corpusSha256 = sha256Hex(corpusBytes);
  const retrievalIndexSha256 = sha256Hex(
    Buffer.from(canonicalJsonStringify({ mode: "gold", source: "descriptor" }), "utf-8"),
  );

  const metadata: Extract<C2ConditionInput, { condition: "gold-evidence" }> = {
    schemaVersion: "1.0",
    artifactType: "c2-condition-input",
    artifactId: `c2-condition-input-${brief.caseId}-gold-evidence`,
    casePackageRef: request.casePackageRef,
    briefRef: request.briefRef,
    sourceSnapshotRefs: sourceRefsFor(request),
    inputSha256: "PLACEHOLDER",
    condition: "gold-evidence",
    evidence,
    corpusSha256,
    retrievalIndexSha256,
    retrieval: null,
    goldPacketRef: descriptorRef,
    resolvedGoldIds,
  };
  metadata.inputSha256 = computeInputSha256(metadata);

  const privatePayload = canonicalJsonStringify({
    condition: "gold-evidence",
    caseId: brief.caseId,
    corpusSha256,
    evidenceContent: Object.fromEntries(evidenceContent),
  });

  return { metadata, privatePayload };
}

// ---------------------------------------------------------------------------
// Helpers — query derivation, content hashing, JSON pointers, source docs
// ---------------------------------------------------------------------------

/**
 * Derive the current-grounded search query from the model-visible brief ONLY.
 *
 * Field order is fixed: title, product context, users, jobs, platform, required
 * journeys, constraints, required-screen IDs. Reviewer-only label fields are
 * NEVER consulted.
 */
export function briefToQuery(brief: C2CaseBrief): string {
  const parts: string[] = [
    brief.title,
    brief.productContext,
    ...brief.users,
    ...brief.jobs,
    brief.platform,
    ...brief.requiredJourneys,
    ...brief.constraints,
    ...brief.requiredScreens.map((s) => s.id),
  ];
  return parts.map((p) => p.trim()).filter((p) => p.length > 0).join(" ").trim();
}

/**
 * Canonical content for a corpus entry. Used as the model-visible evidence
 * block for a current-grounded evidence record. Canonical JSON keeps the hash
 * stable across equivalent serializations.
 */
function entryToContent(entry: SearchResult["entry"]): string {
  // The model-visible content for a corpus entry is a curated subset: title,
  // pattern type, critique, what-to-steal, and the structural tags. We exclude
  // source identity + image paths (private) and the raw anti-patterns list
  // (verbose). The subset matches what the shipped keyword scorer searches.
  //
  // Optional fields (`components`, `domainTags`, `platform`) are coerced to a
  // canonical-JSON-safe default when absent. `platform` defaults to `null`
  // (matching the `rank: null` / `score: null` sentinel used for gold-evidence
  // records) because canonical JSON refuses `undefined`; coercing to `null`
  // keeps the content hash stable regardless of whether an entry omits the
  // optional platform field.
  return canonicalJsonStringify({
    id: entry.id,
    title: entry.title,
    patternType: entry.patternType,
    categories: entry.categories,
    styleTags: entry.styleTags,
    components: entry.components ?? [],
    domainTags: entry.domainTags ?? [],
    critique: entry.critique,
    whatToSteal: entry.whatToSteal,
    qualityScore: entry.qualityScore,
    qualityTier: entry.qualityTier,
    platform: entry.platform ?? null,
  });
}

/**
 * Resolve a JSON pointer (RFC 6901) against a parsed JSON document. Returns
 * `undefined` for an unresolvable pointer. Supports the empty-string pointer
 * (whole document) and `/segment/segment` pointers with the standard escapes
 * (~1 → /, ~0 → ~).
 */
function resolveJsonPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  let current: unknown = doc;
  const segments = pointer.split("/").slice(1); // drop the leading ""
  for (const rawSeg of segments) {
    if (rawSeg === "") return undefined; // empty segment — invalid pointer
    const seg = rawSeg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else {
      current = (current as Record<string, unknown>)[seg];
      if (current === undefined) return undefined;
    }
  }
  return current;
}

/**
 * Parse the source artifact for a descriptor record. The record's
 * `sourceArtifactId` names either the brief or the source snapshot; we locate
 * the matching repo-relative path on the request and parse its bytes.
 */
function resolveSourceDoc(
  sourceArtifactId: string,
  request: ResolveConditionInputRequest,
  deps: ResolveConditionDeps,
): unknown {
  const path = artifactPathFor(sourceArtifactId, request);
  const bytes = deps.readArtifact(path);
  return JSON.parse(bytes.toString("utf-8"));
}

/**
 * Resolve a source artifact id to its repo-relative path. The brief is the
 * obvious case; the source snapshot is named on the brief's `sourceSnapshotRef`
 * (migration cases). Anything else is an error.
 */
function artifactPathFor(sourceArtifactId: string, request: ResolveConditionInputRequest): string {
  if (sourceArtifactId === request.brief.artifactId) {
    return request.briefRef.path;
  }
  const snap = request.sourceSnapshotRef;
  if (snap && sourceArtifactId === snap.artifactId) {
    return snap.path;
  }
  throw new Error(
    `[c2-resolver] source artifact ${sourceArtifactId} is neither the bound brief `
    + `(${request.brief.artifactId}) nor a bound source snapshot. `
    + `Descriptor records must point at artifacts present on the request.`,
  );
}

/**
 * Collect the source snapshot refs for the condition input. Migration cases
 * carry one ref (the bound snapshot); non-migration cases carry none.
 */
function sourceRefsFor(
  request: ResolveConditionInputRequest,
): Extract<C2ConditionInput, { condition: "current-grounded" }>["sourceSnapshotRefs"] {
  const snap = request.sourceSnapshotRef;
  if (!snap) return [];
  return [{
    artifactId: snap.artifactId,
    path: snap.path,
    sha256: snap.sha256,
  }];
}

/**
 * Best-effort entry count from the corpus bytes. Used only for the private
 * payload (informational); the durable metadata carries the corpus hash, which
 * is the authoritative binding. Returns 0 if the bytes aren't a valid corpus
 * envelope (the resolver will still abort if the post-ranking hash differs).
 */
function safeEntryCount(bytes: Buffer): number {
  try {
    const parsed = JSON.parse(bytes.toString("utf-8")) as { entries?: unknown[] };
    return Array.isArray(parsed.entries) ? parsed.entries.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Compute the canonical `inputSha256` over the metadata, EXCLUDING the
 * placeholder hash field itself. The hash is taken over the canonical JSON of
 * every model-visible field, so any mutation to a bound field flips the digest.
 */
function computeInputSha256(metadata: C2ConditionInput): string {
  // Strip the placeholder + re-canonicalize so the hash is self-consistent.
  const { inputSha256: _omit, ...rest } = metadata;
  void _omit;
  return sha256Hex(Buffer.from(canonicalJsonStringify(rest), "utf-8"));
}

// ---------------------------------------------------------------------------
// Re-exports for tests
// ---------------------------------------------------------------------------

export const __test = {
  briefToQuery,
  resolveJsonPointer,
  computeInputSha256,
};

// Avoid unused-import warnings when writePrivateArtifact is tree-shaken out of
// the brief-only path (which never writes).
void writePrivateArtifact;
