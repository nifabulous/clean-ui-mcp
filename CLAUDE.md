# Project conventions for clean-ui-mcp

These conventions govern agent behavior on this repository. They override
default system-prompt behavior where they conflict.

## Code review after every implementation

**Run a code review with the Superpowers requesting-code-review skill (or
equivalent subagent dispatch) after every implementation — not just at the
end of a feature.**

This is a standing standard, not an optional step.

### When to review

- **After each task** in subagent-driven development (two-stage: spec
  compliance, then code quality).
- **After completing a feature or increment** — a final holistic review
  across the full diff (base..head), even if every task was already
  reviewed individually. Per-task reviews catch local issues; the final
  review catches cross-cutting bugs (e.g. path conventions, contract
  mismatches between layers) that only surface when the whole change is
  read together.
- **Before merge to main.**

### How to review

Use `superpowers:requesting-code-review`. Dispatch a code-reviewer
subagent with:
- The description of what was built
- The plan or requirements reference
- BASE_SHA and HEAD_SHA for the git range
- Calibration: categorize by actual severity (Critical / Important / Minor)

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
