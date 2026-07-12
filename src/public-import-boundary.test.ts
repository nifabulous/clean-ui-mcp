/**
 * public-import-boundary.test.ts — Task 5a (D20), Gate 1A Publication Integrity.
 *
 * The FAST DX-feedback layer of leak enforcement. Static analysis (no runtime,
 * no I/O beyond reading our own source) that mechanically proves the public
 * tool-registration boundary does NOT import the unrestricted loader or the
 * global embedding index. If a future refactor accidentally wires the private
 * corpus into the public server factory, this test fails in milliseconds —
 * before the slower runtime contract suite (public-mcp-contract.test.ts) ever
 * spins up an in-process server.
 *
 * Mechanism: readFileSync + regex assertions, the proven pattern from
 * wiring-verification.test.ts and content-lint.test.ts (avoids shell-grep
 * portability issues). We read the raw .ts source so the check fires on the
 * text a developer actually writes, not a compiled artifact.
 *
 * What we assert:
 *
 *   1. `src/server-factory.ts` — the public tool-registration boundary — must
 *      NOT import the unrestricted corpus loader (`loadCorpus`, `loadCorpusSafe`,
 *      `tryReadCorpus`) or anything from `./corpus.js` / `./persistence.js`
 *      beyond type-only imports. The factory must only bring in `CorpusReader`
 *      (a type) from `./corpus-reader.js`. Every corpus access goes through the
 *      injected reader, so public mode can swap in the leak-prevention reader
 *      without touching tool registration.
 *
 *   2. `src/corpus-reader.ts` — specifically the PublicCorpusReader class —
 *      must NOT import the global embedding-index functions `loadIndex` /
 *      `indexExists` (from `./embeddings.js`). Those cover the PRIVATE corpus;
 *      importing them into the reader would create a path from a public-mode
 *      tool to private similarity scores + private entry counts.
 *
 * These checks are scoped to actual import statements (not comments or string
 * literals) so documentation that mentions a symbol by name doesn't trip the
 * boundary. The import-statement regexes below require `import ... from "..."`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = __dirname;

function readSrc(name: string): string {
  return readFileSync(join(SRC_DIR, name), "utf8");
}

/**
 * Strip line and block comments so a symbol mentioned in documentation doesn't
 * satisfy (or violate) an import check. We only care about real import
 * statements and the code that uses them. The factories have multi-line
 * doc-comments that name `loadCorpus`/`loadIndex` to explain WHY they aren't
 * used; those explanatory mentions must not be confused with wiring.
 *
 * This is the same defeat-mode wiring-verification.test.ts documents as a known
 * heuristic limitation; here we close it by removing comments before scanning.
 */
function stripComments(source: string): string {
  // Remove block comments (non-greedy, dotAll).
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove single-line comments. A `//` inside a string literal would be
  // mis-cut, but neither file under test contains such a literal, and the
  // import-statement regexes below would still match an intact import line.
  return noBlocks.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Match an ES import statement that brings in any of `names` from a module
 * whose path matches `modulePathRe`. Catches all three forms:
 *   import { Foo } from "./x.js"
 *   import { Foo as Bar } from "./x.js"
 *   import Foo from "./x.js"            (default import — also caught by the
 *                                        bare-name check when names is ["default"])
 */
function importMatches(
  source: string,
  names: string[],
  modulePathRe: RegExp,
): string[] {
  const hits: string[] = [];
  // Find every `import ... from "<path>";` statement.
  const importRe = /import\s+(?:type\s+)?([^;]+?)\s+from\s+["']([^"']+)["']/g;
  for (const m of source.matchAll(importRe)) {
    const clause = m[1];
    const modPath = m[2];
    if (!modulePathRe.test(modPath)) continue;
    // Named imports: { A, B as C }. Also catch a default import (clause is a
    // bare identifier, possibly followed by a comma + named block).
    const named = clause.match(/\{([^}]*)\}/);
    const importedNames = named
      ? named[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      : [clause.trim()];
    for (const imported of importedNames) {
      if (!imported) continue;
      if (names.includes(imported)) {
        hits.push(`${imported} from "${modPath}"`);
      }
    }
  }
  return hits;
}

// ─── the boundary tests ──────────────────────────────────────────────────────

describe("public import boundary — no private loader leaks into the public server", () => {
  it("server-factory.ts does not import the unrestricted loader or corpus.js/persistence.js", () => {
    const source = stripComments(readSrc("server-factory.ts"));

    // (a) The factory must NOT import the unrestricted loader symbols from
    // anywhere. These are the live-corpus entry points; wiring them into the
    // public boundary would let a public-mode tool reach the private corpus.
    const loaderHits = importMatches(
      source,
      ["loadCorpus", "loadCorpusSafe", "tryReadCorpus"],
      /.*/,
    );
    expect(loaderHits, `unrestricted loader imports: ${JSON.stringify(loaderHits)}`).toEqual([]);

    // (b) The factory must NOT import anything (value or type) from
    // ./corpus.js or ./persistence.js. corpus.js re-exports the loader and the
    // live search/similarity functions; persistence.js is the raw on-disk
    // store. The factory talks to the corpus ONLY through the injected reader.
    const corpusHits = importMatches(source, [], /\.\/corpus\.js/);
    // importMatches returns [] for an empty names list, so do a direct scan:
    const corpusImportLines = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^import\b.*from\s+["']\.\/corpus\.js["']/.test(l));
    expect(
      corpusImportLines,
      `server-factory.ts imports from ./corpus.js: ${JSON.stringify(corpusImportLines)}`,
    ).toEqual([]);

    const persistenceImportLines = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^import\b.*from\s+["']\.\/persistence\.js["']/.test(l));
    expect(
      persistenceImportLines,
      `server-factory.ts imports from ./persistence.js: ${JSON.stringify(persistenceImportLines)}`,
    ).toEqual([]);

    // (c) The factory must ONLY pull CorpusReader (a type) from
    // ./corpus-reader.js. A VALUE import from there would be fine in principle
    // (the factory doesn't construct readers), but pinning it to type-only
    // keeps the boundary crisp: the factory has zero compile-time dependency on
    // any concrete reader implementation.
    const readerImports = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^import\b.*from\s+["']\.\/corpus-reader\.js["']/.test(l));
    expect(readerImports.length).toBe(1);
    // Type-only: `import type { CorpusReader } from "./corpus-reader.js"`
    expect(readerImports[0]).toMatch(/^import\s+type\s+\{\s*CorpusReader\s*\}\s+from\s+["']\.\/corpus-reader\.js["']/);
  });

  it("corpus-reader.ts does not import the global embedding-index functions (loadIndex / indexExists)", () => {
    const source = stripComments(readSrc("corpus-reader.ts"));

    // The global embedding index (embeddings.ts) covers the PRIVATE corpus.
    // PublicCorpusReader must never touch it — doing so would leak private
    // similarity scores + private entry counts into public results. Assert the
    // reader module brings in NEITHER loadIndex NOR indexExists from
    // embeddings.js (or any re-export of them).
    const indexHits = importMatches(
      source,
      ["loadIndex", "indexExists"],
      /\.\/embeddings\.js|\.\/image-index\.js/,
    );
    expect(
      indexHits,
      `global embedding-index imports in corpus-reader.ts: ${JSON.stringify(indexHits)}`,
    ).toEqual([]);

    // Defense: also assert no bare `import ... from "./embeddings.js"` line
    // exists at all, so a future default import can't sneak by the named-symbol
    // check above.
    const embeddingsImportLines = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^import\b.*from\s+["']\.\/embeddings\.js["']/.test(l));
    expect(
      embeddingsImportLines,
      `corpus-reader.ts imports from ./embeddings.js: ${JSON.stringify(embeddingsImportLines)}`,
    ).toEqual([]);
  });

  it("sanity: the stripComments + importMatches helpers actually catch a violation", () => {
    // A regression in the helper itself would silently turn this boundary test
    // into a no-op. Pin the helpers against a known-positive synthetic snippet
    // so a future edit that breaks detection fails loudly here.
    const synthetic = stripComments(`
      // a comment mentioning loadCorpus should NOT count
      import { loadCorpus } from "./corpus.js";
      /* block comment mentioning loadIndex should NOT count */
      import { loadIndex, indexExists } from "./embeddings.js";
      import type { CorpusReader } from "./corpus-reader.js";
    `);
    expect(importMatches(synthetic, ["loadCorpus"], /\.\/corpus\.js/)).toContain(
      'loadCorpus from "./corpus.js"',
    );
    expect(importMatches(synthetic, ["loadIndex", "indexExists"], /\.\/embeddings\.js/)).toEqual([
      'loadIndex from "./embeddings.js"',
      'indexExists from "./embeddings.js"',
    ]);
  });
});
