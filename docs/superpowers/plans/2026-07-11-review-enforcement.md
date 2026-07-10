# Review Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local review-enforcement hooks, review-artifact writers, and workflow documentation so task-level review and branch-level review are both mechanically required before shipping.

**Architecture:** Use two local hook gates plus one shared artifact writer. Task reviews are stored per commit under `.zcode/reviews/tasks/`, branch reviews are stored per branch under `.zcode/reviews/branches/`, and Bash PreToolUse hooks check those artifacts before allowing the next task commit or any push / PR creation. Documentation then explains the policy and the emergency bypass.

**Tech Stack:** shell hooks under `.zcode/`, JSON sidecar artifacts, repo docs in `CLAUDE.md`, gitignore updates, existing plan workflow under `docs/superpowers/plans/`.

## Global Constraints

- Enforce two separate policies: review after each task commit, and holistic review before push / PR.
- Do not use fake passthrough CLI flags like `git push --no-review-required`; bypasses must use an out-of-band mechanism.
- Review artifacts are local machine state and must stay gitignored.
- The hook layer must have a guaranteed artifact producer; do not rely on “the model should remember.”
- If repo-scoped `.zcode/config.json` hook loading does not work, stop after Task 1 and switch to a documented fallback design instead of building the rest on a broken assumption.
- Do not change application code in `src/` or product behavior; this milestone is tooling and workflow only.

---

## File Structure

- Create: `.zcode/config.json` — repo-scoped hook registration
- Create: `.zcode/hooks/require-review-before-commit` — blocks a new task commit when the previous task commit lacks a task-review artifact
- Create: `.zcode/hooks/require-review-before-push` — blocks `git push` / `gh pr create` when the branch head lacks a branch-review artifact
- Create: `.zcode/scripts/write-review-artifact` — single artifact writer for task and branch review records
- Create: `.zcode/scripts/read-hook-command` — helper that extracts `tool_input.command` from hook stdin JSON
- Create: `.zcode/scripts/current-review-state` — helper that resolves branch name, head SHA, and expected artifact paths
- Create: `CLAUDE.md` — project-level workflow rules, hook explanation, and bypass guidance
- Modify: `.gitignore` — ignore `.zcode/reviews/`
- Modify: `docs/superpowers/plans/2026-07-11-review-enforcement.md` only if the hook-loading proof in Task 1 changes the design

### Task 1: Prove Repo-Scoped Hook Loading Before Building On It

**Files:**
- Create: `.zcode/config.json`
- Create: `.zcode/hooks/probe-hook`

**Interfaces:**
- Consumes: local ZCode hook loader behavior
- Produces:
  - repo-scoped Bash `PreToolUse` hook registration
  - probe script that writes a timestamped marker file

- [ ] **Step 1: Write the probe hook config**

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Bash",
          "hooks": [
            {
              "type": "command",
              "command": "${ZCODE_PROJECT_DIR}/.zcode/hooks/probe-hook",
              "timeout": 5
            }
          ]
        }
      ]
    }
  }
}
```

- [ ] **Step 2: Write the probe script**

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="${ZCODE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
mkdir -p "$ROOT/.zcode/tmp"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$ROOT/.zcode/tmp/probe-hook-fired"
cat >/dev/null
```

- [ ] **Step 3: Run the hook-loading proof**

Run one harmless Bash tool action in the repo, then check:

Run: `test -f .zcode/tmp/probe-hook-fired && cat .zcode/tmp/probe-hook-fired`
Expected: a UTC timestamp is present, proving the repo-scoped hook fired

- [ ] **Step 4: Stop if the assumption is false**

If `.zcode/tmp/probe-hook-fired` is absent, do not continue with Tasks 2-5. Replace this plan with a fallback design that uses a checked-in wrapper script or documented manual gate instead of `.zcode/config.json`.

- [ ] **Step 5: Commit**

```bash
git add .zcode/config.json .zcode/hooks/probe-hook
git commit -m "chore(review): prove repo-scoped zcode hooks load"
```

### Task 2: Add Shared Review Artifact Utilities

**Files:**
- Create: `.zcode/scripts/read-hook-command`
- Create: `.zcode/scripts/current-review-state`
- Create: `.zcode/scripts/write-review-artifact`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: git branch / commit state, hook stdin JSON
- Produces:
  - `read-hook-command` → prints the Bash command string from hook stdin JSON
  - `current-review-state` → prints branch, head SHA, previous SHA, and artifact paths
  - `write-review-artifact --type task|branch --result approved|changes-requested --reviewer human|agent --base-sha <sha> --head-sha <sha>` → writes JSON into `.zcode/reviews/...`

- [ ] **Step 1: Write the failing smoke checks**

Run these before implementation:

Run: `.zcode/scripts/read-hook-command </dev/null`
Expected: FAIL with “file not found”

Run: `.zcode/scripts/current-review-state`
Expected: FAIL with “file not found”

- [ ] **Step 2: Write the command-reader helper**

```bash
#!/usr/bin/env bash
set -euo pipefail

python3 -c 'import json,sys; data=json.load(sys.stdin); print(data.get("tool_input", {}).get("command", ""))'
```

- [ ] **Step 3: Write the review-state helper**

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
BRANCH="$(git branch --show-current)"
HEAD_SHA="$(git rev-parse HEAD)"
PREV_SHA="$(git rev-parse HEAD^ 2>/dev/null || true)"

TASK_PATH="$ROOT/.zcode/reviews/tasks/$HEAD_SHA.json"
BRANCH_PATH="$ROOT/.zcode/reviews/branches/$BRANCH.json"

printf '%s\n' "ROOT=$ROOT"
printf '%s\n' "BRANCH=$BRANCH"
printf '%s\n' "HEAD_SHA=$HEAD_SHA"
printf '%s\n' "PREV_SHA=$PREV_SHA"
printf '%s\n' "TASK_REVIEW_PATH=$TASK_PATH"
printf '%s\n' "BRANCH_REVIEW_PATH=$BRANCH_PATH"
```

- [ ] **Step 4: Write the artifact writer**

```bash
#!/usr/bin/env bash
set -euo pipefail

TYPE=""
RESULT=""
REVIEWER=""
BASE_SHA=""
HEAD_SHA=""
BRANCH=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --type) TYPE="$2"; shift 2 ;;
    --result) RESULT="$2"; shift 2 ;;
    --reviewer) REVIEWER="$2"; shift 2 ;;
    --base-sha) BASE_SHA="$2"; shift 2 ;;
    --head-sha) HEAD_SHA="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -n "$TYPE" ] && [ -n "$RESULT" ] && [ -n "$REVIEWER" ] && [ -n "$BASE_SHA" ] && [ -n "$HEAD_SHA" ] && [ -n "$BRANCH" ] || {
  echo "missing required args" >&2
  exit 1
}

ROOT="$(git rev-parse --show-toplevel)"
mkdir -p "$ROOT/.zcode/reviews/tasks" "$ROOT/.zcode/reviews/branches"
NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [ "$TYPE" = "task" ]; then
  TARGET="$ROOT/.zcode/reviews/tasks/$HEAD_SHA.json"
else
  TARGET="$ROOT/.zcode/reviews/branches/$BRANCH.json"
fi

cat > "$TARGET" <<EOF
{
  "type": "${TYPE}-review",
  "branch": "$BRANCH",
  "baseSha": "$BASE_SHA",
  "headSha": "$HEAD_SHA",
  "reviewedAt": "$NOW",
  "reviewer": "$REVIEWER",
  "result": "$RESULT"
}
EOF
```

- [ ] **Step 5: Ignore local review state**

Add to `.gitignore`:

```gitignore
.zcode/reviews/
.zcode/tmp/
```

- [ ] **Step 6: Run focused verification**

Run: `.zcode/scripts/current-review-state`
Expected: prints branch / SHA info

Run: `.zcode/scripts/write-review-artifact --type task --result approved --reviewer human --base-sha "$(git rev-parse HEAD^ 2>/dev/null || git rev-parse HEAD)" --head-sha "$(git rev-parse HEAD)" --branch "$(git branch --show-current)"`
Expected: creates `.zcode/reviews/tasks/<HEAD>.json`

- [ ] **Step 7: Commit**

```bash
git add .zcode/scripts/read-hook-command .zcode/scripts/current-review-state .zcode/scripts/write-review-artifact .gitignore
git commit -m "feat(review): add local review artifact utilities"
```

### Task 3: Enforce Task-Level Review After Each Task Commit

**Files:**
- Create: `.zcode/hooks/require-review-before-commit`
- Modify: `.zcode/config.json`
- Test: manual shell verification

**Interfaces:**
- Consumes: hook stdin JSON, current git command, `.zcode/reviews/tasks/<sha>.json`
- Produces:
  - commit gate for `git commit`
  - denial when previous `HEAD` has no approved task-review artifact

- [ ] **Step 1: Extend hook config to call the commit gate**

Add a second Bash PreToolUse hook command:

```json
{
  "type": "command",
  "command": "${ZCODE_PROJECT_DIR}/.zcode/hooks/require-review-before-commit",
  "timeout": 5
}
```

- [ ] **Step 2: Write the commit-gate script**

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="${ZCODE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
CMD="$("$ROOT/.zcode/scripts/read-hook-command")"
case "$CMD" in
  "git commit"* ) ;;
  * ) exit 0 ;;
esac

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
[ -n "$HEAD_SHA" ] || exit 0

TASK_ARTIFACT="$ROOT/.zcode/reviews/tasks/$HEAD_SHA.json"
if [ ! -f "$TASK_ARTIFACT" ]; then
  cat <<EOF
{
  "permissionDecision": "deny",
  "permissionDecisionReason": "The previous task commit ($HEAD_SHA) has no approved task-review artifact. Run the review, write .zcode/reviews/tasks/$HEAD_SHA.json, then commit the next task."
}
EOF
  exit 0
fi

python3 - "$TASK_ARTIFACT" <<'PY'
import json,sys
doc=json.load(open(sys.argv[1]))
if doc.get("result") != "approved":
    print(json.dumps({
        "permissionDecision":"deny",
        "permissionDecisionReason":"The previous task review exists but is not approved. Address the review before creating another task commit."
    }))
PY
```

- [ ] **Step 3: Run the failing verification**

Without creating a task artifact for `HEAD`, attempt:

Run: `git commit --allow-empty -m "probe next task"`
Expected: hook denies with guidance referencing the missing task-review artifact

- [ ] **Step 4: Run the passing verification**

Create an approved task artifact for `HEAD`, then retry:

Run: `git commit --allow-empty -m "probe next task"`
Expected: commit is allowed

- [ ] **Step 5: Commit**

```bash
git add .zcode/config.json .zcode/hooks/require-review-before-commit
git commit -m "feat(review): enforce task review before next commit"
```

### Task 4: Enforce Branch-Level Holistic Review Before Push Or PR

**Files:**
- Create: `.zcode/hooks/require-review-before-push`
- Modify: `.zcode/config.json`

**Interfaces:**
- Consumes: hook stdin JSON, current branch/head SHA, `.zcode/reviews/branches/<branch>.json`, `ZCODE_BYPASS_REVIEW`
- Produces:
  - push / PR gate for `git push` and `gh pr create`
  - audited bypass log on emergency override

- [ ] **Step 1: Write the push-gate script**

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="${ZCODE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
CMD="$("$ROOT/.zcode/scripts/read-hook-command")"
case "$CMD" in
  "git push"*|"gh pr create"* ) ;;
  * ) exit 0 ;;
esac

if [ "${ZCODE_BYPASS_REVIEW:-}" = "1" ]; then
  mkdir -p "$ROOT/.zcode/reviews"
  printf '{"ts":"%s","branch":"%s","headSha":"%s","command":%s}\n' \
    "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    "$(git branch --show-current)" \
    "$(git rev-parse HEAD)" \
    "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$CMD")" \
    >> "$ROOT/.zcode/reviews/bypass-log.jsonl"
  exit 0
fi

BRANCH="$(git branch --show-current)"
HEAD_SHA="$(git rev-parse HEAD)"
ARTIFACT="$ROOT/.zcode/reviews/branches/$BRANCH.json"

if [ ! -f "$ARTIFACT" ]; then
  cat <<EOF
{
  "permissionDecision":"deny",
  "permissionDecisionReason":"Branch $BRANCH has no holistic review artifact for HEAD $HEAD_SHA. Run the branch review and write .zcode/reviews/branches/$BRANCH.json before push or PR creation."
}
EOF
  exit 0
fi

python3 - "$ARTIFACT" "$HEAD_SHA" <<'PY'
import json,sys
doc=json.load(open(sys.argv[1]))
head=sys.argv[2]
if doc.get("result") != "approved":
    print(json.dumps({
        "permissionDecision":"deny",
        "permissionDecisionReason":"The branch review exists but is not approved."
    }))
elif doc.get("headSha") != head:
    print(json.dumps({
        "permissionDecision":"deny",
        "permissionDecisionReason":f"Branch review is stale: reviewed {doc.get('headSha')} but HEAD is {head}."
    }))
PY
```

- [ ] **Step 2: Register the push gate in `.zcode/config.json`**

Add the hook command alongside the commit gate.

- [ ] **Step 3: Run failing verification**

Run: `git push --dry-run`
Expected: denied if `.zcode/reviews/branches/<branch>.json` is absent or stale

- [ ] **Step 4: Run passing verification**

Create an approved branch artifact for current `HEAD`, then:

Run: `git push --dry-run`
Expected: allowed

- [ ] **Step 5: Verify emergency bypass**

Run: `ZCODE_BYPASS_REVIEW=1 git push --dry-run`
Expected: allowed and appends one line to `.zcode/reviews/bypass-log.jsonl`

- [ ] **Step 6: Commit**

```bash
git add .zcode/config.json .zcode/hooks/require-review-before-push
git commit -m "feat(review): enforce branch review before push and PR"
```

### Task 5: Document The Workflow And Artifact Contract

**Files:**
- Create: `CLAUDE.md`

**Interfaces:**
- Consumes: hook behavior and artifact format from Tasks 2-4
- Produces: project-level review workflow documentation

- [ ] **Step 1: Write the documentation**

`CLAUDE.md` must state:

```md
# Review Enforcement

- Task review is required after each task commit.
- Branch review is required before `git push` or `gh pr create`.
- Hooks in `.zcode/hooks/` enforce both checks.
- Task artifacts live at `.zcode/reviews/tasks/<commitSha>.json`.
- Branch artifacts live at `.zcode/reviews/branches/<branch>.json`.
- Emergency bypass uses `ZCODE_BYPASS_REVIEW=1 <command>`.
- Every bypass is logged to `.zcode/reviews/bypass-log.jsonl`.
```

- [ ] **Step 2: Verify docs match implementation**

Run: `rg -n "Task review|Branch review|ZCODE_BYPASS_REVIEW|bypass-log|.zcode/reviews" CLAUDE.md .zcode/hooks .zcode/scripts`
Expected: all terms resolve consistently

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(review): document enforced review workflow"
```

### Task 6: End-To-End Verification

**Files:**
- No new files; verification only

**Interfaces:**
- Consumes: Tasks 1-5
- Produces: verified local enforcement flow

- [ ] **Step 1: Verify task-level enforcement**

Run the sequence:

1. create a task commit
2. attempt a second commit without reviewing the first
3. write task artifact for the first commit
4. retry the second commit

Expected: step 2 denied, step 4 allowed

- [ ] **Step 2: Verify branch-level enforcement**

Run the sequence:

1. remove any branch artifact
2. attempt `git push --dry-run`
3. create stale branch artifact for old SHA
4. retry `git push --dry-run`
5. create fresh approved branch artifact for `HEAD`
6. retry `git push --dry-run`

Expected: steps 2 and 4 denied, step 6 allowed

- [ ] **Step 3: Verify bypass logging**

Run: `ZCODE_BYPASS_REVIEW=1 git push --dry-run`
Expected: allowed and one new JSONL record appears in `.zcode/reviews/bypass-log.jsonl`

- [ ] **Step 4: Final commit if verification needs fixes**

```bash
git add .zcode .gitignore CLAUDE.md
git commit -m "chore(review): finalize review enforcement verification"
```

## Self-Review

**Spec coverage:** The plan covers the missing hard-gate problem by enforcing two separate review states, adds a guaranteed artifact producer, replaces the invalid fake flag with a real env-var bypass, and documents the resulting workflow in `CLAUDE.md`.

**Placeholder scan:** No `TODO`/`TBD` placeholders remain. The only explicit stop condition is Task 1’s hook-loading proof, which is intentional because the rest of the design depends on it.

**Type consistency:** Task artifacts are per commit under `.zcode/reviews/tasks/<commitSha>.json`; branch artifacts are per branch under `.zcode/reviews/branches/<branch>.json`; the same paths are used consistently by the writer, the hooks, and the docs.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-11-review-enforcement.md`.

Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
