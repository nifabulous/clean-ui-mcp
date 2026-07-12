/**
 * Version-aware decoder tests. The decoder's job is narrow: classify a corpus
 * file on disk as one of missing / current / supported-old / corrupt /
 * unsupported-newer, so the persistence layer can react correctly instead of
 * collapsing all failure modes into `null` (the original bug).
 *
 * Version detection happens BEFORE schema validation: a {version:3} file must
 * classify as unsupported-newer, not corrupt — even though Corpus.parse would
 * reject it (the schema is version:z.literal(2)).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeCorpusFile } from "./corpus-version.js";
import type { CorpusEntryT } from "./schema.js";
import { fixtures } from "./scripts/__fixtures__/corpus-fixtures.js";

function validEntry(id: string): CorpusEntryT {
  // Override image.path to a schema-valid private path (fixtures[0] leaves it
  // empty, which the in-memory test seam accepts but disk validation rejects).
  return { ...fixtures[0], id, image: { ...fixtures[0].image, path: "images-private/test.png", width: 1280, height: 800 } } as CorpusEntryT;
}

function writeFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "decoder-"));
  const path = resolve(dir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

function writeFileCleanup(path: string): void {
  rmSync(resolve(path, ".."), { recursive: true, force: true });
}

describe("decodeCorpusFile — classification", () => {
  it("missing → kind 'missing'", () => {
    const result = decodeCorpusFile(resolve(tmpdir(), "does-not-exist-xyz.json"));
    expect(result.kind).toBe("missing");
    expect(result.path).toMatch(/does-not-exist-xyz\.json$/);
  });

  it("valid v2 → kind 'current' with entries", () => {
    const path = writeFile("c.json", JSON.stringify({ version: 2, entries: [validEntry("a"), validEntry("b")] }));
    try {
      const result = decodeCorpusFile(path);
      expect(result.kind).toBe("current");
      if (result.kind === "current") {
        expect(result.entries.map((e) => e.id)).toEqual(["a", "b"]);
      }
    } finally { writeFileCleanup(path); }
  });

  it("unparseable JSON → kind 'corrupt' (not conflated with missing)", () => {
    const path = writeFile("c.json", "{ totally broken ]]");
    try {
      const result = decodeCorpusFile(path);
      expect(result.kind).toBe("corrupt");
      if (result.kind === "corrupt") {
        expect(result.error).toBeTruthy();
      }
    } finally { writeFileCleanup(path); }
  });

  it("parseable JSON but not a corpus object → kind 'corrupt'", () => {
    const path = writeFile("c.json", JSON.stringify({ hello: "world" }));
    try {
      const result = decodeCorpusFile(path);
      expect(result.kind).toBe("corrupt");
    } finally { writeFileCleanup(path); }
  });

  it("future version {version:3} → kind 'unsupported-newer', NOT 'corrupt'", () => {
    // This is the load-bearing distinction: a v3 file must surface visibly
    // rather than being silently parsed-then-rejected (which would mask a
    // future schema bump as corruption, or worse, trigger seed fallback).
    const path = writeFile("c.json", JSON.stringify({ version: 3, entries: [] }));
    try {
      const result = decodeCorpusFile(path);
      expect(result.kind).toBe("unsupported-newer");
      if (result.kind === "unsupported-newer") {
        expect(result.version).toBe(3);
      }
    } finally { writeFileCleanup(path); }
  });

  it("version:1 (a prior version, not readable by the current z.literal(2) schema) → kind 'corrupt'", () => {
    // v1 isn't a real prior corpus shape today. The decoder inspects .version
    // first: 1 < CURRENT, so it falls through to Corpus.safeParse, which rejects
    // it (the schema is z.literal(2)) — landing in 'corrupt', NOT
    // 'unsupported-newer' (reserved for versions > current). This is the
    // forward-compat guard: the version field is classified before parsing, so
    // a future {version:3} is distinguished from a genuinely corrupt file.
    const path = writeFile("c.json", JSON.stringify({ version: 1, entries: [] }));
    try {
      const result = decodeCorpusFile(path);
      expect(result.kind).toBe("corrupt");
    } finally { writeFileCleanup(path); }
  });
});
