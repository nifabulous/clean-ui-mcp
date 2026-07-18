import { describe, expect, it } from "vitest";
import { selectChain, type ChainNode } from "./chains.js";

const sha = (c: string) => c.repeat(64);
const node = (
  id: string,
  key: string | number,
  digest: string,
  predecessor: { key: string | number; sha256: string } | null,
): ChainNode<{ id: string }> => ({ id, key, sha256: digest, predecessor, value: { id } });

describe("selectChain", () => {
  it("selects the unique terminal head and returns root-to-head order", () => {
    const v1 = node("v1", 1, sha("a"), null);
    const v2 = node("v2", 2, sha("b"), { key: 1, sha256: v1.sha256 });
    const selected = selectChain("ledger", [v2, v1]);
    expect(selected.issues).toEqual([]);
    expect(selected.head?.id).toBe("v2");
    expect(selected.ordered.map((n) => n.id)).toEqual(["v1", "v2"]);
  });

  it.each([
    ["duplicate ordinal", [node("a", 2, sha("a"), null), node("b", 2, sha("b"), null)], "chain-duplicate-key"],
    ["missing predecessor", [node("v2", 2, sha("b"), { key: 1, sha256: sha("a") })], "chain-missing-predecessor"],
    ["predecessor digest mismatch", [node("v1", 1, sha("a"), null), node("v2", 2, sha("b"), { key: 1, sha256: sha("c") })], "chain-predecessor-hash-mismatch"],
    ["multiple heads", [node("v1", 1, sha("a"), null), node("v2a", 2, sha("b"), { key: 1, sha256: sha("a") }), node("v2b", 3, sha("c"), { key: 1, sha256: sha("a") })], "chain-fork"],
  ])("rejects %s", (_label, nodes, code) => {
    const selected = selectChain("ledger", nodes as ChainNode<{ id: string }>[]);
    expect(selected.issues.some((i) => i.code === code)).toBe(true);
    expect(selected.head).toBeUndefined();
  });

  it("rejects a skipped numeric ordinal", () => {
    const v1 = node("v1", 1, sha("a"), null);
    const v3 = node("v3", 3, sha("b"), { key: 1, sha256: v1.sha256 });
    expect(selectChain("index", [v1, v3]).issues.some((i) => i.code === "chain-skipped-ordinal")).toBe(true);
  });

  it("supports registry string versions through the same graph", () => {
    const v1 = node("registry-v1", "1.0", sha("a"), null);
    const v2 = node("registry-v2", "2.0", sha("b"), { key: "1.0", sha256: v1.sha256 });
    expect(selectChain("registry", [v2, v1]).head?.id).toBe("registry-v2");
  });

  it("rejects a cycle", () => {
    const a = node("a", 1, sha("a"), { key: 2, sha256: sha("b") });
    const b = node("b", 2, sha("b"), { key: 1, sha256: sha("a") });
    expect(selectChain("ledger", [a, b]).issues.some((i) => i.code === "chain-cycle")).toBe(true);
  });

  it("rejects a non-genesis numeric ordinal without a predecessor", () => {
    // An attacker strips the v1 ledger and the predecessor link from v2,
    // presenting a single-node v2 chain. This must be rejected: ordinal > 1
    // without a predecessor means the append-only history is bypassed.
    const lone = node("v2-stripped", 2, sha("b"), null);
    const result = selectChain("ledger", [lone]);
    expect(result.issues.some((i) => i.code === "chain-missing-predecessor")).toBe(true);
    expect(result.head).toBeUndefined();
  });

  it("accepts a single-node numeric chain at ordinal 1", () => {
    // A lone v1 artifact (no predecessor) is valid — ordinal 1 is the genesis root.
    const lone = node("v1-only", 1, sha("a"), null);
    const result = selectChain("ledger", [lone]);
    expect(result.issues).toEqual([]);
    expect(result.head?.id).toBe("v1-only");
  });

  it("rejects a registry string version > 1 without a predecessor", () => {
    // Same bypass class as the numeric case, but for string-version registry
    // chains: an attacker strips previousRegistry from a v2 registry and
    // removes the v1 file, presenting a single-node "2.0" chain.
    const lone = node("registry-v2-stripped", "2.0", sha("b"), null);
    const result = selectChain("registry", [lone]);
    expect(result.issues.some((i) => i.code === "chain-missing-predecessor")).toBe(true);
    expect(result.head).toBeUndefined();
  });

  it("accepts a single-node registry at version 1.0 (genesis root)", () => {
    const lone = node("registry-v1-only", "1.0", sha("a"), null);
    const result = selectChain("registry", [lone]);
    expect(result.issues).toEqual([]);
    expect(result.head?.id).toBe("registry-v1-only");
  });
});
