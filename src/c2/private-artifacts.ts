/**
 * C2 private/durable artifact boundary + atomic writes (Task 6, Step 6).
 *
 * Boundary (spec §13): raw responses, parsed candidates, detailed evidence
 * payloads, and full condition inputs live under a gitignored private run
 * directory (`.c2-private/`). Durable artifacts (deterministic scores,
 * calibration proposals, frozen calibration) may be committed ONLY after a
 * boundary scan proves they contain hashes + permitted metadata, NOT prompt
 * text, evidence content, raw output, credentials, authorization headers,
 * private corpus paths, or private markers.
 *
 * This module supplies two primitives:
 *
 *   1. `scanDurableArtifact(jsonText, config)` — pure string scanner. Rejects
 *      JSON containing:
 *        - any configured secret value (literal env-var value),
 *        - prompt/evidence/raw content fields (by key name),
 *        - `.c2-private/` paths,
 *        - corpus private paths (`images-private`, `corpus/.snapshots`,
 *          `images-public`),
 *        - case private markers (`/corpus/private/...`).
 *
 *   2. `writePrivateArtifact` / `writeDurableArtifact` — atomic write lifecycle.
 *      Private writes go straight to the private dir (no scan — everything
 *      under `.c2-private/` is private by construction). Durable writes run the
 *      scan FIRST and only then write; a scan failure leaves NO file on disk.
 *
 * Atomicity: write to a temp file descriptor on the same filesystem, `fsync`,
 * close, then `rename` over the target. Any failure unlinks the temp file so
 * no half-written artifact litters the directory. The temp file lives in the
 * SAME directory as the destination so the rename is atomic on POSIX (rename
 * across filesystems is not atomic).
 */
import { open, rename, unlink, mkdir, type FileHandle } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, relative } from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Boundary scan configuration
// ---------------------------------------------------------------------------

/**
 * Secrets + forbidden tokens for the durable-artifact boundary scan.
 *
 * `secretValues` are literal secret values (e.g. an API key string the caller
 * has resolved from the environment). They are matched as substrings against
 * the serialized JSON, so a secret that appears anywhere in the artifact fails
 * the scan. Empty-string entries are ignored (a sentinel used by tests / when
 * no secrets are configured).
 *
 * `secretEnvNames` are environment-variable NAMES (e.g. `OPENAI_API_KEY`). They
 * are NOT secret values — they are matched only against the artifact's keys to
 * reject a field literally named after a secret env var (a leak shape like
 * `{"OPENAI_API_KEY": "sk-..."}`). The VALUE of that env var is matched via
 * `secretValues` (the caller resolves it).
 */
export interface BoundaryScanConfig {
  secretValues: readonly string[];
  secretEnvNames: readonly string[];
}

// Exact field names that mark prompt/evidence/raw CONTENT (not hashes or
// counts of them). A durable artifact carries hashes and metadata only; a
// field literally named one of these carries the actual sensitive bytes.
//
// We match EXACT names rather than prefixes so that legitimate hash/count
// fields on the V2 manifest — `promptSha256`, `promptTokens`, `rawOutputSha256`,
// `parsedOutputSha256`, `completionTokens` — are NOT rejected. Those carry
// hashes and integer counts, not content.
const FORBIDDEN_CONTENT_FIELDS = [
  "prompt",
  "promptText",
  "promptContent",
  "promptBody",
  "evidenceContent",
  "evidencePayload",
  "evidenceBytes",
  "rawResponse",
  "rawResponseBody",
  "rawRequest",
  "rawRequestBody",
  "responseBody",
  "requestBody",
  "authorizationHeader",
  "apiKey",
  "apiSecret",
  "bearerToken",
] as const;

// Path substrings that mark private/corpus-private locations. A durable
// artifact must never reference the private run directory, corpus private
// image trees, the corpus snapshot directory, or the public snapshot tree
// (those are distributable but not part of a durable condition/score/calibration
// artifact).
const FORBIDDEN_PATH_SUBSTRINGS = [
  ".c2-private/",
  ".c2-private\\",
  "images-private/",
  "images-private\\",
  "corpus/.snapshots",
  "corpus\\\\.snapshots",
  "corpus/.dhash-cache",
  "corpus/private/",
  "corpus/private\\",
  "/corpus/private/",
  "\\corpus\\private\\",
] as const;

// Case private marker shapes from the pilot labels. A durable artifact must
// never carry the literal synthetic private-marker form.
const CASE_PRIVATE_MARKER_PATTERNS = [
  /\/corpus\/private\//,
  /\\corpus\\private\\/,
] as const;

/**
 * Pure string scanner. Throws on the first forbidden token; returns void on
 * success. Operates on the raw serialized JSON text so a field name buried in
 * a nested object is still caught.
 */
export function scanDurableArtifact(jsonText: string, config: BoundaryScanConfig): void {
  // 1. Secret values (literal substring match). Skip empty sentinels.
  for (const secret of config.secretValues) {
    if (secret && secret.length > 0 && jsonText.includes(secret)) {
      throw new Error(
        `[c2-boundary] durable artifact rejected: contains a configured secret value `
        + `(${secret.length}-char string). Durable artifacts must never carry secret material.`,
      );
    }
  }

  // 2. Secret env-var names as field KEYS. We reject a field literally named
  //    after a secret env var — that's a leak shape (the field name exposes
  //    which secret was used, and its value is almost certainly the secret).
  for (const envName of config.secretEnvNames) {
    if (!envName) continue;
    // Match `"ENV_NAME"` as a JSON key, with optional whitespace inside the
    // quotes — catches `{"OPENAI_API_KEY": "..."}`.
    const keyPattern = new RegExp(`"\\s*${escapeRegex(envName)}\\s*"\\s*:`, "g");
    if (keyPattern.test(jsonText)) {
      throw new Error(
        `[c2-boundary] durable artifact rejected: carries a field named after `
        + `secret env var '${envName}'. Durable artifacts must never name or carry secret values.`,
      );
    }
  }

  // 3. Forbidden content fields (exact-name match).
  //    Parse-free scan: look for `"fieldName":` patterns. Exact match (not
  //    prefix) so hash/count fields like `promptSha256` and `rawOutputSha256`
  //    are not falsely rejected.
  for (const fieldName of FORBIDDEN_CONTENT_FIELDS) {
    const pattern = new RegExp(`"\\s*${escapeRegex(fieldName)}\\s*"\\s*:`, "g");
    if (pattern.test(jsonText)) {
      throw new Error(
        `[c2-boundary] durable artifact rejected: carries a forbidden content field `
        + `('${fieldName}'). Durable artifacts carry hashes + metadata only, not prompt/`
        + `evidence/raw content.`,
      );
    }
  }

  // 4. Forbidden path substrings (private run dir, corpus private trees).
  for (const pathSub of FORBIDDEN_PATH_SUBSTRINGS) {
    if (jsonText.includes(pathSub)) {
      throw new Error(
        `[c2-boundary] durable artifact rejected: references a private path `
        + `(${JSON.stringify(pathSub)}). Durable artifacts must not point at the private run `
        + `directory or corpus-private locations.`,
      );
    }
  }

  // 5. Case private markers (regex — the synthetic /corpus/private/ form used
  //    inside pilot labels).
  for (const pattern of CASE_PRIVATE_MARKER_PATTERNS) {
    if (pattern.test(jsonText)) {
      throw new Error(
        `[c2-boundary] durable artifact rejected: carries a case private marker `
        + `(${pattern.source}). Markers stay inside reviewer-only labels.`,
      );
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

/**
 * Atomically write `bytes` to `privateRoot/relPath`.
 *
 * Lifecycle: open temp file descriptor (same dir as the destination so the
 * final rename is atomic on POSIX) → write → fsync → close → rename. On ANY
 * failure the temp file is unlinked so no half-written artifact litters the
 * private dir.
 *
 * The temp file name includes a random suffix (not just PID) so concurrent
 * writes to the same destination do not collide.
 *
 * Returns the absolute destination path on success.
 */
export async function writePrivateArtifact(
  privateRoot: string,
  relPath: string,
  bytes: Buffer,
): Promise<string> {
  const dest = resolveUnder(privateRoot, relPath);
  const dir = dirname(dest);
  await mkdir(dir, { recursive: true });
  // Temp file in the SAME directory so rename is atomic on POSIX.
  const tmp = `${dest}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(tmp, "w");
    // `open` from node:fs/promises returns a FileHandle. Write the bytes,
    // fsync the file data to disk, then close before the rename so the
    // descriptor is released atomically with the durability guarantee.
    await handle.writeFile(bytes);
    await handle.sync(); // fsync — durability
    await handle.close();
    handle = null;
    await rename(tmp, dest);
    return dest;
  } catch (err) {
    if (handle !== null) {
      try { await handle.close(); } catch { /* ignore secondary close error */ }
    }
    try { await unlink(tmp); } catch { /* temp may not exist yet — ignore */ }
    throw new Error(
      `[c2-private] atomic write failed for ${relPath}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Atomically write a durable (committable) artifact. Runs the boundary scan
 * FIRST and only then writes; a scan failure leaves NO file on disk and NO
 * temp file either.
 *
 * `destRoot` is the durable artifacts root (typically a tracked directory like
 * `eval/c2/pilot/scores/`). `relPath` is the artifact's path relative to that
 * root.
 */
export async function writeDurableArtifact(
  destRoot: string,
  relPath: string,
  jsonText: string,
  config: BoundaryScanConfig,
): Promise<string> {
  // Boundary scan BEFORE touching the filesystem. A failure here is the
  // enforcement: no temp file, no partial write, no chance the artifact lands.
  scanDurableArtifact(jsonText, config);
  return writePrivateArtifact(destRoot, relPath, Buffer.from(jsonText, "utf-8"));
}

/**
 * Resolve `relPath` against `root` and reject any `..` traversal or absolute
 * path that would escape `root`. Keeps the private write target contained.
 */
function resolveUnder(root: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new Error(`[c2-private] relPath must be relative (got: ${relPath})`);
  }
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `[c2-private] relPath escapes root: ${relPath} (resolves outside ${root})`,
    );
  }
  return abs;
}

// Re-export for tests that want to assert the temp-file cleanup via the
// filesystem (no public consumers besides tests).
export const __test = { resolveUnder, FORBIDDEN_CONTENT_FIELDS, FORBIDDEN_PATH_SUBSTRINGS };

// Avoid an unused-import warning when existsSync is tree-shaken out of
// production builds that only use the scan function.
void existsSync;
