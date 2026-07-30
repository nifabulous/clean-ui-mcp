# Approval Retraction Vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the readiness governance ledger an append-only record that retracts a prior approval (who/when/why), clears the two temporal-defect findings on the C2 v2 approvals, and leaves C2 cleanly open.

**Architecture:** A new `recordKind:"retraction"` row lives in the same `approvals` array as a `z.union([CheckpointApproval, CheckpointRetraction])` (approval branch first — `CheckpointApproval` is left untouched so parsed approval rows stay byte-identical and existing pin digests do not move). The validator partitions rows into approvals vs retractions, runs approval semantics over approval rows only, builds a `retractedApprovalIds` set from *valid* retractions, excludes those approvals from the effective set, and suppresses their temporal findings — the only thing that clears them. Retraction is monotonic toward *open*; it can never close. A v6 ledger appends two retraction records over v5's unchanged prefix.

**Tech Stack:** TypeScript, Zod, Vitest. Modules: `src/readiness/contracts.ts`, `src/readiness/validator.ts`, `src/readiness/ledger-pins.ts`. Governance artifacts under `quality-contracts/agent-readiness/`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-30-approval-retraction-vocabulary-design.md`.
- **Governing invariant:** a retraction can only ever REMOVE an approval from the effective set; it can never add, resurrect a superseded approval, or close a checkpoint. Every task is checked against this.
- **Byte-identical history:** `quality-contracts/agent-readiness/checkpoint-approvals-v1..v5.json` and every other pre-existing `quality-contracts/` artifact stay byte-for-byte identical to `origin/main`. The retraction is a v6 append.
- **No fabrication:** do NOT write `cf55fee0…` reviewer approvals. C2 lands **open**.
- **Fail-closed only:** never reintroduce an escape hatch that clears a temporal finding by anything other than a valid recorded retraction. Do NOT demote any invariant to a warning.
- **Retractor authorization:** `retractedBy.role === "Repository Maintainer"` and `actorKind === "human"`, resolvable/authorized in the retraction's own pinned registry.
- **TDD:** failing test first, then minimal code. Commit each task. Tests must use fixture/temp paths and read the real tracked `quality-contracts/` artifacts read-only.
- **Clean-checkout verification** (per repo memory): validate readiness in throwaway per-commit `git worktree` copies, each running `npx tsc` inside itself, private mode (`--corpus-path corpus/entries.json`); empty stderr is load-bearing (pins in force).

## Verified anchors (grounded against the real code)

- `CheckpointApproval` schema: `src/readiness/contracts.ts:117-139` (`.strict()`).
- Ledger envelope: `CheckpointApprovals` = `src/readiness/contracts.ts:396-400`, field `approvals: z.array(CheckpointApproval)` (line 399).
- Append-only: `validateLedgerAppendOnly` = `src/readiness/contracts.ts:602` (iterates `previous.approvals` as a prefix, matches by `approvalId`).
- Pin digest: `ledgerApprovalRowsDigest(approvals: unknown)` = `src/readiness/ledger-pins.ts:257` = `sha256Hex(canonicalJsonStringify(approvals))` — already `unknown`, covers mixed rows unchanged.
- Pin table: `TRACKED_LEDGER_APPROVAL_PINS` = `src/readiness/ledger-pins.ts:328` (path → rows-digest; v1–v5 present).
- Approval validation: `validateApprovalsAndCheckpoint` = `src/readiness/validator.ts:1168`.
  - `supersededApprovalIds` set: `validator.ts:1197`.
  - `noteApprovalIssue(approvalId, code)`: `validator.ts:1206`.
  - `ledger-supersession-not-later` check: `validator.ts:1338-1353`.
  - `verifyApprovalArtifactTimestamps(approvals, artifacts, supersededApprovalIds, issues, noteApprovalIssue)`: called `validator.ts:1366`; emits `approved-artifact-created-after-decision`.
  - `activeApprovals = approvals.filter(a => !supersededApprovalIds.has(a.approvalId))`: `validator.ts:1381`.
- Artifact content digest (= `predecessor.sha256`): `sha256Hex(readFileSync(file))`, `validator.ts:201` / `:375`. **Verified:** `v5.predecessor.sha256` (`f72a0e…`) == `sha256(checkpoint-approvals-v4.json bytes)`.
- Ledgers are discovered by `readdirSync(absRoot)` (`validator.ts:337`) and are **NOT** in the artifact index (verified: the index lists actors/ownership/phase0/taxonomy/c2-evidence only). **So v6 needs the file + a pin + a valid chain link — no artifact-index entry.**
- The two records to retract (verbatim from v5):
  - `c2-gold-reviewer-gold-v2` — role `Gold Label Owner`, actor `reviewer-gold`, `actorKind:"human"`, `actorRegistryVersion:"3.0"`, `decidedAt:"2026-07-26T21:18:07.000Z"`, `supersedesApprovalId:"c2-gold-reviewer-gold-v1"`, target `cf55fee0…`.
  - `c2-qa-reviewer-qa-v2` — role `QA`, actor `reviewer-qa`, `actorKind:"human"`, `actorRegistryVersion:"3.0"`, `decidedAt:"2026-07-26T21:20:11.000Z"`, `supersedesApprovalId:"c2-qa-reviewer-qa-v1"`, target `cf55fee0…`.

## File structure

- `src/readiness/contracts.ts` — add `CheckpointRetraction` (with `retractionId`), leave `CheckpointApproval` UNCHANGED, add `LedgerRow` (`z.union`, approval branch first), retype `CheckpointApprovals.approvals` and `validateLedgerAppendOnly`. Export `LedgerRowT`, `CheckpointApprovalT`, `CheckpointRetractionT`, and the `isApprovalRow`/`isRetractionRow` type-guard pair.
- `src/readiness/contracts.test.ts` — schema + back-compat + legacy-parse tests.
- `src/readiness/validator.ts` — partition rows; `computeRetractedApprovalIds`; validity findings; effective-set exclusion; gated suppression; Model B.
- `src/readiness/validator.test.ts` (or the existing readiness validator test file) — validity + fail-closed + Model-B + valid-path tests.
- `src/readiness/ledger-pins.ts` — add the v6 pin entry.
- `src/readiness/tracked-artifacts-readiness.test.ts` — v6 append-only/pin/digest + real-artifact gate expectation.
- `quality-contracts/agent-readiness/checkpoint-approvals-v6.json` — new ledger (created in Task 5).
- `docs/AGENT_READINESS_STATUS.md`, `docs/c2/c2-checkpoint-approval-handoff.md`, `TODOS.md` — Task 6.

---

### Task 1: Retraction schema + back-compatible discriminated union

**Files:**
- Modify: `src/readiness/contracts.ts` (approval block `117-139`, envelope `396-400`, `validateLedgerAppendOnly` `602`)
- Test: `src/readiness/contracts.test.ts`

**Interfaces:**
- Produces: `CheckpointRetraction` (Zod), `CheckpointRetractionT`, `CheckpointApprovalT`, `LedgerRow` (`z.union([CheckpointApproval, CheckpointRetraction])`, approval-branch first), `LedgerRowT`, `isApprovalRow(row): row is CheckpointApprovalT`, `isRetractionRow(row): row is CheckpointRetractionT`. `CheckpointApprovals.approvals: z.array(LedgerRow)`. `validateLedgerAppendOnly(current: {approvals: LedgerRowT[]}, previous: {approvals: LedgerRowT[]})`. **`CheckpointApproval` is UNCHANGED** (no `recordKind` field) so parsed approval rows stay byte-identical and v1–v5 pin digests do not move.

- [ ] **Step 1: Write the failing test**

Add to `src/readiness/contracts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CheckpointApprovals, CheckpointRetraction, isApprovalRow, isRetractionRow } from "./contracts.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const AR = resolve(__dirname, "..", "..", "quality-contracts", "agent-readiness");

const VALID_RETRACTION = {
  recordKind: "retraction",
  retractionId: "retraction-c2-gold-v2",
  retractsApprovalId: "c2-gold-reviewer-gold-v2",
  retractedBy: {
    actorId: "repo-maintainer",
    role: "Repository Maintainer",
    actorKind: "human",
    actorRegistryVersion: "3.0",
    actorRegistrySha256: "a".repeat(64),
  },
  retractedAt: "2026-07-30T12:00:00.000Z",
  reason: "decidedAt predates the bound target cf55fee0 (provenance defect, 2026-07-28).",
};

describe("CheckpointRetraction schema", () => {
  it("accepts a well-formed retraction and rejects a non-maintainer / non-human retractor", () => {
    expect(CheckpointRetraction.safeParse(VALID_RETRACTION).success).toBe(true);
    expect(CheckpointRetraction.safeParse({ ...VALID_RETRACTION, retractedBy: { ...VALID_RETRACTION.retractedBy, role: "QA" } }).success).toBe(false);
    expect(CheckpointRetraction.safeParse({ ...VALID_RETRACTION, retractedBy: { ...VALID_RETRACTION.retractedBy, actorKind: "agent" } }).success).toBe(false);
    expect(CheckpointRetraction.safeParse({ ...VALID_RETRACTION, reason: "" }).success).toBe(false);
  });
});

describe("ledger discriminated union — back-compat", () => {
  it("parses a legacy approval row that omits recordKind as an approval", () => {
    // v5 has NO recordKind on any row; the whole envelope must still parse.
    const v5 = JSON.parse(readFileSync(resolve(AR, "checkpoint-approvals-v5.json"), "utf-8"));
    const parsed = CheckpointApprovals.safeParse(v5);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.approvals.every(isApprovalRow)).toBe(true);
      expect(parsed.data.approvals.some(isRetractionRow)).toBe(false);
    }
  });

  it("parses a mixed envelope (approvals + a retraction) and classifies rows", () => {
    const v5 = JSON.parse(readFileSync(resolve(AR, "checkpoint-approvals-v5.json"), "utf-8"));
    const mixed = { ...v5, approvals: [...v5.approvals, VALID_RETRACTION] };
    const parsed = CheckpointApprovals.safeParse(mixed);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.approvals.filter(isRetractionRow)).toHaveLength(1);
    }
  });

  it("rejects a row with an unknown recordKind", () => {
    const v5 = JSON.parse(readFileSync(resolve(AR, "checkpoint-approvals-v5.json"), "utf-8"));
    const bad = { ...v5, approvals: [...v5.approvals, { recordKind: "bogus" }] };
    expect(CheckpointApprovals.safeParse(bad).success).toBe(false);
  });

  it("v1..v5 all parse unchanged after the migration", () => {
    for (const v of [1, 2, 3, 4, 5]) {
      const j = JSON.parse(readFileSync(resolve(AR, `checkpoint-approvals-v${v}.json`), "utf-8"));
      expect(CheckpointApprovals.safeParse(j).success, `v${v}`).toBe(true);
    }
  });

  it("parsed approval rows are byte-identical to input (pin digests do not move)", () => {
    // The whole reason for z.union over discriminatedUnion+default: parsing must
    // NOT add recordKind, or every v1..v5 ledgerApprovalRowsDigest pin breaks.
    const v5 = JSON.parse(readFileSync(resolve(AR, "checkpoint-approvals-v5.json"), "utf-8"));
    const parsed = CheckpointApprovals.parse(v5);
    expect(JSON.stringify(parsed.approvals)).toBe(JSON.stringify(v5.approvals));
    expect(parsed.approvals.every((r: unknown) => !(r && typeof r === "object" && "recordKind" in r))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/readiness/contracts.test.ts -t "CheckpointRetraction\|discriminated union"`
Expected: FAIL — `CheckpointRetraction`/`isApprovalRow`/`isRetractionRow` are not exported.

- [ ] **Step 3: Write minimal implementation**

**Do NOT add `recordKind` to `CheckpointApproval`** and do NOT use
`z.discriminatedUnion` + `z.preprocess` + `.default`. That path makes Zod ADD
`recordKind` to every parsed approval row, which changes
`ledgerApprovalRowsDigest(parsed.data.approvals)` (validator.ts:677) and breaks
the v1–v5 pins. Use a plain `z.union` with the approval branch FIRST, leaving
`CheckpointApproval` untouched. **Empirically verified:** a parsed legacy
approval row deep-equals its input (no `recordKind` added → v1–v5 pin digests
unchanged); a retraction row fails the strict approval branch (missing
`approvalId` + unknown keys) and routes to the retraction branch.

`CheckpointApproval` stays exactly as it is today (`.strict()`, no `recordKind`).
After it, add:

```ts
export const CheckpointRetraction = z
  .object({
    recordKind: z.literal("retraction"),
    retractionId: z.string().min(1), // this row's own stable id (distinct from any approvalId)
    retractsApprovalId: z.string().min(1),
    retractedBy: z
      .object({
        actorId: z.string().min(1),
        role: z.literal("Repository Maintainer"),
        actorKind: z.literal("human"),
        actorRegistryVersion: z.string().min(1),
        actorRegistrySha256: Sha256,
      })
      .strict(),
    retractedAt: z.string().datetime(),
    reason: z.string().min(1),
  })
  .strict();

// Approval branch FIRST: a legacy approval row (no recordKind) matches it and is
// returned UNCHANGED (no recordKind added → row digest byte-stable, so v1..v5
// pins hold). A retraction row fails the strict approval branch (missing the
// required approval fields + unknown `recordKind`/`retractsApprovalId`/`retractedBy`
// keys) and routes to CheckpointRetraction.
export const LedgerRow = z.union([CheckpointApproval, CheckpointRetraction]);

export type CheckpointApprovalT = z.infer<typeof CheckpointApproval>;
export type CheckpointRetractionT = z.infer<typeof CheckpointRetraction>;
export type LedgerRowT = z.infer<typeof LedgerRow>;

// Retraction rows carry recordKind; approval rows never do. Presence of the
// literal is the discriminant.
export function isRetractionRow(row: LedgerRowT): row is CheckpointRetractionT {
  return "recordKind" in row && (row as { recordKind?: unknown }).recordKind === "retraction";
}
export function isApprovalRow(row: LedgerRowT): row is CheckpointApprovalT {
  return !isRetractionRow(row);
}
```

Retype the envelope (line 399):

```ts
  approvals: z.array(LedgerRow),
```

Retype `validateLedgerAppendOnly` (line 602-603) params from `{ approvals: z.infer<typeof CheckpointApproval>[] }` to `{ approvals: LedgerRowT[] }` for both `current` and `previous`. Inside, where it reads `prior.approvalId` / `current.approvals.some(a => a.approvalId === prior.approvalId)`, guard with the row kind so retraction rows compare by identity too:

```ts
    const rowId = (r: LedgerRowT): string =>
      r.recordKind === "retraction" ? `retraction:${r.retractionId}` : r.approvalId;
```

Compare `rowId(prior)` vs `rowId(next)` and use a kind-aware field-equality (retraction rows compare all their own fields; approval rows as before). Keep the existing "moved" fallback (`current.approvals.some(a => rowId(a) === rowId(prior))`). Prefix semantics are unchanged for the v1–v5 approval prefix; retraction rows only ever appear appended after it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/readiness/contracts.test.ts`
Expected: PASS (all schema + back-compat tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. (Fixes any consumer that assumed `approvals[i].approvalId` unconditionally — those become Task 2, so if `tsc` flags validator.ts here, add `// TODO(task2)` narrowing casts only if needed to keep this task green; prefer to leave validator.ts untouched and let Task 2 own it. If tsc errors originate only in validator.ts, proceed — Task 2 fixes them and re-greens tsc.)

- [ ] **Step 6: Commit**

```bash
git add src/readiness/contracts.ts src/readiness/contracts.test.ts
git commit -m "feat(readiness): retraction record + back-compatible ledger discriminated union"
```

---

### Task 2: Validator row-partition (no behavior change)

**Files:**
- Modify: `src/readiness/validator.ts` (`validateApprovalsAndCheckpoint`, from `1168`)
- Test: existing readiness validator test file (all current tests must stay green)

**Interfaces:**
- Produces (internal): `approvalRows: CheckpointApprovalT[]`, `retractionRows: CheckpointRetractionT[]` derived at the top of `validateApprovalsAndCheckpoint`. Every existing loop that iterated `approvals` as approvals now iterates `approvalRows`.

- [ ] **Step 1: Establish the safety net**

Run the whole readiness suite and record the baseline (must stay identical after this refactor):

Run: `npx vitest run src/readiness/`
Expected: PASS (record the count).

- [ ] **Step 2: Partition at the top of `validateApprovalsAndCheckpoint`**

Immediately after the function reads its `approvals` param (before `supersededApprovalIds` at 1197), add:

```ts
  const approvalRows = approvals.filter(isApprovalRow);
  const retractionRows = approvals.filter(isRetractionRow);
```

Import `isApprovalRow`, `isRetractionRow`, `CheckpointRetractionT` from `./contracts.js`.

- [ ] **Step 3: Route approval semantics through `approvalRows`**

Replace `approvals` with `approvalRows` in every approval-semantic site inside this function ONLY:
- `supersededApprovalIds` source (1197-1198).
- the supersession loop that reads `approvals.findIndex(...)` / `approvals[priorIndex]` (1231-1237).
- `activeApprovals` (1381) — `approvalRows.filter(...)`.
- the `for (const approval of approvals)` loop (1398).
- the `verifyApprovalArtifactTimestamps(approvals, ...)` call (1366) → pass `approvalRows`.

Leave `validateLedgerAppendOnly` and `ledgerApprovalRowsDigest` call sites reading the FULL `parsed.data.approvals` (mixed) — they are tamper-evidence over all rows.

- [ ] **Step 4: Run the full readiness suite**

Run: `npx vitest run src/readiness/`
Expected: PASS with the SAME count as Step 1 (pure refactor — no retraction rows exist yet, so `approvalRows === approvals`).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/readiness/validator.ts
git commit -m "refactor(readiness): partition ledger rows; approval semantics over approval rows"
```

---

### Task 3: Retraction validity + finding codes

**Files:**
- Modify: `src/readiness/validator.ts`
- Test: readiness validator test file

**Interfaces:**
- Produces (internal): `computeRetractedApprovalIds(allRows: LedgerRowT[], retractionRows: CheckpointRetractionT[], registryByVersion, issues): Set<string>` — takes the FULL mixed row list (for ordering), returns the ids of approvals cleared by a VALID retraction; pushes a finding per invalid retraction. New issue codes: `retraction-unauthorized`, `retraction-target-missing`, `retraction-out-of-order`, `retraction-target-not-approval`, `retraction-duplicate`.

- [ ] **Step 1: Write the failing tests (one per invalid class + the valid case)**

Add a `describe("retraction validity")` in the readiness validator test file. Use the existing harness that builds an in-memory artifact set / parsed ledger (mirror how supersession tests construct approvals). For each case assert the specific issue code is present AND the target id is NOT in the returned retracted set. Cases:
- valid maintainer/human retraction of an earlier approval → id in set, no finding.
- `retractedBy.role: "QA"` → `retraction-unauthorized`, id NOT in set.
- `actorKind: "agent"` → `retraction-unauthorized`.
- retractor actor absent/unauthorized in the pinned registry → `retraction-unauthorized`.
- `retractsApprovalId` names no approval → `retraction-target-missing`.
- names an approval appearing at/after the retraction → `retraction-out-of-order`.
- names a retraction row / itself → `retraction-target-not-approval`.
- two retractions naming the same approval → second is `retraction-duplicate` (inert).

(Write concrete fixtures mirroring the existing supersession-test builders; assert `issues.some(i => i.code === "<code>")` and set membership.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/readiness/ -t "retraction validity"`
Expected: FAIL — `computeRetractedApprovalIds` not defined.

- [ ] **Step 3: Implement `computeRetractedApprovalIds`**

Add near `validateApprovalsAndCheckpoint`. Order-awareness uses each row's index in the ORIGINAL mixed `approvals` array (a retraction must follow the approval it names):

```ts
// NOTE (verified): `registryByVersion` is `ReadonlyMap<string, ParsedArtifact>`
// (validator.ts:174) — version → the parsed registry ARTIFACT, not the registry
// itself. Resolve exactly as `resolveApprovalRegistry` (validator.ts:2041) does:
// look up by version, verify `entry.sha === recorded sha256`, then
// `ApprovalActorRegistry.safeParse(entry.data)`. `ParsedArtifact` is the
// in-module type at validator.ts:149; `ApprovalActorRegistry` is already
// imported (validator.ts:15).
function computeRetractedApprovalIds(
  allRows: LedgerRowT[],
  retractionRows: CheckpointRetractionT[],
  registryByVersion: ReadonlyMap<string, ParsedArtifact>,
  issues: ValidationIssue[],
): Set<string> {
  const retracted = new Set<string>();

  // First index of each approvalId in the mixed list.
  const approvalIndexById = new Map<string, number>();
  allRows.forEach((row, i) => {
    if (row.recordKind === "approval" && !approvalIndexById.has(row.approvalId)) {
      approvalIndexById.set(row.approvalId, i);
    }
  });
  const retractionIndex = new Map<CheckpointRetractionT, number>();
  allRows.forEach((row, i) => {
    if (row.recordKind === "retraction") retractionIndex.set(row, i);
  });

  const push = (code: string, targetId: string, message: string) =>
    issues.push({ code, artifactId: targetId, message });

  for (const r of retractionRows) {
    const rIdx = retractionIndex.get(r)!;
    const targetId = r.retractsApprovalId;

    // Authorization: role + kind are schema-guaranteed on the record, but the
    // actor must also resolve in the retraction's OWN pinned registry (version +
    // sha256 verified) as a human authorized for Repository Maintainer. Any
    // resolution failure is fail-closed → retraction-unauthorized (inert).
    const entry = registryByVersion.get(r.retractedBy.actorRegistryVersion);
    const registry =
      entry && entry.sha === r.retractedBy.actorRegistrySha256
        ? ApprovalActorRegistry.safeParse(entry.data)
        : undefined;
    const actor =
      registry?.success
        ? registry.data.actors.find((a) => a.actorId === r.retractedBy.actorId)
        : undefined;
    if (!actor || actor.actorKind !== "human" || !actor.roles.includes("Repository Maintainer")) {
      push("retraction-unauthorized", targetId, `retraction of ${targetId}: retractor ${r.retractedBy.actorId} is not an authorized human Repository Maintainer`);
      continue;
    }

    // Classify the target: approval / retraction-row-or-self / absent.
    const targetApprovalIdx = approvalIndexById.get(targetId);
    if (targetApprovalIdx === undefined) {
      // targetId names an approvalId; if it instead matches a retractionId (its
      // own — self — or another retraction's), it is not an approval.
      const namesARetraction = allRows.some(
        (row) => row.recordKind === "retraction" && row.retractionId === targetId,
      );
      push(namesARetraction ? "retraction-target-not-approval" : "retraction-target-missing", targetId, `retraction ${r.retractionId} names ${targetId}, which is not an earlier approval row`);
      continue;
    }
    if (targetApprovalIdx >= rIdx) {
      push("retraction-out-of-order", targetId, `retraction of ${targetId} must follow the approval it retracts`);
      continue;
    }
    if (retracted.has(targetId)) {
      push("retraction-duplicate", targetId, `duplicate retraction of ${targetId}`);
      continue;
    }
    retracted.add(targetId);
  }
  return retracted;
}
```

> **Note on target classification:** retraction rows carry no `approvalId`, so a
> `retractsApprovalId` that names a retraction (or is self-referential) simply
> won't be in `approvalIndexById` — it lands in the "not an approval" branch. The
> `namesARetraction` check distinguishes `retraction-target-not-approval` (the id
> matches some retraction's own `retractsApprovalId`) from a plain
> `retraction-target-missing`. If you need stricter self-reference detection, give
> retraction rows a synthetic id and compare; the codes above are the contract.

Call it in `validateApprovalsAndCheckpoint` after the partition (Task 2):

```ts
  const retractedApprovalIds = computeRetractedApprovalIds(approvals, retractionRows, registryByVersion, issues);
```

(`registryByVersion` is a parameter of `validateApprovalsAndCheckpoint` — `ReadonlyMap<string, ParsedArtifact>`, validator.ts:1170 — so it is in scope at the top of the function where the partition and this call live. `approvals` here is `ledgerData.data.approvals` (now `LedgerRowT[]`, the full mixed list — correct, the function needs all rows for ordering).)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/readiness/ -t "retraction validity"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/readiness/validator.ts src/readiness/*.test.ts
git commit -m "feat(readiness): validate retraction records (authorization, ordering, self/dup)"
```

---

### Task 4: Effective-set exclusion + gated suppression + Model B

**Files:**
- Modify: `src/readiness/validator.ts` (`activeApprovals` 1381; `ledger-supersession-not-later` 1338-1353; `verifyApprovalArtifactTimestamps`)
- Test: readiness validator test file

**Interfaces:**
- Consumes: `retractedApprovalIds` (Task 3).
- Produces: retracted approvals excluded from `activeApprovals`; the two temporal findings suppressed for validly-retracted approvals; Model-B invariant (no resurrection).

- [ ] **Step 1: Write the failing tests**

Add `describe("retraction effect on closure")`:
- **valid path:** an in-memory ledger equal to v5's approvals + two valid retractions of the two v2 ids → assert NO `ledger-supersession-not-later` and NO `approved-artifact-created-after-decision` issue remains; the two ids are absent from the active set; `checkpointStatus.C2 === "open"` (never "closed").
- **fail-closed:** the same but with an unauthorized retractor → both temporal findings STILL present; `ok: false`.
- **Model B:** a ledger with `A` then `B supersedes A` then a valid retraction of `B` → `A` is NOT in the active set (stays superseded); assert via a probe (e.g. no closure attributed to `A`, and a helper/exported check or an issue asserting A inactive).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/readiness/ -t "retraction effect"`
Expected: FAIL — findings still fire / ids still active.

- [ ] **Step 3: Exclude retracted from the effective set (1381)**

```ts
  const activeApprovals = approvalRows.filter(
    (approval) => !supersededApprovalIds.has(approval.approvalId) && !retractedApprovalIds.has(approval.approvalId),
  );
```

Model B needs no code: `supersededApprovalIds` is computed from the superseding approval's `supersedesApprovalId` (Task 2 keeps that over `approvalRows`), and retracting the superseder does NOT remove its `supersedesApprovalId` contribution — the predecessor stays superseded. Add a comment at `supersededApprovalIds` stating this is intentional (a retracted superseder still suppresses its predecessor; retraction only removes, never resurrects).

- [ ] **Step 4: Gate the two temporal findings on non-retraction**

At the `ledger-supersession-not-later` push (1345-1352), wrap:

```ts
        if (!retractedApprovalIds.has(approval.approvalId)) {
          issues.push({ code: "ledger-supersession-not-later", artifactId: approval.approvalId, message: /* unchanged */ });
          noteApprovalIssue(approval.approvalId, "ledger-supersession-not-later");
        }
```

Thread `retractedApprovalIds` into `verifyApprovalArtifactTimestamps` (add a param) and, at its `approved-artifact-created-after-decision` push, skip when `retractedApprovalIds.has(approval.approvalId)`. Keep both invariants otherwise UNCHANGED and unconditional (still fire for every non-retracted approval, superseded or not).

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/readiness/ -t "retraction effect"`
Expected: PASS.

- [ ] **Step 6: Neuter-and-restore each guard (fail-closed proof)**

For each guard, temporarily break it, confirm a specific test fails, restore:
1. Remove the `!retractedApprovalIds.has(...)` gate on `ledger-supersession-not-later` → the valid-path test still fails? (No — it would still fire.) Instead: temporarily make `computeRetractedApprovalIds` return the id for an UNAUTHORIZED retractor → the fail-closed test must go green-when-it-should-be-red, i.e. the unauthorized test FAILS. Restore.
2. Remove the exclusion at 1381 → the "ids absent from active set" assertion fails. Restore.
Record each red result in the task notes.

- [ ] **Step 7: Full readiness suite + typecheck + commit**

```bash
npx vitest run src/readiness/
npx tsc --noEmit
git add src/readiness/validator.ts src/readiness/*.test.ts
git commit -m "feat(readiness): retraction excludes from closure + gates temporal findings (fail-closed, Model B)"
```

---

### Task 5: v6 ledger + pin

**Files:**
- Create: `quality-contracts/agent-readiness/checkpoint-approvals-v6.json`
- Modify: `src/readiness/ledger-pins.ts` (`TRACKED_LEDGER_APPROVAL_PINS`)
- Test: `src/readiness/tracked-artifacts-readiness.test.ts`

- [ ] **Step 1: Build v6 from v5 (prefix unchanged + two retractions)**

Run this exact script (computes the honest predecessor hash and stamps a real UTC time):

```bash
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const AR = "quality-contracts/agent-readiness";
const v5raw = readFileSync(`${AR}/checkpoint-approvals-v5.json`);
const v5 = JSON.parse(v5raw.toString("utf-8"));
const predSha = createHash("sha256").update(v5raw).digest("hex"); // = predecessor.sha256 (file bytes)
const now = new Date().toISOString();
const reason = "decidedAt copied from the v1 predecessor predates the bound target cf55fee0 (first present 2026-07-28); withdrawn by the repository owner on 2026-07-28. No reviewer decision on cf55fee0 exists.";
// The retractor is the human Repository Maintainer. Reuse the C0 approval's OWN
// verified registry binding (actor repo-maintainer-1, registry 1.0, its recorded
// sha256) — this is the registry version where repo-maintainer-1 holds the
// Repository Maintainer role, and reusing the recorded digest guarantees the
// retraction resolves as authorized. (VERIFIED against v5: c0-repo-maintainer =
// {actorId: repo-maintainer-1, actorKind: human, actorRegistryVersion: "1.0",
// actorRegistrySha256: 7e849be131f34928e8191bea8ebefe5fb8e690a7e9f64b103e434767acafa45d}.)
const maintainer = v5.approvals.find(a => a.approvalId === "c0-repo-maintainer");
const retractedBy = {
  actorId: maintainer.actorId,            // "repo-maintainer-1"
  role: "Repository Maintainer",
  actorKind: "human",
  actorRegistryVersion: maintainer.actorRegistryVersion,   // "1.0"
  actorRegistrySha256: maintainer.actorRegistrySha256,     // 7e849be…
};
const v6 = {
  ...v5,
  artifactId: "approvals-c2-v6",
  createdAt: now,
  ordinalVersion: 6,
  predecessor: { version: "5", sha256: predSha },
  approvals: [
    ...v5.approvals, // UNCHANGED PREFIX
    { recordKind: "retraction", retractionId: "retraction-c2-gold-v2", retractsApprovalId: "c2-gold-reviewer-gold-v2", retractedBy, retractedAt: now, reason },
    { recordKind: "retraction", retractionId: "retraction-c2-qa-v2", retractsApprovalId: "c2-qa-reviewer-qa-v2", retractedBy, retractedAt: now, reason },
  ],
};
writeFileSync(`${AR}/checkpoint-approvals-v6.json`, JSON.stringify(v6, null, 2) + "\n");
console.log("wrote v6; predecessor.sha256 =", predSha);
EOF
```

> The `retractedBy` binding is taken directly from the C0 approval
> (`c0-repo-maintainer`), so it is guaranteed to resolve as an authorized human
> `Repository Maintainer` (registry `1.0`) — no invented actor. After writing,
> the Step-1 validity path (Task 4 valid-path test / Task 6 gate) confirms the
> retraction is NOT flagged `retraction-unauthorized`.

- [ ] **Step 2: Compute the v6 pin and add it**

```bash
node --input-type=module <<'EOF'
import { ledgerApprovalRowsDigest } from "./dist/readiness/ledger-pins.js";
import { readFileSync } from "node:fs";
const v6 = JSON.parse(readFileSync("quality-contracts/agent-readiness/checkpoint-approvals-v6.json","utf-8"));
console.log(ledgerApprovalRowsDigest(v6.approvals));
EOF
```

(Build first if `dist/` is stale: `npm run build`.) Add the printed digest to `TRACKED_LEDGER_APPROVAL_PINS` in `src/readiness/ledger-pins.ts`, leaving every existing entry in place:

```ts
  "checkpoint-approvals-v6.json":
    "<printed digest>",
```

- [ ] **Step 3: Write the append-only / pin test**

In `tracked-artifacts-readiness.test.ts`:
- v6's approvals prefix equals v5's approvals; `validateLedgerAppendOnly(v6, v5)` reports no `ledger-approval-deleted`/`-mutated`.
- `ledgerApprovalRowsDigest(v6.approvals)` equals the v6 pin table entry.
- **Correct control (reviewer [P3]):** the v6 **path-keyed pin** is what guards a newly-appended retraction — `validateLedgerAppendOnly` only guards v6's rows once v6 has a *successor*. So assert against the PIN: `ledgerApprovalRowsDigest(v6WithReasonMutated.approvals) !== pinEntry` AND `ledgerApprovalRowsDigest(v6WithRetractionDropped.approvals) !== pinEntry`. Do NOT assert append-only catches the drop.
- Digest stability: `ledgerApprovalRowsDigest(v5.approvals)` still equals the existing v5 pin entry (unchanged by the schema migration).

- [ ] **Step 4: Verify byte-identical history**

Run: `git diff --stat origin/main -- quality-contracts/agent-readiness/checkpoint-approvals-v5.json`
Expected: EMPTY (v5 untouched). Repeat for v1–v4.

- [ ] **Step 5: Run + commit**

```bash
npx vitest run src/readiness/tracked-artifacts-readiness.test.ts
git add quality-contracts/agent-readiness/checkpoint-approvals-v6.json src/readiness/ledger-pins.ts src/readiness/tracked-artifacts-readiness.test.ts
git commit -m "feat(readiness): append v6 ledger retracting the two defective C2 v2 approvals + pin"
```

---

### Task 6: End-to-end gate, clean-checkout verification, docs

**Files:**
- Modify: `docs/AGENT_READINESS_STATUS.md`, `docs/c2/c2-checkpoint-approval-handoff.md`, `TODOS.md`

- [ ] **Step 1: Real-artifact gate — private mode**

```bash
npm run build
npm run validate-readiness-artifacts -- --mode private --json
```

Expected: `ok: true`; `checkpointStatus` `{C0: closed, C1: closed, C2: open, C3..C5: open}`; the two `ledger-supersession-not-later` and the `approved-artifact-created-after-decision` findings on the v2 ids are GONE; no `retraction-*` finding; `ledgerPinScope: tracked`; empty stderr.

- [ ] **Step 2: Public mode**

```bash
npm run validate-readiness-artifacts -- --mode public --json
```

Expected: consistent (C2 open), no new blocking issue.

- [ ] **Step 3: Clean-checkout worktree comparison (per repo memory)**

Compare `origin/main` vs `HEAD` in two throwaway worktrees, each running `npx tsc` inside itself, private mode. `origin/main`: `{C2 open}` with the two temporal findings PRESENT (defect unrecorded). `HEAD`: `{C2 open}` with those findings ABSENT and no `retraction-*` finding. Empty stderr both (pins in force — a `notice:` line means pins were not engaged). Record both gate outputs in the task notes.

- [ ] **Step 4: Add a test that pins the real gate result**

In `tracked-artifacts-readiness.test.ts`, assert the real tracked artifacts validate to C2 open with the two v2 temporal findings absent and no `retraction-*` issue (read-only; the guard that catches drift like the earlier governance-data failures).

- [ ] **Step 5: Docs**

- `docs/AGENT_READINESS_STATUS.md` C2 row: "Open — the two v2 approvals are recorded-retracted (v6); C2 closes when the real Gold Label Owner and QA reviewers approve cf55fee0."
- `docs/c2/c2-checkpoint-approval-handoff.md`: replace the "withdrawal implied by a blocking invariant" paragraph with the recorded-retraction state (name v6 and the two retraction records).
- `TODOS.md`: delete the "Approval retraction vocabulary" section (delivered); if the section cross-references others, leave those intact.

- [ ] **Step 6: Full suite + commit**

```bash
npm test
git add docs/AGENT_READINESS_STATUS.md docs/c2/c2-checkpoint-approval-handoff.md TODOS.md src/readiness/tracked-artifacts-readiness.test.ts
git commit -m "docs(readiness): record C2 retraction state; strike delivered TODO; pin real gate result"
```

---

## Self-review (author checklist — done)

- **Spec coverage:** schema via `z.union`, digest-stable (T1), consumer split (T2), validity rules incl. ordering/self/dup (T3), effective-set exclusion + gated suppression + Model B (T4), v6 ledger+pin (T5), fail-closed proof via neuter-and-restore (T4.6), legacy-parse + append-only/pin tests (T1/T5), clean-checkout gate + docs + TODO strike (T6). No fabrication; C2 open. All spec sections map to a task.
- **Correction vs spec:** ledgers are NOT in the artifact index (verified) — T5 adds file+pin+chain only, no index entry. Noted in anchors.
- **Placeholder scan:** the only computed values (v6 predecessor hash, v6 pin digest, the maintainer actorId) are produced by exact scripts/greps at implementation time, not guessed — this is deliberate (do not hardcode a fabricated hash).
- **Type consistency:** `LedgerRowT`, `isApprovalRow`/`isRetractionRow`, `computeRetractedApprovalIds`, `retractedApprovalIds`, `approvalRows` used consistently across tasks; new issue codes fixed (`retraction-unauthorized|target-missing|out-of-order|target-not-approval|duplicate`).
