/**
 * C2 Pass 1 scope boundary.
 *
 * Pass 1 landed contract schemas and the three-package pilot under
 * `eval/c2/pilot/` as provisional foundation work. C2 governance is now
 * declared separately by the readiness recipe and a hash-only evidence
 * manifest; the append-only human approvals remain separate ledger artifacts.
 * The pilot files remain outside browser-downloadable public assets.
 *
 * The tests pin the boundary between machine-verifiable C2 evidence and human
 * approval, as well as the absence of public-site pilot exposure.
 *
 * C2 IS NOW CLOSED (checkpoint-approvals-v7.json). The two effective C2 records
 * in `checkpoint-approvals-v5.json` were provenance-invalid (each copied the
 * `decidedAt` of the approval it supersedes), so at v5 no valid reviewer
 * decision existed for the target they bind; `checkpoint-approvals-v6.json`
 * retracted them and `checkpoint-approvals-v7.json` appended the real Gold+QA
 * decisions of the corrected target, which close C2. The ledger assertions
 * below describe v5's OWN immutable contents — the historical defect — and must
 * not be relaxed; they remain literally true because v5 is byte-identical under
 * every later append-only ledger.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_RECIPES, CHECKPOINT_POLICIES } from "../readiness/checkpoint-policy.js";

const root = resolve(__dirname, "../..");

interface C2Approval {
  approvalId: string;
  checkpoint: string;
  role: string;
  decidedAt: string;
  supersedesApprovalId?: string;
}

describe("C2 governance scope boundary", () => {
  it("declares C2 governance without claiming approval", () => {
    expect(Object.keys(CHECKPOINT_RECIPES).sort()).toEqual(["C0", "C1", "C2"]);
    expect(Object.keys(CHECKPOINT_POLICIES).sort()).toEqual(["C0", "C1", "C2"]);
  });

  it("tracks the evidence manifest and append-only approval ledgers", () => {
    const governanceRoot = resolve(root, "quality-contracts/agent-readiness");
    const manifest = JSON.parse(
      readFileSync(resolve(governanceRoot, "c2-evidence-manifest-v1.json"), "utf8"),
    );
    expect(manifest.artifactType).toBe("c2-evidence-manifest");
    expect(manifest.checkpoint).toBe("C2");
    expect(manifest.evidence).toHaveLength(8);
    // Every ledger in the chain, not a hand-picked subset. A prior version
    // matched only /v[345]/, so appending a later ledger would not have
    // registered here. v7 is now the head ledger (v6 retracted the two
    // provenance-invalid v2 approvals asserted below; v7 appended the real
    // Gold+QA decisions that close C2) but the assertions below still describe
    // v5's OWN contents specifically — v5 is unchanged by every later
    // append-only ledger, so those assertions remain literally true. Adding a
    // further ledger must still force a conscious update of this list.
    expect(
      readdirSync(governanceRoot)
        .filter((file) => /^checkpoint-approvals-v\d+\.json$/.test(file))
        .sort(),
    ).toEqual([
      "checkpoint-approvals-v1.json",
      "checkpoint-approvals-v2.json",
      "checkpoint-approvals-v3.json",
      "checkpoint-approvals-v4.json",
      "checkpoint-approvals-v5.json",
      "checkpoint-approvals-v6.json",
      "checkpoint-approvals-v7.json",
    ]);
    const ledger: { approvals: C2Approval[] } = JSON.parse(
      readFileSync(resolve(governanceRoot, "checkpoint-approvals-v5.json"), "utf8"),
    );

    // The EFFECTIVE approvals are those no later record supersedes. Note this is
    // NOT `supersedesApprovalId === undefined` — that condition selects records
    // which supersede nothing, i.e. the SUPERSEDED v1 pair. An earlier version
    // of this test used it and therefore asserted the opposite of its stated
    // intent; it passed only because both pairs carry the same two roles.
    const supersededIds = new Set(
      ledger.approvals.flatMap((a) => (a.supersedesApprovalId ? [a.supersedesApprovalId] : [])),
    );
    const effectiveC2 = ledger.approvals.filter(
      (a) => a.checkpoint === "C2" && !supersededIds.has(a.approvalId),
    );

    expect(effectiveC2.map((a) => a.approvalId)).toEqual([
      "c2-gold-reviewer-gold-v2",
      "c2-qa-reviewer-qa-v2",
    ]);
    expect(effectiveC2.map((a) => a.role)).toEqual(["Gold Label Owner", "QA"]);

    // Both effective records IN v5 are provenance-invalid: each copied the
    // `decidedAt` of the v1 approval it supersedes, so each claims a decision
    // taken before the target it binds (cf55fee0…) existed. At v5, C2 was
    // therefore OPEN — two role-correct approvals did NOT mean C2 was approved.
    // v6 retracted these and v7 appended the real decisions, so C2 is now
    // CLOSED; `src/readiness/tracked-artifacts-readiness.test.ts` asserts that
    // gate state. This assertion pins the underlying historical ledger defect.
    for (const approval of effectiveC2) {
      const superseded = ledger.approvals.find(
        (a) => a.approvalId === approval.supersedesApprovalId,
      );
      expect(superseded).toBeDefined();
      expect(Date.parse(approval.decidedAt)).toBeLessThanOrEqual(
        Date.parse(superseded!.decidedAt),
      );
    }
  });

  it("keeps pilot files outside browser-downloadable public assets", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "eval/c2/pilot/manifest.json"), "utf8"));
    for (const pkg of manifest.packages) {
      expect(pkg.brief.path.startsWith("eval/c2/pilot/")).toBe(true);
      expect(pkg.label.path.startsWith("eval/c2/pilot/")).toBe(true);
    }
  });
});
