// Pure, generic governance snapshot chain graph engine.
//
// This module has no dependency on the readiness validator or artifact
// types. It accepts chain nodes keyed by an ordinal or registry string and
// validates the integrity of the predecessor-linked graph, returning the
// unique terminal head and root-to-head ordering when the chain is sound.

export type ChainKey = string | number;

export interface ChainNode<T> {
  readonly id: string;
  readonly key: ChainKey;
  readonly sha256: string;
  readonly predecessor: { key: ChainKey; sha256: string } | null;
  readonly value: T;
}

export interface ChainIssue {
  readonly code:
    | "chain-duplicate-key"
    | "chain-missing-predecessor"
    | "chain-predecessor-hash-mismatch"
    | "chain-skipped-ordinal"
    | "chain-fork"
    | "chain-cycle"
    | "chain-multiple-heads";
  readonly family: string;
  readonly nodeId?: string;
  readonly message: string;
}

export interface ChainSelection<T> {
  readonly head?: ChainNode<T>;
  readonly ordered: readonly ChainNode<T>[];
  readonly issues: readonly ChainIssue[];
}

const keyToken = (key: ChainKey): string => `${typeof key}:${String(key)}`;

/**
 * Validate a predecessor-linked chain and select its unique terminal head.
 *
 * Algorithm:
 *  1. returns an empty selection for zero nodes;
 *  2. rejects duplicate keyToken values;
 *  3. resolves every predecessor by both key and digest;
 *  4. requires numeric successors to equal predecessor ordinal + 1;
 *  5. records child counts and rejects a predecessor with more than one child;
 *  6. finds exactly one node with no child (the head);
 *  7. walks predecessor links from head to root with a visited set;
 *  8. rejects cycles and disconnected nodes; and
 *  9. returns `ordered` root-to-head only when there are no issues.
 */
export function selectChain<T>(family: string, nodes: readonly ChainNode<T>[]): ChainSelection<T> {
  // 1. empty input → empty selection.
  if (nodes.length === 0) return { ordered: [], issues: [] };

  const issues: ChainIssue[] = [];

  // 2. index nodes by keyToken, rejecting duplicates.
  const byKey = new Map<string, ChainNode<T>>();
  for (const n of nodes) {
    const token = keyToken(n.key);
    const existing = byKey.get(token);
    if (existing !== undefined) {
      issues.push({
        code: "chain-duplicate-key",
        family,
        nodeId: n.id,
        message: `duplicate chain key ${String(n.key)} (also held by ${existing.id})`,
      });
    } else {
      byKey.set(token, n);
    }
  }

  // 3. resolve every predecessor by key and digest, and 4. enforce numeric
  //    ordinal succession (predecessor ordinal + 1).
  for (const n of nodes) {
    const predecessor = n.predecessor;
    if (!predecessor) continue;
    const predToken = keyToken(predecessor.key);
    const predNode = byKey.get(predToken);
    if (!predNode) {
      issues.push({
        code: "chain-missing-predecessor",
        family,
        nodeId: n.id,
        message: `predecessor ${String(predecessor.key)} is not present in the ${family} chain`,
      });
      continue;
    }
    if (predNode.sha256 !== predecessor.sha256) {
      issues.push({
        code: "chain-predecessor-hash-mismatch",
        family,
        nodeId: n.id,
        message: `predecessor ${String(predecessor.key)} digest ${predecessor.sha256} does not match ${predNode.sha256}`,
      });
      continue;
    }
    if (typeof n.key === "number" && typeof predecessor.key === "number") {
      if (n.key !== predecessor.key + 1) {
        issues.push({
          code: "chain-skipped-ordinal",
          family,
          nodeId: n.id,
          message: `ordinal ${n.key} does not immediately follow ${predecessor.key}`,
        });
      }
    }
  }

  // 5. record child counts; a predecessor with more than one child is a fork.
  const childCount = new Map<string, number>();
  for (const n of nodes) {
    const predecessor = n.predecessor;
    if (!predecessor) continue;
    const predToken = keyToken(predecessor.key);
    if (!byKey.has(predToken)) continue;
    childCount.set(predToken, (childCount.get(predToken) ?? 0) + 1);
  }
  for (const [token, count] of childCount) {
    if (count > 1) {
      const owner = byKey.get(token);
      issues.push({
        code: "chain-fork",
        family,
        nodeId: owner?.id,
        message: `predecessor ${owner ? String(owner.key) : token} has ${count} children in the ${family} chain`,
      });
    }
  }

  // Independent cycle detection over the predecessor-link graph. This runs
  // before head selection so cycles with zero head candidates (every node is
  // referenced) are still rejected.
  let cycleDetected = false;
  const color = new Map<string, number>(); // absent = white, 1 = gray (on path), 2 = black (done)
  for (const start of nodes) {
    const startToken = keyToken(start.key);
    if (color.get(startToken) === 2) continue;
    const path: string[] = [];
    let currentToken: string | undefined = startToken;
    let hitCycle = false;
    while (currentToken !== undefined) {
      const state = color.get(currentToken);
      if (state === 2) break;
      if (state === 1) {
        hitCycle = true;
        break;
      }
      color.set(currentToken, 1);
      path.push(currentToken);
      const currentNode = byKey.get(currentToken);
      const predecessor = currentNode?.predecessor;
      if (!predecessor) {
        currentToken = undefined;
        break;
      }
      const predToken = keyToken(predecessor.key);
      currentToken = byKey.has(predToken) ? predToken : undefined;
    }
    for (const token of path) color.set(token, 2);
    if (hitCycle) cycleDetected = true;
  }
  if (cycleDetected) {
    issues.push({
      code: "chain-cycle",
      family,
      message: `the ${family} chain contains a predecessor cycle`,
    });
  }

  // 6. find the head: exactly one node with no child.
  const headNodes = nodes.filter((n) => !childCount.has(keyToken(n.key)));
  let head: ChainNode<T> | undefined;
  if (headNodes.length === 1) {
    head = headNodes[0];
  } else if (headNodes.length > 1) {
    issues.push({
      code: "chain-multiple-heads",
      family,
      message: `the ${family} chain has ${headNodes.length} terminal heads`,
    });
  }

  // 7. walk predecessor links from head to root with a visited set, collecting
  //    root-to-head order. Only meaningful when a single head exists.
  const reversed: ChainNode<T>[] = [];
  if (head) {
    const visited = new Set<string>();
    let cursor: ChainNode<T> | undefined = head;
    while (cursor !== undefined) {
      const token = keyToken(cursor.key);
      if (visited.has(token)) break; // defensive; cycles already detected above
      visited.add(token);
      reversed.push(cursor);
      const predecessor = cursor.predecessor;
      if (!predecessor) break;
      cursor = byKey.get(keyToken(predecessor.key));
    }

    // 8. reject disconnected nodes not reachable from the head.
    if (visited.size < byKey.size) {
      issues.push({
        code: "chain-multiple-heads",
        family,
        message: `the ${family} chain has nodes disconnected from the head`,
      });
    }
  }

  // 9. return ordered root-to-head only when there are no issues.
  if (issues.length > 0) return { ordered: [], issues };
  return { head, ordered: [...reversed].reverse(), issues: [] };
}

// ---------------------------------------------------------------------------
// Adapters for asymmetric artifact representations
// ---------------------------------------------------------------------------

export interface ParsedChainArtifact {
  readonly data: Record<string, unknown>;
  readonly sha: string;
}

export function registryChainNode<T extends ParsedChainArtifact>(entry: T): ChainNode<T> {
  const previous = entry.data.previousRegistry as { registryVersion: string; sha256: string } | null;
  return {
    id: String(entry.data.artifactId),
    key: String(entry.data.registryVersion),
    sha256: entry.sha,
    predecessor: previous ? { key: previous.registryVersion, sha256: previous.sha256 } : null,
    value: entry,
  };
}

export type ChainNodeResult<T> =
  | { readonly ok: true; readonly node: ChainNode<T> }
  | { readonly ok: false; readonly issue: ChainIssue };

export function ordinalChainNode<T extends ParsedChainArtifact>(entry: T): ChainNodeResult<T> {
  const ordinal = typeof entry.data.ordinalVersion === "number" ? entry.data.ordinalVersion : 1;
  const previous = entry.data.predecessor as { version: string; sha256: string } | null | undefined;
  const previousOrdinal = previous ? Number(previous.version) : null;
  if (previous && (!Number.isInteger(previousOrdinal) || previousOrdinal! < 1)) {
    return {
      ok: false,
      issue: {
        code: "chain-missing-predecessor",
        family: "ordinal",
        nodeId: String(entry.data.artifactId),
        message: `invalid predecessor ordinal: ${previous.version}`,
      },
    };
  }
  return {
    ok: true,
    node: {
      id: String(entry.data.artifactId),
      key: ordinal,
      sha256: entry.sha,
      predecessor: previous ? { key: previousOrdinal!, sha256: previous.sha256 } : null,
      value: entry,
    },
  };
}
