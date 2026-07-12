import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { CorpusEntryT } from "../schema.js";
import { exportPublicSnapshot, type ExportResult } from "./exporter.js";
import type { PublicSnapshotManifest } from "./manifest.js";

/**
 * exportPublicSnapshot — Task 3, Gate 1A Publication Integrity.
 *
 * Tests use a FIXTURE corpus (per D16): synthetic eligible entries with REAL
 * image files in a temp images-public/ dir. No mocks of the filesystem — the
 * whole point of this task is directory-atomic commit + hash verification, so
 * we exercise real file I/O.
 *
 * Snapshot layout (D18/F3): <snapshotDir>/<snapshotId>/{manifest.json,
 * entries.json, images-public/<asset>} — entry paths stay schema-valid because
 * the images-public/ tree is preserved verbatim (no path rewriting).
 */

const NOW = "2026-07-12T00:00:00.000Z";
const NOW_DATE = "2026-07-12";

// ─── fixtures ──────────────────────────────────────────────────────────────────

/**
 * Base eligible publication block — every field present, approved, non-expired.
 * Matches the policy-test fixture so both tests agree on what "eligible" means.
 */
const eligiblePublication = {
  visibility: "public" as const,
  clearance: "approved" as const,
  rightsBasis: "owned" as const,
  evidenceRef: "docs/rights/example.md",
  reviewedAt: "2026-06-01",
  reviewedBy: "nifabulous",
};

/**
 * Build a minimal-but-valid CorpusEntryT. `imagePath` is corpus-relative
 * ("images-public/<asset>"); the test creates a matching real file in the temp
 * image root so imageExists returns true.
 */
function eligibleEntry(id: string, imagePath: string): CorpusEntryT {
  return {
    id,
    title: `${id} title`,
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    source: {
      productName: "Example",
      url: "https://example.com",
      capturedAt: "2026-07-01",
      capturedBy: "self",
    },
    image: {
      visibility: "public-own",
      path: imagePath,
      width: 1440,
      height: 900,
    },
    visual: {
      dominantColors: ["#ffffff", "#111111"],
      accentColor: "#635bff",
      typePairing: { display: "Inter", body: "Inter" },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
      usesShadows: false,
      usesBorders: true,
    },
    critique:
      "This example uses restrained contrast, clear type hierarchy, and quiet borders to create a focused interface without decorative noise.",
    whatToSteal: ["Use low-contrast borders to separate dense regions without adding visual clutter."],
    antiPatterns: {
      antiPatterns: ["Avoids drop shadows; uses background-color steps for depth instead."],
      whereThisFails: [],
      accessibilityRisks: [],
    },
    qualityTier: "exceptional",
    qualityScore: 4,
    reviewStatus: "approved",
    addedAt: "2026-07-01",
    publication: { ...eligiblePublication },
  } as CorpusEntryT;
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  ...new Array(32).fill(0), // minimal body
]);

/**
 * Test harness: temp corpus root with images-public/, images-private/, and a
 * public-snapshots/ destination. `imageRoot` is the SOURCE image root the
 * exporter copies FROM; `snapshotDir` is the destination parent containing
 * per-snapshot subdirectories. Both on the same FS (tmpdir) so rename is atomic.
 */
interface Harness {
  root: string;          // temp root (analog of CORPUS_ROOT)
  imageRoot: string;     // <root>/images-public — SOURCE images
  snapshotDir: string;   // <root>/public-snapshots — destination parent
  writeAsset: (relPath: string, bytes?: Buffer) => void; // create a source image file
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "exporter-test-"));
  const imageRoot = resolve(root, "images-public");
  const snapshotDir = resolve(root, "public-snapshots");
  mkdirSync(imageRoot, { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });
  // Create images-private/ too so a traversal-escape test can place a file there.
  mkdirSync(resolve(root, "images-private"), { recursive: true });
  return {
    root,
    imageRoot,
    snapshotDir,
    writeAsset(relPath, bytes = PNG_BYTES) {
      const abs = resolve(imageRoot, relPath);
      mkdirSync(resolve(abs, ".."), { recursive: true });
      writeFileSync(abs, bytes);
    },
  };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readManifest(snapshotPath: string): PublicSnapshotManifest {
  return JSON.parse(readFileSync(resolve(snapshotPath, "manifest.json"), "utf-8"));
}

function snapshotPaths(h: Harness, id: string): string {
  return resolve(h.snapshotDir, id);
}

// ─── tests ─────────────────────────────────────────────────────────────────────

describe("exportPublicSnapshot", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => {
    try { rmSync(h.root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // Case 1: zero-eligible corpus → succeeds, entryCount: 0, no assets.
  it("zero-eligible corpus → succeeds with entryCount 0 and no assets", () => {
    const result = exportPublicSnapshot({
      corpusEntries: [], // no entries
      snapshotDir: h.snapshotDir,
      imageRoot: h.imageRoot,
      now: NOW,
    });

    expect(result.entryCount).toBe(0);
    const snap = snapshotPaths(h, result.snapshotId);
    expect(existsSync(snap)).toBe(true);
    expect(existsSync(resolve(snap, "manifest.json"))).toBe(true);
    expect(existsSync(resolve(snap, "entries.json"))).toBe(true);
    // No images-public/ tree (nothing to copy) — or an empty one is acceptable;
    // what matters is there are zero assets in the manifest.
    const manifest = readManifest(snap);
    expect(manifest.entryCount).toBe(0);
    expect(manifest.assets).toEqual([]);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.corpusVersion).toBe(2);
    expect(manifest.generatedAt).toBe(NOW);
  });

  // Case 2: one-eligible corpus → snapshot has exactly that entry + asset at
  // images-public/<asset> (path preserved, NOT flattened to images/).
  it("one-eligible corpus → entry + asset copied, images-public/ path preserved", () => {
    h.writeAsset("example.png"); // create real source image
    const entry = eligibleEntry("example-product", "images-public/example.png");

    const result = exportPublicSnapshot({
      corpusEntries: [entry],
      snapshotDir: h.snapshotDir,
      imageRoot: h.imageRoot,
      now: NOW,
    });

    const snap = snapshotPaths(h, result.snapshotId);
    // Asset copied to images-public/example.png (path preserved, not flattened).
    const assetPath = resolve(snap, "images-public/example.png");
    expect(existsSync(assetPath)).toBe(true);
    expect(readFileSync(assetPath)).toEqual(PNG_BYTES);

    // entries.json contains exactly the one eligible entry.
    const entriesJson = JSON.parse(readFileSync(resolve(snap, "entries.json"), "utf-8"));
    expect(entriesJson).toHaveLength(1);
    expect(entriesJson[0].id).toBe("example-product");
    // The entry's image.path is unchanged (no rewriting).
    expect(entriesJson[0].image.path).toBe("images-public/example.png");

    const manifest = readManifest(snap);
    expect(manifest.entryCount).toBe(1);
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0].path).toBe("images-public/example.png");
    expect(manifest.assets[0].bytes).toBe(PNG_BYTES.length);
    expect(manifest.assets[0].sha256).toBe(sha256File(assetPath));
  });

  // Case 3: approved-but-image-missing → entry excluded (image-file-missing).
  it("approved-but-image-missing → entry excluded from snapshot", () => {
    // Entry claims images-public/missing.png but no file exists in imageRoot.
    const entry = eligibleEntry("missing-image-product", "images-public/missing.png");
    expect(existsSync(resolve(h.imageRoot, "missing.png"))).toBe(false);

    const result = exportPublicSnapshot({
      corpusEntries: [entry],
      snapshotDir: h.snapshotDir,
      imageRoot: h.imageRoot,
      now: NOW,
    });

    expect(result.entryCount).toBe(0); // excluded
    const snap = snapshotPaths(h, result.snapshotId);
    const entriesJson = JSON.parse(readFileSync(resolve(snap, "entries.json"), "utf-8"));
    expect(entriesJson).toEqual([]);
  });

  // Case 4: interrupt before rename → no final snapshot dir exists.
  // We simulate a mid-copy failure by pointing imageRoot at a path whose asset
  // exists but is unreadable is hard; instead we pass an onAfterStage hook that
  // throws, OR more simply: verify that a staging dir left behind does NOT appear
  // as a final snapshot. The cleanest simulation: corrupt the source so the copy
  // fails mid-pipeline and assert no <snapshotId> final dir exists.
  it("interrupt before rename → no final snapshot dir exists", () => {
    h.writeAsset("example.png");
    // Make the source image unreadable (chmod 000) so the copy throws mid-stage.
    // On POSIX, open for read still fails with EACCES.
    const srcAsset = resolve(h.imageRoot, "example.png");
    writeFileSync(srcAsset, PNG_BYTES);
    try { (srcAsset as string & { chmodSync?: unknown }); } catch { /* noop */ }
    // Use fs.chmodSync via dynamic require to avoid lint — simpler: delete the
    // file after building the entry list so copyFile fails. But deletion makes
    // imageExists false, so the entry would be filtered out BEFORE copy.
    //
    // The most faithful simulation: inject a failing asset via a path that
    // exists at evaluation time but is removed before copy. We can't easily do
    // that without a hook, so instead test the CONTRACT: a leftover staging dir
    // (the failure residue) must not surface as a final snapshot.
    rmSync(srcAsset, { force: true });

    // Re-create then immediately corrupt by making the parent dir's asset a
    // directory (copyFileSync of a directory throws EISDIR) — gives a real
    // mid-pipeline failure.
    mkdirSync(srcAsset, { recursive: true });

    const entry = eligibleEntry("will-fail", "images-public/example.png");

    expect(() =>
      exportPublicSnapshot({
        corpusEntries: [entry],
        snapshotDir: h.snapshotDir,
        imageRoot: h.imageRoot,
        now: NOW,
      }),
    ).toThrow();

    // No final snapshot directory should exist under snapshotDir — only the
    // staging residue (if any), which is NOT a published snapshot.
    const finalSnapshots = readdirSync(h.snapshotDir).filter(
      (name) => !name.startsWith(".staging-"),
    );
    expect(finalSnapshots).toEqual([]);
  });

  // Case 5: existing snapshot ID → refused (does NOT overwrite).
  it("existing snapshot ID → refused, does NOT overwrite", () => {
    h.writeAsset("example.png");
    const entry = eligibleEntry("example-product", "images-public/example.png");

    const first = exportPublicSnapshot({
      corpusEntries: [entry],
      snapshotDir: h.snapshotDir,
      imageRoot: h.imageRoot,
      now: NOW,
    });

    const snap = snapshotPaths(h, first.snapshotId);
    const manifestBefore = readManifest(snap);

    // Same content → same content-derived ID. Second call must refuse.
    expect(() =>
      exportPublicSnapshot({
        corpusEntries: [entry],
        snapshotDir: h.snapshotDir,
        imageRoot: h.imageRoot,
        now: NOW,
      }),
    ).toThrow(/already exists|refus/i);

    // Untouched.
    expect(readManifest(snap)).toEqual(manifestBefore);
  });

  // Case 6: path-traversal / symlink escape → rejected at copy time (defense in
  // depth). The policy evaluator's image-path-not-public reason already excludes
  // entries whose path doesn't start with images-public/, but the exporter must
  // ALSO defend. We construct an entry the evaluator WOULD pass (path starts with
  // images-public/) but whose resolved real path escapes — via a symlink.
  it("path-traversal / symlink escape → rejected at copy time", () => {
    // Place a secret file OUTSIDE imageRoot that the symlink would resolve to.
    const secretFile = resolve(h.root, "secret.txt");
    writeFileSync(secretFile, "private data");

    // images-public/escape.png -> ../../secret.txt (escapes imageRoot).
    const linkPath = resolve(h.imageRoot, "escape.png");
    symlinkSync(secretFile, linkPath);

    // Entry path is under images-public/ so the policy evaluator's path-prefix
    // gate passes; imageExists sees the symlink target exists. The entry would
    // be "eligible" by the policy — the exporter must catch the escape itself.
    const entry = eligibleEntry("escape-product", "images-public/escape.png");

    let result: ExportResult | null = null;
    expect(() => {
      result = exportPublicSnapshot({
        corpusEntries: [entry],
        snapshotDir: h.snapshotDir,
        imageRoot: h.imageRoot,
        now: NOW,
      });
    }).toThrow();

    // No final snapshot created.
    const finalSnapshots = readdirSync(h.snapshotDir).filter(
      (name) => !name.startsWith(".staging-"),
    );
    expect(finalSnapshots).toEqual([]);
    expect(result).toBeNull();

    // Secret file must NOT have been copied anywhere under snapshotDir.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const p = resolve(dir, d.name);
        return d.isDirectory() ? walk(p) : [p];
      });
    if (existsSync(h.snapshotDir)) {
      for (const f of walk(h.snapshotDir)) {
        expect(readFileSync(f, "utf-8")).not.toContain("private data");
      }
    }
  });

  // Case 7: hashes match bytes on disk (re-read + re-hash after commit).
  it("manifest hashes match bytes on disk after commit", () => {
    h.writeAsset("a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb]));
    h.writeAsset("nested/b.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xcc, 0xdd]));
    const entries = [
      eligibleEntry("product-a", "images-public/a.png"),
      eligibleEntry("product-b", "images-public/nested/b.png"),
    ];

    const result = exportPublicSnapshot({
      corpusEntries: entries,
      snapshotDir: h.snapshotDir,
      imageRoot: h.imageRoot,
      now: NOW,
    });

    const snap = snapshotPaths(h, result.snapshotId);
    const manifest = readManifest(snap);

    // entries.json hash matches a fresh hash of the file bytes.
    const entriesBytes = readFileSync(resolve(snap, "entries.json"));
    expect(createHash("sha256").update(entriesBytes).digest("hex")).toBe(manifest.entriesSha256);

    // Each asset hash + bytes match a fresh read.
    expect(manifest.assets).toHaveLength(2);
    for (const asset of manifest.assets) {
      const abs = resolve(snap, asset.path);
      const bytes = readFileSync(abs);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
      expect(bytes.length).toBe(asset.bytes);
    }
  });
});
