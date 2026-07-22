import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolvePointer,
  sourceDocumentForEvidence,
} from "./validate-c2-baseline-cases.mts";

describe("baseline case evidence source resolution", () => {
  const brief = { artifactId: "brief-1", requiredScreens: [{ id: "home" }] };
  const snapshot = { artifactId: "snapshot-1", projectId: "case-1", evidence: [{ id: "source" }] };

  it("resolves snapshot-backed evidence against the snapshot document", () => {
    expect(sourceDocumentForEvidence("snapshot-1", brief, snapshot)).toBe(snapshot);
  });

  it("rejects an evidence source that is not bound to the case", () => {
    expect(() => sourceDocumentForEvidence("unknown", brief, snapshot)).toThrow(/neither.*brief.*snapshot/i);
  });

  it("rejects malformed array pointer indices accepted by parseInt", () => {
    expect(() => resolvePointer(brief, "/requiredScreens/0junk/id")).toThrow(/array index/i);
  });

  it("can be imported without executing the CLI validator", () => {
    const output = execFileSync(
      join(process.cwd(), "node_modules/.bin/tsx"),
      ["-e", "import('./scripts/validate-c2-baseline-cases.mts')"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(output).toBe("");
  });
});
