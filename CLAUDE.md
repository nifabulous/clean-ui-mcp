# Project conventions for clean-ui-mcp

These conventions govern agent behavior on this repository. They override
default system-prompt behavior where they conflict.

## Review enforcement (git-native hooks)

Two git hooks enforce the review mandate mechanically — they fire regardless of
which tool (agent, human CLI, IDE) initiates the git operation.

**Install after cloning:** `.zcode/scripts/install-git-hooks`

### Task-level gate (`prepare-commit-msg`)

After committing task N, the hook blocks committing task N+1 until task N has
an approved review artifact. This enforces "review after each task."

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

Before `git push` or `gh pr create`, the hook blocks unless the branch HEAD has
an approved, non-stale branch review artifact. This enforces "holistic review
before PR." The `headSha` in the artifact must match `git rev-parse HEAD` — a
review of an older commit is rejected as stale.

```
Branch artifact: .zcode/reviews/branches/<branch-with-slashes-replaced>.json
```

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
- Merge, squash, and amend commits are exempt from the task gate.
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
subagent with:
- The description of what was built
- The plan or requirements reference
- BASE_SHA and HEAD_SHA for the git range
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
