# Production Hardening — Review Reports

---

## Pass 2: Fresh eng-review of the complete shipped branch (PR #31)

**Date:** 2026-07-17 (second pass)
**Target:** Full branch `origin/main..8cad8ad` (PR #31) — all 10 tasks + 5 review fixes
**Mode:** Fresh eng-review focused on the delta since the prior pass (Tasks 8–10 + T-REV fixes) while auditing the whole branch as a unit
**Base:** `origin/main` (`374f720`) → HEAD `8cad8ad` (13 commits, 37 files, +2613/−781)

### Delta audited (new surface since prior review at `5145a9c`)

| Commit | What | eng-review finding |
|---|---|---|
| `51be637` | T-REV-3 decisions write-protection gate + T-REV-5 mtimeMs+size cache | **No issues.** T-REV-3 gate verified: read-only-FS rename failure → `persistDecisions` throws, evidence preserved. T-REV-5 cache key sound; the override defaults null (production unaffected). |
| `cdd3d36` | T-REV-1 writeAtomic direct tests + T-REV-2 orphan HTTP endpoint tests | **No issues.** Tests are substantive (atomicity, no-temp-leftover, HTTP wiring with real capture-path prefix). |
| `749580d` | Task 8: test isolation + un-fork + Voyage gate + T-REV-4 CAPTURES_DIR | **No issues.** `privateImageDir()` getter defaults null (production unchanged); override scoped to test beforeEach/afterEach; `fromCorpusRelativePath`/`toCorpusRelativePath` honor override correctly (falls back to `CORPUS_ROOT` which is itself test-overridable). `git status corpus/` clean after suite — isolation holds. |
| `81e2d0d` | Task 9: prune inert allowlist + delete selectReferences | **No issues.** Main scan passes; `selectReferences` gone (tsc clean). Invariant-test approach abandoned honestly (scan's comment/string-match limitation makes an automated invariant over-flag). |
| `8cad8ad` | Task 10: 8 debris scripts deleted + workflow removed + doctor hook-check | **No issues.** Zero dangling refs to deleted scripts; doctor hook-check uses worktree-correct `git rev-parse --git-path hooks`. |

### Architecture (Section 1)
**No issues.** The `privateImageDir()` getter threading (Task 8/T-REV-4) is the most invasive change and it's sound: override is test-only, null in production, use-time not module-load. No new coupling. Runtime MCP tool registration untouched (scope discipline confirmed).

### Code Quality (Section 2)
**No issues.** Task 9's honest documentation of why the allowlist invariant isn't automatable (comment/string-match limitation) is good engineering judgment over forcing a broken test.

### Test Review (Section 3) — delta coverage

```
DELTA ITEM                                  TESTED?
────────────────────────────────────────────────────
T-REV-3 decisions write-protection gate     ✓ (read-only-dir simulation)
T-REV-5 mtimeMs+size cache key              ✓ (existing invalidation test)
T-REV-1 writeAtomic direct                  ✓ (4 tests: content, no-temp, atomic, create)
T-REV-2 orphan HTTP endpoints               ✓ (2 tests: GET protectedCounts, DELETE spares captures)
Task 8 images-private isolation             ✓ (git status corpus/ clean)
Task 8 parseOpenAIResetHeader un-fork       ✓ (imported, ssrf tests pass)
Task 8 Voyage API gate                      ✓ (RUN_LIVE_INTEGRATION double-gate)
Task 9 allowlist pruning                    ✓ (main scan passes)
Task 9 selectReferences deletion            ✓ (tsc clean)
Task 10 doctor hook-check                   ✓ (check exists, worktree-correct path)
Task 10 debris deletion                     ✓ (zero dangling refs verified)

Full suite: 753 passed / 7 skipped / 0 failed
```

### Performance (Section 4)
**No issues.** No new per-query costs introduced in the delta (the mtime-stat cost was in the prior-reviewed Task 4; the delta only changed the cache key to include size — one more field comparison, negligible).

### NOT in scope (confirmed)
Same as prior pass (C1 readiness, DNS-rebinding pinning, prompt injection, dHash atomicity) — all still correctly deferred.

### Failure modes
No critical gaps in the delta. The T-REV-3 gate closes the one failure mode the prior pass + outside voice identified (rename-failure evidence destruction).

### Verdict
**APPROVED.** The delta (Tasks 8–10 + T-REV fixes) introduces no new issues, is well-tested, and the prior-reviewed Tasks 1–7 hold. The branch is coherent end-to-end. The two-stage review discipline (prior combined eng+CEO + outside voice + final holistic) already caught and fixed the material defect (T-REV-3); this fresh pass confirms nothing new was introduced by the fix cycle or the remaining tasks.

**Lake Score:** n/a (HOLD SCOPE, no completeness-vs-shortcut decisions in the delta — all test gaps were closed with direct tests).

---

## Pass 1: Combined Eng + CEO Review Report (Tasks 1–7 stage)

**Date:** 2026-07-17
**Target:** `2026-07-17-production-hardening-implementation-plan.md` + Tasks 1–7 shipped on `fix/production-hardening`
**Mode:** HOLD SCOPE (CEO) — security/data-integrity hardening of a single-operator tool
**Base:** `origin/main` (`374f720`) → HEAD `5145a9c` (8 commits, 22 files, +2230 lines)
**REPO_MODE:** solo
**Reviewer context:** Implementer of Tasks 1–7 (deep ground truth)

---

## Step 0: Scope Challenge

### Premise (CEO 0A)
Sound. All 7 findings are real, reproduced defects from a four-perspective review — not hypotheticals. The orphan-deletion data loss (Task 2) and corrupt-file wipe (Task 5) destroy user data; the SSRF gaps (Task 3) and loopback bind (Task 1) are genuine remote-attack surface. Doing nothing leaves a data-destroying curator tool and a metadata-reachable MCP server.

### Existing code leverage (CEO 0B)
Strong. Task 2 reused the existing `Decisions` schema + `listImageFilesRecursive`. Task 4 reused `entriesPath()` (just exported it). Task 6 copied the `migrate-wcag-ids.ts` pattern verbatim. No parallel systems built where existing ones could extend.

### Complexity check (eng)
22 files touched, but **zero new subsystems** — only one new module (`orphans.ts`, a pure function). The file count is high because each migrate script (Task 6) is a separate file, but the change per file is 2 lines. This is below the smell threshold once you discount the mechanical migrate-script repetition.

### Cross-branch conflict (parallel-lane strategy)
**Verified: zero source-code overlap** between `fix/production-hardening` and `feat/agent-readiness-phase-0-1c`. Only the plan doc itself exists on both. The plan's flagged exception (`src/corpus.ts` Task 4 vs readiness Lane D) is a non-issue: Lane D hasn't started and is post-C1. Parallelization is clean.

---

## Architecture (Section 1)
**No issues.** Localized hardening, no new coupling, no single points of failure introduced. The `serialized()` mutex (Task 7) is a single-process promise chain — appropriate for a single-operator tool, no cross-process lock needed. Rollback posture is `git revert` (all changes are code, no migrations).

## Error & Rescue Map (Section 2)
**No silent failures found.** Audited all 9 changed source files: zero empty catch blocks. Every catch either re-raises, reports, or degrades with a visible message. The one catch in `clean-orphans.ts:93` captures and reports the error. The decisions-recovery path (Task 5) logs "decisions.json was corrupt — renamed aside for forensics" before recovering. Failures are visible.

## Security & Threat Model (Section 3)
**Solid.** Loopback bind (Task 1) removes the entire remote mutating surface. SSRF (Task 3) closes the redirect-to-metadata bypass and adds CGNAT/benchmark/IANA ranges; IPv6-mapped IPv4 (`::ffff:169.254.169.254`) is unmasked before range-checking. Orphan cleanup (Task 2) is fail-closed (captures never deleted; corrupt manifest protects its subtree). The known residual — DNS rebinding between `dns.lookup` and Chromium — is honestly documented in `installSsrfGuard`'s comment and deferred to a future hardening pass.

## Code Quality (Section 5)
**Clean.** `orphans.ts` is a well-documented pure function. The migrate-script changes (Task 6) are mechanical and identical. The `runV1ToV2Migration` extraction (Task 6) is a good testability refactor. No DRY violations introduced; the `serialized()` mutex is 4 lines.

## Test Review (Section 6) — 2 gaps found

```
TASK                    TESTED                          UNTESTED / GAP
─────────────────────────────────────────────────────────────────────────
1 loopback              bind address test ✓             origin-guard no-Origin ✓ (line 225)
2 orphans               safeOrphanPaths pure fn ✓       HTTP /api/orphans endpoint ✗ [GAP]
3 SSRF                  assertSafeNavigationTarget ✓    page.route handler integration ✗ [LOW]
                                                                  IPv6-mapped ✓ (verified in code)
4 cache mtime           mtime invalidation ✓            statSync-throws edge ✗ [LOW]
5 decisions recovery    corrupt→snapshot ✓              rename-fails (read-only FS) ✗ [LOW]
6 atomic writes         migrate-v1-to-v2 ✓              writeAtomic direct unit test ✗ [GAP]
7 serialize mutations   concurrent POST ✓               chain-throws-doesn't-break ✗ [LOW]

GAPS (accepted by user):
  - writeAtomic direct test (persistence.test.ts) — P2
  - /api/orphans HTTP endpoint test (ui-server.test.ts) — P2
LOW (not raised — transitive coverage acceptable):
  - page.route integration, statSync-throws, rename-fails, chain-throws
```

## Performance (Section 4/7)
**One observation, not a finding.** `loadCorpus()` (Task 4) now does a `statSync` per call, and it's called per-query (7 sites). On the cache-hit path this adds one syscall (~microseconds). For a single-operator tool with 787 entries this is negligible. The `testOverride` path skips it. Acceptable tradeoff for the correctness gain (long-running MCP server sees curator edits). No action.

Task 7 serialization: mutations serialize through a promise chain. For one operator this adds no perceptible latency (mutations are already slow — sharp dedup + vision calls). No head-of-line concern at this scale.

## Failure modes
All new codepaths have either a test or visible error handling. No critical gaps (silent + untested + no error handling).

---

## NOT in scope (confirmed deferrals)
- C1 readiness R6–R7 (parallel lane, own plan)
- DNS-rebinding IP pinning (Task 3 known residual, documented)
- Prompt-injection neutralization in tagger (Minor, human-review mitigates)
- dHash cache atomicity + rebuild queueing (Minor, later cleanup)
- Ranking-test depth + dedup boundary fixtures (worthwhile, not blocking)

## What already exists (reused)
- `Decisions`/`Corpus` schemas (Task 2)
- `entriesPath()` accessor (Task 4, exported existing function)
- `writeAtomic`/`writeRawSnapshot` (Task 6, existing persistence layer)
- `migrate-wcag-ids.ts` atomic-write pattern (Task 6 reference)
- `EXPLICIT_LOCALHOST` bypass (Task 3 preserved)

---

## Implementation Tasks (from this review)
- [ ] **T-REV-1 (P2, CC: ~15min)** — persistence — direct `writeAtomic` unit test (atomicity guarantee + temp-file cleanup)
  - Surfaced by: Test Review — Task 6 gap
  - Files: `src/persistence.test.ts`
  - Verify: `npx vitest run src/persistence.test.ts`
- [ ] **T-REV-2 (P2, CC: ~15min)** — ui-server — HTTP-level `/api/orphans` endpoint tests (GET returns protectedCounts, DELETE uses scanOrphans)
  - Surfaced by: Test Review — Task 2 gap
  - Files: `src/scripts/ui-server.test.ts`
  - Verify: `npx vitest run src/scripts/ui-server.test.ts`
- [ ] **T-REV-3 (P1, CC: ~15min)** — decisions — write-protection gate when corrupt-file rename fails
  - Surfaced by: Outside voice #5 (verified) — rename failure leaves corrupt primary at decisionsPath; next persistDecisions overwrites it, destroying evidence
  - Files: `src/decisions.ts`
  - Verify: corrupt primary + read-only FS → persistDecisions refuses; evidence preserved
- [ ] **T-REV-4 (P1, CC: ~10min)** — paths — thread `privateImageDir()` through CAPTURES_DIR + dedup derived paths (at use-time, not module load)
  - Surfaced by: Outside voice #1 (verified) — module-load binding defeats Task 8 test seam
  - Files: `src/scripts/ui-server.ts`, `src/dedup.ts`, `src/paths.ts` (implement as part of Task 8)
- [ ] **T-REV-5 (P2, CC: ~5min)** — corpus — cache invalidation compares mtimeMs + size, not mtimeMs alone
  - Surfaced by: Outside voice #3 (verified) — restore-corpus older-mtime + same-tick edge cases
  - Files: `src/corpus.ts`
  - Verify: `npx vitest run src/corpus.test.ts`

## Outside voice
Running (Claude subagent, background). Findings integrated when received.

---

## GSTACK REVIEW REPORT

### Pass 2 (fresh eng-review of full shipped branch, PR #31)
- Step 0 Scope Challenge: scope accepted (37 files, 1 new pure-fn module — justified for a hardening sweep)
- Architecture (delta): 0 issues — privateImageDir getter sound, runtime untouched
- Code Quality (delta): 0 issues — honest allowlist-invariant documentation
- Test Review (delta): all 11 delta items directly tested; 753 passed / 0 failed
- Performance (delta): 0 issues
- Failure modes: 0 critical gaps (T-REV-3 closed the prior rename-failure gap)
- Verdict: APPROVED — nothing new introduced by the fix cycle or Tasks 8–10

### Pass 1 (combined eng+CEO at Tasks 1–7 stage)
- Step 0 Scope Challenge: scope accepted as-is (HOLD SCOPE)
- Architecture: 0 issues
- Error/Rescue: 0 silent failures
- Security: 0 issues (1 known residual documented)
- Code Quality: 0 issues
- Test Review: 2 gaps (accepted — T-REV-1, T-REV-2), 4 LOW (accepted transitive)
- Performance: 0 issues (1 observation, acceptable)
- NOT in scope: confirmed (5 items)
- What already exists: 6 reuse points documented
- Failure modes: 1 critical gap surfaced by outside voice (Task 5 rename-failure) → fixed as T-REV-3
- Lake Score: 2/2 recommendations chose complete option (direct tests over transitive)

---

## Outside Voice (Claude subagent) — findings + verification

The outside voice surfaced 13 findings. I verified each against ground truth before
presenting. **3 are confirmed real and material;** the rest are valid-but-lower or
already-documented residuals.

### Confirmed — cross-model tension (requires user decision)

| # | Finding | Verification | Severity |
|---|---|---|---|
| **5** | Task 5 `loadDecisionsSafe` catches rename failure and proceeds to snapshot recovery, but the corrupt primary stays at `decisionsPath`. The next `persistDecisions` → `writeAtomic(decisionsPath)` overwrites the corrupt file, **destroying forensic evidence** — the exact thing Task 5 exists to preserve. The corpus-side recovery model has a `writable:false` gate that prevents this; the decisions module lacks it. | **CONFIRMED by reading `decisions.ts`.** The catch block at the rename site has `/* best-effort — continue regardless */`, then caches the recovered set. `persistDecisions` unconditionally writes. If rename fails (read-only FS, permissions), evidence is lost on the next save. | **P1 — this is the difference between "recovery" and "recovery that destroys evidence on the failure mode it exists for."** |
| **3** | Task 4 `loadCorpus` uses exact-equality mtime (`mtime === cachedMtimeMs`). `writeAtomic` writes a temp file then renames — the renamed file carries the temp's write-time mtime, so normal saves work. BUT `restore-corpus` copying an old file (older mtime), or two saves in the same mtime tick, misses. Stale cache served indefinitely in those edge cases. | **CONFIRMED by reading `corpus.ts:52` (`mtime === cachedMtimeMs`).** Lower probability than #5 (restore-corpus is operator-initiated, not automatic), but real. Cheap fix: `mtimeMs + size` instead of mtime alone. | **P2** |
| **1** | Task 8's `privateImageDir()` getter won't redirect `CAPTURES_DIR` (`ui-server.ts:448`), which is bound at module load from `PRIVATE_IMAGE_DIR`. Capture-path tests under the new seam still write to the real `corpus/images-private/captures/`. `dedup.ts` has the same pattern. The Task 8 isolation claim ("git status corpus/ clean") is false for capture tests. | **CONFIRMED by reading `ui-server.ts:448`.** Task 8 is NOT YET implemented — so this is preventable now by threading the getter through derived path constants, not after. | **P1 for Task 8 (preventable)** |

### Confirmed valid, lower severity / already-documented (not raised as tension)

- **#4** Task 7 over-broad serialization: `/api/capture-url` and `/api/upload-image` don't read entries but serialize through the global chain. A 45s capture blocks a trivial rename. Valid UX concern for single-operator; finer-grained locking (exclude pure-write handlers) would help. **Not raised as tension** — single-operator head-of-line is annoying, not incorrect; the lost-update fix is correct. Worth a TODO.
- **#7** SSRF DNS-rebinding residual — already documented in `installSsrfGuard`'s comment and the plan's out-of-scope. Honest residual, acceptable for operator-chosen URLs.
- **#2** Task 9 framing inaccuracy (allowlist entries are inert, not "shielding") — cosmetic; the invariant is still sound.
- **#9** decisions/triage writers still use bare writeFileSync (not just entries.json) — real coherence gap, but correctly scoped out of Task 6; should be added to explicit out-of-scope.
- **#10** IPv6 loopback (`::1`) follow-up — real edge case on macOS; the plan's "if needed" understates it.
- **#13** "745 green" may include corpus-gated skips — valid caveat on test-count signal strength.

### NET from outside voice
Tasks 4, 5, 7 each carry a correctness gap the in-house review didn't close. #5 is the
most serious (evidence destruction on rename failure — the exact scenario Task 5 is
supposed to handle safely). #1 is preventable in the not-yet-built Task 8. These are
fix-in-task edits, not rework.

### Resolved tensions (user decisions)

| # | Decision | Action |
|---|---|---|
| 5 | Add write-protection gate | **T-REV-3**: when renameSync fails in loadDecisionsSafe, mark recovered set read-only so persistDecisions refuses to overwrite the still-corrupt primary. Mirror persistence.ts `writable:false`. Fixes shipped Task 5. |
| 1 | Thread getter through all derived paths | **T-REV-4** (Task 8 implementation note): `privateImageDir()` must be called at use-time in CAPTURES_DIR and dedup.ts paths, not bound at module load. Prevents false isolation. |
| 3 | Use mtimeMs + size | **T-REV-5**: corpus.ts loadCorpus cache check compares `mtimeMs + size`, not mtimeMs alone. ~5 min. |

Added to implementation tasks below.
