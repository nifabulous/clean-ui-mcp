#!/usr/bin/env node
/**
 * validate-public-pipeline — non-destructive end-to-end pipeline validation.
 *
 * PROBLEM: the exporter + PublicCorpusReader + MCP tools were tested against
 * synthetic fixtures (Gate 1A T5/T7), but never against the REAL 787-entry
 * corpus. We need to prove the full pipeline works at real scale.
 *
 * CONSTRAINT: we must NOT modify the working corpus. The entries are private
 * (third-party screenshots with no rights clearance). Moving files, rewriting
 * entries.json, or stamping publication blocks would be destructive and
 * bypass the publication-safety invariant the pipeline exists to enforce.
 *
 * SOLUTION: an isolated validation harness that:
 *   1. Reads the real corpus (read-only — never writes entries.json).
 *   2. Creates a TEMP workspace with COPIED (not moved) images.
 *   3. Writes SYNTHETIC transformed entries (with placeholder publication
 *      blocks) ONLY inside the workspace — never to the real corpus.
 *   4. Exports a public snapshot from the workspace.
 *   5. Loads it via PublicCorpusReader and verifies the entry count.
 *   6. Deletes the workspace (always — success or failure).
 *
 * The placeholder rightsBasis:"owned" claim exists ONLY inside the temp
 * workspace, never in the real corpus. The workspace is under os.tmpdir(),
 * not under corpus/, and is deleted on exit.
 *
 * Usage:
 *   npx tsx src/scripts/validate-public-pipeline.ts
 *   npx tsx src/scripts/validate-public-pipeline.ts --keep  # keep workspace for debugging
 */
import { readFileSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "..", "..", "corpus", "entries.json");
const CORPUS_ROOT = resolve(__dirname, "..", "..", "corpus");

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const KEEP = process.argv.includes("--keep");
const METADATA_ONLY = process.argv.includes("--metadata-only");

const today = new Date().toISOString().slice(0, 10);

const PLACEHOLDER_PUBLICATION = {
  visibility: "public" as const,
  clearance: "approved" as const,
  rightsBasis: "owned" as const,
  evidenceRef: "pipeline-validation-harness",
  reviewedAt: today,
  reviewedBy: "validate-public-pipeline",
};

/**
 * Transform an entry for the validation workspace: add a placeholder
 * publication block and rewrite the image path. In metadata-only mode,
 * the path is nulled (no image bytes ship — link-only entry). In raster
 * mode, the path is rewritten to images-public/.
 * This transform is applied to a COPY — the original entry is never touched.
 */
export function transformForValidation(
  entry: Record<string, unknown>,
  metadataOnly = false,
): Record<string, unknown> {
  // DEEP-copy the image sub-object so the original entry's image is not
  // mutated (the shallow {...entry} spread shares the image reference).
  const oldImage = entry.image as { visibility: string; path: string | null; width: number | null; height: number | null };
  if (metadataOnly) {
    // Link-only: null the path so no image bytes ship. The entry's value
    // is its structured analysis; source.url links to the original.
    return {
      ...entry,
      publication: { ...PLACEHOLDER_PUBLICATION },
      image: { visibility: "private", path: null, width: null, height: null },
    };
  }
  const oldPath = oldImage.path;
  let newPath = oldPath;
  if (oldPath && oldPath.startsWith("images-private/")) {
    const filename = oldPath.replace(/^images-private\//, "");
    newPath = `images-public/${filename}`;
  }
  const transformed: Record<string, unknown> = {
    ...entry,
    publication: { ...PLACEHOLDER_PUBLICATION },
    image: { ...oldImage, visibility: "public-own", path: newPath },
  };
  return transformed;
}

if (isMain) {
  if (!existsSync(CORPUS_PATH)) {
    console.error(`entries.json not found at ${CORPUS_PATH}`);
    process.exit(1);
  }

  // ── 1. Read the real corpus (read-only) ────────────────────────────────
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf-8"));
  const entries: Record<string, unknown>[] = raw.entries ?? raw;
  console.log(`Read ${entries.length} entries from the real corpus (read-only).`);

  // ── 2. Create a temp workspace ────────────────────────────────────────
  const workspace = resolve(tmpdir(), `clean-ui-pipeline-validation-${Date.now()}`);
  const workspaceImages = resolve(workspace, "images-public");
  mkdirSync(workspaceImages, { recursive: true });
  console.log(`Created temp workspace: ${workspace}`);

  // Ensure cleanup runs on any exit path (success, error, signal).
  const cleanup = (): void => {
    if (KEEP) {
      console.log(`--keep: workspace preserved at ${workspace}`);
      return;
    }
    try {
      rmSync(workspace, { recursive: true, force: true });
      console.log("Workspace cleaned up.");
    } catch {
      // Best-effort — the OS will clean tmpdir eventually.
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  try {
    // ── 3. Copy images + transform entries IN THE WORKSPACE ──────────────
    // In metadata-only mode, entries get null paths (no image bytes). No copy
    // needed. In raster mode, ALWAYS copy regardless of --keep (which only
    // controls cleanup). Skipping the copy would cause the exporter to exclude
    // every entry (missing image → image-file-missing reason), producing a
    // 0-entry snapshot that trivially passes the count checks.
    let copied = 0;
    const missingSources: string[] = [];
    const transformedEntries = entries.map((entry) => {
      const transformed = transformForValidation(entry, METADATA_ONLY);
      if (!METADATA_ONLY) {
        const oldPath = (entry.image as { path: string | null }).path;
        if (oldPath && oldPath.startsWith("images-private/")) {
          const filename = oldPath.replace(/^images-private\//, "");
          const src = resolve(CORPUS_ROOT, "images-private", filename);
          const dst = resolve(workspaceImages, filename);
          if (existsSync(src)) {
            mkdirSync(dirname(dst), { recursive: true });
            copyFileSync(src, dst);
            copied++;
          } else {
            missingSources.push(oldPath);
          }
        }
      }
      return transformed;
    });

    if (!METADATA_ONLY) {
      if (missingSources.length > 0) {
        throw new Error(
          `${missingSources.length} source image(s) missing from images-private/ (expected ${entries.length}, `
          + `found ${copied}). Pipeline validation requires ALL entries to have their source images present. `
          + `First few missing: ${missingSources.slice(0, 5).join(", ")}${missingSources.length > 5 ? " ..." : ""}`,
        );
      }
      console.log(`Copied ${copied} images to workspace.`);
    } else {
      console.log(`Metadata-only mode: no images to copy (${entries.length} link-only entries).`);
    }

    // ── 4. Export a public snapshot from the workspace ───────────────────
    const { exportPublicSnapshot } = await import("../publication/exporter.js");
    const result = await exportPublicSnapshot({
      corpusEntries: transformedEntries as never[],
      snapshotDir: resolve(workspace, "snapshots"),
      imageRoot: workspaceImages,
      now: new Date().toISOString(),
    });
    console.log(`\nExport: ${result.entryCount} entries, ${result.assetCount} assets, snapshot ${result.snapshotId}.`);

    // ── 5. Load via PublicCorpusReader ───────────────────────────────────
    const { PublicCorpusReader } = await import("../corpus-reader.js");
    const reader = new PublicCorpusReader(result.snapshotPath);
    const loaded = reader.entriesForAggregation();
    console.log(`PublicCorpusReader loaded: ${loaded.length} entries.`);
    console.log(`indexStatus: ${JSON.stringify(reader.indexStatus())}`);

    // ── 6. Verify (compare against INPUT, not the exporter's filtered output) ─
    // The exporter may silently exclude entries (image-missing, policy fail).
    // Comparing exporter-count to reader-count (0 === 0) is a false positive.
    // Instead: every input entry must survive export AND load.
    if (result.entryCount !== entries.length) {
      throw new Error(
        `Exporter produced ${result.entryCount} entries but the input corpus has ${entries.length}. `
        + `Some entries were excluded — investigate the exporter's policy evaluation.`,
      );
    }
    if (loaded.length !== entries.length) {
      throw new Error(
        `Reader loaded ${loaded.length} but the input corpus has ${entries.length} entries. `
        + `The snapshot may have been corrupted or entries filtered at load time.`,
      );
    }

    // Verify every loaded entry's image actually resolves (no NULL paths).
    for (const entry of loaded) {
      if (entry.image.path) {
        const resolved = reader.resolveImagePath(entry.image.path);
        if (!resolved) {
          throw new Error(
            `resolveImagePath returned null for entry ${entry.id} (${entry.image.path}). `
            + `The image file is missing from the snapshot.`,
          );
        }
      }
    }

    console.log(`\n✅ Pipeline validation PASSED: ${loaded.length}/${entries.length} entries served from a public snapshot.`);
    console.log(`   All ${result.assetCount} assets resolve. The real corpus was not modified.`);
    console.log(`   The workspace is ${KEEP ? "preserved" : "cleaned up"}.`);
  } catch (err) {
    console.error(`\n❌ Pipeline validation FAILED: ${err instanceof Error ? err.message : err}`);
    console.error(`   The real corpus was not modified. Workspace: ${workspace}`);
    if (!KEEP) {
      console.error("   (re-run with --keep to preserve the workspace for debugging)");
    }
    throw err;
  }
}
