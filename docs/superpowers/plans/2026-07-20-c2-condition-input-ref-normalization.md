# C2 Condition-Input Reference Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the paid C2 runner to persist hash-only condition-input references without weakening the durable-artifact boundary scanner.

**Architecture:** Keep resolved condition-input descriptors on disk under the private execution root. Before building either primary- or independent-lane run manifest, convert the physical descriptor path into a logical `eval/c2/condition-inputs/...` reference. The descriptor bytes remain private; its SHA-256 remains the binding authority; the logical path is metadata for operators. The scanner remains unchanged and continues rejecting all `.c2-private/` references in durable artifacts.

**Tech Stack:** TypeScript, Vitest, Node.js ESM, existing C2 CLI and boundary scanner.

## Global Constraints

- Do not weaken or modify `FORBIDDEN_PATH_SUBSTRINGS` in `src/c2/private-artifacts.ts`.
- Do not move condition-input descriptor files out of `.c2-private/`.
- Do not change `ArtifactFileRefSchema`, V2 manifest schemas, proposal reducers, or freeze logic.
- The normalized path must never be dereferenced by `propose` or `freeze`; only the descriptor hash binds the file.
- The scanner must continue rejecting `.c2-private/runs/.../output.json` and other private raw-content paths.
- Default tests and verification commands must make zero provider calls.
- Do not run `run --paid` without explicit operator authorization immediately before execution.
- Preserve the existing condition-input schema/hash validation and the existing 12-run campaign shape.

---

## File Map

- **Modify:** `src/scripts/run-c2-pilot.ts` — add the pure logical-path normalizer and use it for both run-manifest `conditionInputRef` values.
- **Modify:** `src/scripts/run-c2-pilot.test.ts` — unit-test the normalizer, including default, already-normalized, and alternate-root inputs.
- **Modify:** `src/c2/private-artifacts.test.ts` — document that logical hash-only descriptor refs are allowed while private raw-output refs remain forbidden.

## Task 1: Lock the path contract with failing tests

**Files:**

- Modify: `src/scripts/run-c2-pilot.test.ts`
- Modify: `src/c2/private-artifacts.test.ts`

**Interfaces:**

- Consumes: `logicalConditionInputPath(executionPath: string): string` from `src/scripts/run-c2-pilot.ts`.
- Produces: a test-backed contract that physical execution paths are never emitted into durable run manifests.

- [ ] **Step 1: Add normalizer tests**

Import `logicalConditionInputPath` alongside `buildModelEndpoint` and add:

```ts
describe("logicalConditionInputPath", () => {
  it("maps the default private execution path to the logical eval path", () => {
    expect(
      logicalConditionInputPath(
        ".c2-private/c2/condition-inputs/stablecoin-home-current-grounded.json",
      ),
    ).toBe("eval/c2/condition-inputs/stablecoin-home-current-grounded.json");
  });

  it("leaves an already-normalized logical path unchanged", () => {
    expect(
      logicalConditionInputPath(
        "eval/c2/condition-inputs/stablecoin-home-current-grounded.json",
      ),
    ).toBe("eval/c2/condition-inputs/stablecoin-home-current-grounded.json");
  });

  it("normalizes an alternate private-root path by its condition-input suffix", () => {
    expect(
      logicalConditionInputPath(
        "/tmp/c2-private-run/c2/condition-inputs/stablecoin-home-current-grounded.json",
      ),
    ).toBe("eval/c2/condition-inputs/stablecoin-home-current-grounded.json");
  });
});
```

The alternate-root case prevents the helper from silently depending on the CLI's default `--private-root` value.

- [ ] **Step 2: Add the scanner-scope test**

Keep the existing rejection test for `.c2-private/runs/run-1/output.json`. Add this companion case in `describe("scanDurableArtifact")`:

```ts
it("accepts a hash-only logical condition-input reference", () => {
  const artifact = {
    schemaVersion: "2.0",
    artifactType: "c2-evaluation-run",
    artifactId: "run-1",
    conditionInputRef: {
      artifactId: "condition-input-1",
      path: "eval/c2/condition-inputs/stablecoin-home-current-grounded.json",
      sha256: "a".repeat(64),
    },
  };
  expect(() => scanDurableArtifact(JSON.stringify(artifact), baseConfig)).not.toThrow();
});
```

This test proves the intended distinction without changing scanner behavior: logical metadata is accepted; private raw-content paths remain rejected.

- [ ] **Step 3: Run the focused tests and confirm they fail**

Run:

```bash
npm test -- --run src/scripts/run-c2-pilot.test.ts src/c2/private-artifacts.test.ts
```

Expected: the scanner test passes, while the normalizer tests fail because `logicalConditionInputPath` does not yet exist.

- [ ] **Step 4: Commit the failing tests**

```bash
git add src/scripts/run-c2-pilot.test.ts src/c2/private-artifacts.test.ts
git commit -m "test(c2): specify logical condition-input references"
```

## Task 2: Implement and wire the logical path normalizer

**Files:**

- Modify: `src/scripts/run-c2-pilot.ts`

**Interfaces:**

- Consumes: the physical condition-input path already used to load and hash the prepared descriptor.
- Produces: `logicalConditionInputPath(executionPath: string): string`, returning a normalized repository-relative path under `eval/c2/condition-inputs/`.

- [ ] **Step 1: Add the pure helper**

Place the helper near `relPathFromRepo` and export it for the focused unit test:

```ts
/**
 * Convert a private condition-input execution path into the logical path
 * recorded in durable run metadata. The descriptor remains private on disk;
 * only its SHA-256 binds the run to the exact bytes.
 */
export function logicalConditionInputPath(executionPath: string): string {
  const normalized = executionPath.replaceAll("\\\\", "/");
  const marker = "/c2/condition-inputs/";
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex >= 0) {
    const fileName = normalized.slice(markerIndex + marker.length);
    if (fileName.length > 0 && !fileName.includes("/")) {
      return `eval/c2/condition-inputs/${fileName}`;
    }
  }

  if (normalized.startsWith("eval/c2/condition-inputs/")) {
    return normalized;
  }

  throw new Error(
    `[c2-cli] cannot normalize condition-input path: ${executionPath}`,
  );
}
```

The helper deliberately recognizes the condition-input directory rather than blindly replacing every `.c2-private/` substring. This keeps the output stable when an operator supplies an alternate private root and refuses malformed or unrelated paths.

- [ ] **Step 2: Normalize the primary-lane reference**

At the primary request construction, replace:

```ts
path: relPathFromRepo(conditionInputPath),
```

with:

```ts
path: logicalConditionInputPath(relPathFromRepo(conditionInputPath)),
```

Keep `sha256: fileSha256(conditionInputPath)` unchanged. The hash must still be computed from the private file actually loaded for execution.

- [ ] **Step 3: Normalize the independent-lane reference**

Apply the identical replacement at the independent request construction. Do not normalize `casePackageRef`, `scorerRef`, source snapshots, or any other reference.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- --run src/scripts/run-c2-pilot.test.ts src/c2/private-artifacts.test.ts
```

Expected: all tests pass, including the existing `.c2-private/runs/.../output.json` rejection.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/scripts/run-c2-pilot.ts
git commit -m "fix(c2): normalize private condition-input manifest refs"
```

## Task 3: Verify the durable-boundary and CLI integration

**Files:**

- No additional production files.
- Read-only verification of the generated manifest and the pre-existing boundary scanner.

- [ ] **Step 1: Run the complete offline verification suite**

Run:

```bash
npm test
npm run typecheck:contracts
npm run build
npm run check-public-site-boundary
npm run validate:c2-pilot
npm run c2:pilot -- prepare --config eval/c2/config/pilot-campaign.json
```

Expected: the full suite passes; build and boundary checks pass; `prepare` resolves the nine unique condition-input descriptors without provider calls.

- [ ] **Step 2: Verify the no-paid-call guard**

Run without `--paid`:

```bash
C2_NETWORK_AUDIT="$(mktemp)" npm run c2:pilot -- run --config eval/c2/config/pilot-campaign.json
```

Expected: non-zero exit explaining that `--paid` is required, with no provider request recorded.

- [ ] **Step 3: Re-scan a legacy attic manifest**

After building, locate the relocated legacy manifest that still contains `.c2-private/`, then run a read-only scanner check against it:

```bash
LEGACY_MANIFEST="$(rg -l '\.c2-private/' eval 2>/dev/null | head -1)"
test -n "$LEGACY_MANIFEST"
LEGACY_MANIFEST="$LEGACY_MANIFEST" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { scanDurableArtifact } from "./dist/c2/private-artifacts.js";

const text = readFileSync(process.env.LEGACY_MANIFEST, "utf8");
try {
  scanDurableArtifact(text, { secretValues: [], secretEnvNames: [] });
  throw new Error("legacy private-path manifest was unexpectedly accepted");
} catch (error) {
  if (!String(error).match(/private path|private/i)) throw error;
}
NODE
```

Expected: the scanner rejects the located manifest for the private path. This confirms the security rule was not weakened.

- [ ] **Step 4: Commit only after offline verification passes**

```bash
git status --short
git log --oneline -2
```

Do not stage `.c2-private/`, provider outputs, credentials, or any generated raw-response files.

## Task 4: Authorized paid execution and handoff gate

This task crosses the paid-provider boundary and requires explicit operator authorization immediately before Step 3. Do not execute it as part of ordinary test verification.

- [ ] **Step 1: Re-verify the campaign inputs**

Confirm that the prepared condition-input files exist, that every persisted `inputSha256` validates, and that the pricing table/model pins are current. Re-run `prepare` if any input, corpus snapshot, model, or pricing value changed.

- [ ] **Step 2: Record the authorization boundary**

Confirm in the execution notes:

- campaign config and pricing files are reviewed;
- `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are available without printing their values;
- the maximum campaign spend remains `$5.00` and the per-run ceiling remains `$0.50`;
- no corpus mutation, retagging, C2 closure, or Pass 3 work is authorized;
- the next stop is blinded scorecard collection and genuine compatibility evaluation.

- [ ] **Step 3: Run the paid campaign**

Run only after the explicit authorization:

```bash
npm run c2:pilot -- run \
  --config eval/c2/config/pilot-campaign.json \
  --pricing eval/c2/config/pricing.json \
  --paid
```

Expected: the first run writes a manifest whose `conditionInputRef.path` is under `eval/c2/condition-inputs/`, whose hash matches the private descriptor bytes, and whose durable write passes the unchanged scanner. A successful campaign produces 12 run records and stays within the configured ceilings.

- [ ] **Step 4: Stop at the calibration gate**

After execution, preserve the private raw outputs and durable hash-only manifests. Do not freeze calibration from the CLI-synthesized compatibility placeholder. Proceed only to metadata-blinded scorecard collection and an independently authored compatibility evaluation.

- [ ] **Step 5: Record the operational handoff**

Capture the run count, terminal statuses, total spend, provider-attempt audit count, and any failed runs. Keep the follow-up limited to the blinded-scorecard and compatibility gate described in the Pass 2 plan.

## Verification Checklist

- [ ] Scanner source is unchanged.
- [ ] Existing rejection of `.c2-private/runs/.../output.json` still passes.
- [ ] Logical `eval/c2/condition-inputs/...` hash-only reference is accepted.
- [ ] Both primary and independent manifest construction use the normalizer.
- [ ] Physical condition-input descriptors remain under `.c2-private/`.
- [ ] Descriptor SHA-256 is computed from the private file and is unchanged by normalization.
- [ ] Full offline suite passes with zero provider calls.
- [ ] Legacy manifest with an old private path is still rejected by the scanner.
- [ ] Paid execution occurs only after explicit authorization and stops before any retagging or C2 closure.
