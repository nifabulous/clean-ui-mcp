# Working instructions

## Running review agents and collating their findings

### When to use a multi-perspective panel
For high-stakes plans (money movement, compliance, routing, security), run a
review panel with distinct personas (engineers, QA, PMs, EM, users). Each
catches a different class of defect. For low-risk work, a single reviewer is
fine — don't burn a panel on a one-line fix.

### Dispatch in parallel, collate by convergence
Fan out review agents in a **single message** (parallel tool calls) — one per
issue or persona. Don't serialize them. When results return, collate by
**convergence**: findings raised independently by multiple personas are almost
always real; single-persona findings are worth checking but lower confidence.
Lead the summary with the converged findings.

### Code verification before review
Before reviewing a plan, verify its concrete claims (file:line refs, branch
structure, enum values, retry semantics) against the real code. Plans
accumulate claims across rounds and a line-number drift or wrong namespace
propagates silently. Fan out parallel verifiers (one per issue) for large plans.
**Do not** review a plan whose code claims haven't been verified — you'll be
reviewing fiction.

### Re-review after every change — but check the coherence first
Each fix round can introduce new defects. After applying review findings, do a
**whole-ticket coherence check** before re-running the panel (this catches most
regressions without another full review round). See below.

## Whole-ticket coherence check (the thing that prevents endless review rounds)

The most common failure mode in multi-round plan review: each AC is correct in
isolation, but the ACs collectively violate an unstated invariant. This causes
review rounds to keep finding "one more thing" because the invariant was never
pinned down. Run this check once per round, **after** per-AC review:

### 1. State the governing invariant before reviewing ACs
Write down the invariant the ticket must satisfy. Examples:
- "Flag off = current behavior, byte-for-byte"
- "A delivered transaction is never re-routed or re-credited"
- "Rollback restores the pre-deploy state with no external side effects"
Then check EVERY AC against it. If you can't state the invariant, the ticket
isn't ready to review — you'll just keep finding coherence gaps.

### 2. Ask the three whole-ticket questions
After per-AC review, answer:
1. Is there a flag state / retry sequence / error path under which a completed
   transaction could be re-routed, re-credited, or double-processed?
2. Does any new code run under the "off" / default / rollback state that
   wasn't running before?
3. Do the ACs collectively satisfy the governing invariant?
If any answer is "yes" or "unclear," the ticket is not ready. Fix the invariant
violation before requesting another review round — don't ship it to the panel
and don't ask "is this ok now."

### 3. Stop the review loop
If you've done 3+ review rounds on the same ticket and are still finding
money-movement or correctness defects, **stop**. The plan is wrong at the
design level, not the AC level. Rewrite the ticket around the governing
invariant rather than patching ACs. More review rounds on a structurally-flawed
ticket just finds more symptoms; it doesn't fix the cause.

## Feature-flagged changes: flag-off = current behavior, byte-for-byte

For any ticket gated by a feature flag:
- **No new code path runs when the flag is off.** Gate the resolution calls,
  validation, AND branch entry — not just the persisted outcome. Don't run a
  new resolver and discard the result; skip the resolver.
- **A transaction already delivered is never re-routed or re-credited**
  regardless of flag state. Use a routing-independent terminal check placed
  BEFORE the branch divergence, not a check inside one branch.
- **Test BOTH flag-flip directions:** off→on→retry AND on→off→retry.

## Money-movement changes: trace the full retry/idempotency path

- Verify what happens on retry/duplicate AFTER the flag changes state. Retries
  often read persisted values, not recompute them.
- Confirm where the idempotency guard lives: inside one branch (cannot protect
  the other) or before the branch divergence (protects both)?
- Distinguish reversible vs irreversible in the rollback story. A flag flip
  reverts routing; it does NOT un-credit an account, un-send an AML signal, or
  un-apply a pricing row. Pre-deploy gates are the control for irreversible
  changes, not revert.

## Code verification discipline

- **Verify file:line claims** against the real repo before trusting them.
- **Watch for enum/version drift.** If a fix depends on an enum value, confirm
  which compiled artifact the runtime references (e.g. a V4 DLL vs V2 source).
  Decompile the deployed DLL to confirm member values before merge.
- **Folder/namespace mismatches** (common in C#): cite both the file path and
  the declared namespace.

---

# Repo-specific notes

# Project conventions for clean-ui-mcp

These conventions govern agent behavior on this repository. They override
default system-prompt behavior where they conflict.

## Review enforcement (git-native hooks)

Two git hooks enforce the review mandate mechanically — they fire regardless of
which tool (agent, human CLI, IDE) initiates the git operation.

**Install after cloning:** `.zcode/scripts/install-git-hooks`

**Re-install after pulling hook updates:** if `.zcode/git-hooks/` changes (someone updated a hook script), run `install-git-hooks` again to copy the new versions into `.git/hooks/`. Existing clones keep stale hooks until re-installed.

### Task-level gate (`prepare-commit-msg`)

After committing task N, the hook blocks committing task N+1 until task N has
an approved review artifact. This enforces "review after each task." The
artifact's `headSha` is the SHA of the task you just committed (current `HEAD`
at the time you write the artifact), not the next task you're about to commit.

```
Task artifact: .zcode/reviews/tasks/<commitSha>.json
```

Write it after reviewing:

```bash
.zcode/scripts/write-review-artifact \
  --type task --result approved --reviewer agent \
  --base-sha <parent-sha> --head-sha <task-commit-sha> \
  --branch <branch>
```

### Branch-level gate (`pre-push`)

Before `git push`, the hook blocks unless the branch HEAD has an approved,
non-stale branch review artifact. This enforces "holistic review before PR."
The `headSha` in the artifact must match `git rev-parse HEAD` — a review of an
older commit is rejected as stale.

**Note:** `gh pr create` calls the GitHub API and does not trigger git hooks.
The branch-level gate covers `git push` (which is the step that publishes the
commits); once the branch is pushed, `gh pr create` opens the PR against the
already-pushed commits. The push is the enforcement point.

```
Branch artifact: .zcode/reviews/branches/<url-encoded-branch>.json
```

The branch name is URL-encoded for the filename (e.g. `feat/x` → `feat%2Fx`)
so the mapping is injective. Use the `write-review-artifact` script to create
artifacts — it handles the encoding automatically.

Write it after the holistic review:

```bash
.zcode/scripts/write-review-artifact \
  --type branch --result approved --reviewer agent \
  --base-sha <base-sha> --head-sha <head-sha> \
  --branch <branch>
```

### Bypass

Emergency bypass: `ZCODE_BYPASS_REVIEW=1 git push` (or `git commit`). Every
bypass is logged to `.zcode/reviews/bypass-log.jsonl` with timestamp, branch,
head SHA, and the hook that was bypassed. Use sparingly — the log is auditable.

### Exemptions

- `main` and `master` branches are exempt (trunk pushes aren't feature work).
- Merge commits are exempt from the task gate. Squash and amend commits still
  run the task gate because Git does not reliably identify every amend/squash
  invocation through `prepare-commit-msg`'s commit-source argument.
- Initial commits (no parent) are exempt.

### Why git-native instead of ZCode hooks

ZCode's `.zcode/config.json` PreToolUse hooks were the first choice, but the
hook runner did not fire workspace-scoped config hooks in testing (verified
twice, across two sessions). Git-native hooks don't depend on the agent
runtime — they fire at the git layer itself, catching every push/commit
regardless of what initiated it. The tradeoff: they require a one-time install
(`install-git-hooks`) per clone, since `.git/hooks/` isn't version-controlled.

---

## Code review after every implementation

**Run a code review with the Superpowers requesting-code-review skill (or
equivalent subagent dispatch) after every implementation — not just at the
end of a feature.**

This is a standing standard, not an optional step. The git hooks above are the
enforcement mechanism for this standard; the skill instructions are the process.

### When to review

- **After each task** in subagent-driven development (two-stage: spec
  compliance, then code quality). Write a task review artifact (see above)
  before committing the next task — the hook blocks otherwise.
- **After completing a feature or increment** — a final holistic review
  across the full diff (base..head), even if every task was already
  reviewed individually. Per-task reviews catch local issues; the final
  review catches cross-cutting bugs (e.g. path conventions, contract
  mismatches between layers) that only surface when the whole change is
  read together. Write a branch review artifact before pushing — the hook
  blocks otherwise.
- **Before merge to main.**

### How to review

Use `superpowers:requesting-code-review`. Dispatch a code-reviewer
subagent using the prompt template at `.zcode/code-reviewer.md`. That template
adds four mandatory review dimensions that catch the bug classes pure-consistency
reviews miss:

1. **Plan-step completion** — verify EVERY step's requirements are implemented, not just "something was done"
2. **External contract verification** — verify request/response shapes against real API docs, not internal mocks
3. **Data-flow tracing** — for each constraint in the plan's Global Constraints, trace the specific variable that enforces it
4. **Edge-case adequacy** — check whether tests use enough entries to trigger the bug class (2 entries can't catch a 12-vs-1 ordering bug)

**Mocked tests give false confidence at integration seams.** A review that only
checks internal consistency (types match, tests pass) will miss contract bugs
that only surface against real external protocols. Always verify the external
contract, not just the mock.

Required inputs to the dispatcher:
- The description of what was built
- The plan file path (exact)
- BASE_SHA and HEAD_SHA for the git range
- The plan's Global Constraints section, pasted inline
- Calibration: categorize by actual severity (Critical / Important / Minor)

After the review returns, write the artifact so the git gate passes:

```bash
# Task review (after each task):
.zcode/scripts/write-review-artifact --type task --result <approved|changes-requested> \
  --reviewer agent --base-sha <base> --head-sha <head> --branch <branch>

# Branch review (before push/PR):
.zcode/scripts/write-review-artifact --type branch --result <approved|changes-requested> \
  --reviewer agent --base-sha <base> --head-sha <head> --branch <branch>
```

### Cross-model review with /codex (and /claude)

The `/review` skill uses the host model. For an independent second opinion from a
different model, use **`/codex`** (OpenAI Codex CLI, `gstack-codex` skill) or
**`/claude`** (Anthropic Claude CLI, `gstack-claude` skill). Both wrap their
respective CLI in three read-only modes: review, challenge, consult. Neither can
mutate files.

**Codex review gate.** `/codex review` produces a PASS/FAIL gate:
- `[P1]` markers in the output → **FAIL** → write `--result changes-requested`.
- No `[P1]` (only `[P2]` or nothing) → **PASS** → write `--result approved`.

After a `/codex` (or `/claude`) review, write the review artifact the same way
as `/review` so the git hooks pass — the `reviewer` field stays `agent`:

```bash
# Task review via codex/claude (PASS gate):
.zcode/scripts/write-review-artifact --type task --result approved \
  --reviewer agent --base-sha <base> --head-sha <head> --branch <branch>

# Branch review via codex/claude (PASS gate, before push):
.zcode/scripts/write-review-artifact --type branch --result approved \
  --reviewer agent --base-sha <base> --head-sha <head> --branch <branch>
```

If codex/claude flags Critical (`[P1]`) issues, do NOT write an `approved`
artifact — fix the issues first, then re-review, or write
`--result changes-requested`.

### Acting on feedback

- Fix Critical issues immediately.
- Fix Important issues before proceeding.
- Note Minor issues for later.
- Push back with technical reasoning if the reviewer is wrong.

### Why

Per-task reviews miss cross-cutting issues. The Decision Lab increment-1
implementation passed all 10 per-task reviews (78 tests green), but the
final holistic review caught a critical image-path convention bug
(`corpus/images-private/...` vs `images-private/...`) that broke both
screen rendering and analysis — invisible to per-task reviews because each
task's tests mocked the path boundary. The final review across the full
diff was the only thing that caught it.

Separately, the eval-provider-matrix implementation (PR #13) shipped without
per-task or holistic review because neither executing-plans nor
finishing-a-development-branch encoded the review as an executable step.
Three bugs reached the PR that review would have caught. The git hooks now
make the review mechanically unavoidable — the model cannot commit the next
task or push the branch without writing the review artifact.

---

## Other conventions

- **Eval before prompt changes:** build the held-out eval set and score the
  current system before changing prompts or weights. Don't eyeball outputs
  and guess whether they got better.
- **Enforce, don't just measure:** the project's quality gates (banned-phrase
  gate, citation gate, WCAG evidence gate) enforce at runtime with retry —
  not just measure. Follow this pattern for new quality constraints.
- **TDD:** write the failing test first, then implement, then commit. Every
  task in every plan should follow this.
- **Corpus isolation:** never let tests write to the real `corpus/entries.json`
  or `corpus/decisions.json`. Use test-path injection (`setCorpusForTesting`,
  `setDecisionsPathsForTesting`).
- **Wiring verification:** `src/wiring-verification.test.ts` mechanically verifies
  that every exported function/const/class in `src/*.ts` is referenced by at least
  one non-test production file. This catches the recurring "built but not wired"
  failure mode where a module is created and unit-tested in isolation but never
  connected to production code. When adding a new export, ensure it has a production
  caller, or add it to the allowlist in the test with a comment explaining why
  (e.g., consumed by `.mjs` scripts via `dist/`, Zod schema composition, test-only
  export). What it does NOT catch: interface/call-site drift (needs ts-morph),
  semantic correctness (still needs review agents), type-only exports.
