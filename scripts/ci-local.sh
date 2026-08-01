#!/usr/bin/env bash
#
# ci-local.sh — run the CI gate locally, in CI's order.
#
# WHY THIS EXISTS. `.github/workflows/ci.yml` runs ten steps in an order that is
# load-bearing, and running them by hand in a different order produces failures
# that look like real regressions but are not:
#
#   - `npm test` includes `src/mcp-smoke.test.ts`, which refuses to run against a
#     `dist/` older than `src/` rather than validate a stale build and report a
#     false green. Editing source and running the suite without rebuilding trips
#     it. It is doing its job; the fix is to build first, which this script does.
#
#   - `site:test:browser` and `site:test:browser:production` both serve a BUILT
#     `site/dist` and neither builds it. Run either against a stale dist and they
#     fail on copy that was fixed commits ago. CI gets this right by running
#     `site:build` between `site:test` and the browser suites; by hand it is easy
#     to skip.
#
#   - `site:test` must be able to run BEFORE `site:build`, because `site/dist` is
#     gitignored and does not exist on a fresh checkout. That is why the site
#     vitest config excludes `tests/**/*browser*.test.ts` as a class.
#
# This script is the single command that gets all of that right. It mirrors
# ci.yml exactly; if you change one, change the other.
#
# NOT INCLUDED: `npm ci` and `npx playwright install`. CI runs both because it
# starts from nothing. Locally they are slow and usually unnecessary, so this
# script checks for Chromium and tells you what to run rather than doing it.
#
# USAGE
#   npm run ci:local              every step
#   npm run ci:local -- --fast    skip the two Chromium suites and the budget
#                                 check (the slow tail); useful mid-change

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

FAST=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    *) echo "unknown option: $arg (expected --fast)" >&2; exit 2 ;;
  esac
done

# Step list mirrors .github/workflows/ci.yml. `browser` marks the steps that
# need Chromium and a built site/dist — the ones --fast drops.
STEPS=(
  "core|npm run validate-references"
  "core|npm run build"
  "core|npm run validate-corpus"
  "core|npm test"
  "core|npm run test:critique-quality"
  "core|npm run site:test"
  "core|npm run site:build"
  "browser|npm run site:test:browser"
  "browser|npm run site:test:browser:production"
  "browser|node scripts/check-site-budget.mjs"
)

if [ "$FAST" = "0" ] && ! npx playwright install --dry-run chromium >/dev/null 2>&1; then
  # A missing browser surfaces as an opaque launch failure deep in a suite, so
  # say it plainly up front instead.
  echo "note: could not confirm Chromium is installed."
  echo "      if the browser steps fail to launch, run: npx playwright install chromium"
  echo
fi

total=0
for entry in "${STEPS[@]}"; do
  [ "$FAST" = "1" ] && [ "${entry%%|*}" = "browser" ] && continue
  total=$((total + 1))
done

started=$(date +%s)
index=0
failed_step=""

for entry in "${STEPS[@]}"; do
  kind="${entry%%|*}"
  cmd="${entry#*|}"
  if [ "$FAST" = "1" ] && [ "$kind" = "browser" ]; then
    continue
  fi

  index=$((index + 1))
  step_started=$(date +%s)
  printf '\n\033[1m[%d/%d]\033[0m %s\n' "$index" "$total" "$cmd"

  if ! eval "$cmd"; then
    failed_step="$cmd"
    printf '\n\033[31mFAILED\033[0m at step %d/%d: %s\n' "$index" "$total" "$cmd"
    printf 'Steps before it passed. Fix this one and re-run; the order matters.\n'
    # On macOS the build steps above kick off Spotlight/StorageManagement
    # indexing of the freshly written output, which can starve the jsdom suites
    # badly enough to blow their 15s per-test timeout — measured at ~8x slower
    # immediately after a build (issue #84). That failure mode is local only:
    # CI is ubuntu-latest, where the mechanism does not exist. Say so rather
    # than retrying, because a silent retry would also hide a real break.
    case "$cmd" in
      *site:test*|*npm\ test*)
        printf '\nIf this step passes on its own, suspect local contention, not a regression:\n'
        printf '  %s\n' "$cmd"
        printf 'See issue #84 — on macOS, exclude this repo in Spotlight Privacy to avoid it.\n'
        ;;
    esac
    break
  fi

  printf '\033[32mok\033[0m (%ds)\n' "$(($(date +%s) - step_started))"
done

elapsed=$(($(date +%s) - started))

if [ -n "$failed_step" ]; then
  printf '\nci:local FAILED after %ds\n' "$elapsed"
  exit 1
fi

if [ "$FAST" = "1" ]; then
  printf '\nci:local (--fast) PASSED in %ds — Chromium suites and the budget check were SKIPPED.\n' "$elapsed"
  printf 'Run without --fast before pushing; CI runs them.\n'
else
  printf '\nci:local PASSED in %ds — every ci.yml step, in ci.yml order.\n' "$elapsed"
fi
