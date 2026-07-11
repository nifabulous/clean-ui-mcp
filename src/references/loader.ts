import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ReferenceAuthority, ReferenceDescriptor, ReferencePurpose } from "./types.js";

const MANIFEST_PATH = "skill/clean-ui-design/references/manifest.json";
const AUTHORITIES = new Set<ReferenceAuthority>(["machine-rule", "editorial", "external-standard"]);
const PURPOSES = new Set<ReferencePurpose>([
  "critique-structure", "text-anti-slop", "visual-anti-slop", "motion-guidance", "design-taxonomy",
]);

function fail(id: string, field: string, detail: string): never {
  throw new Error(`Reference ${id}: invalid ${field} (${detail})`);
}

function nonEmptyString(value: unknown, id: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(id, field, "expected a non-empty string");
  return value;
}

function parseDescriptor(value: unknown, index: number): ReferenceDescriptor {
  const provisionalId = typeof value === "object" && value !== null && "id" in value
    ? String((value as { id: unknown }).id)
    : `descriptor[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(provisionalId, "descriptor", "expected an object");
  const item = value as Record<string, unknown>;
  const id = nonEmptyString(item.id, provisionalId, "id");
  if (!Number.isInteger(item.version) || (item.version as number) < 1) fail(id, "version", "expected a positive integer");
  const path = nonEmptyString(item.path, id, "path");
  const sha256 = nonEmptyString(item.sha256, id, "sha256");
  if (!/^[0-9a-f]{64}$/i.test(sha256)) fail(id, "sha256", "expected 64 hexadecimal characters");
  const authority = nonEmptyString(item.authority, id, "authority") as ReferenceAuthority;
  if (!AUTHORITIES.has(authority)) fail(id, "authority", "unapproved value");
  if (!Array.isArray(item.purposes) || item.purposes.length === 0) fail(id, "purposes", "expected a non-empty array");
  const purposes = item.purposes.map((purpose) => {
    if (typeof purpose !== "string" || !PURPOSES.has(purpose as ReferencePurpose)) fail(id, "purposes", `unapproved value ${String(purpose)}`);
    return purpose as ReferencePurpose;
  });
  const sourceUrl = nonEmptyString(item.sourceUrl, id, "sourceUrl");
  const sourceCommit = nonEmptyString(item.sourceCommit, id, "sourceCommit");
  if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) fail(id, "sourceCommit", "expected 40 hexadecimal characters");
  const license = nonEmptyString(item.license, id, "license");
  return { id, version: item.version as number, path, sha256, authority, purposes, sourceUrl, sourceCommit, license };
}

function parseManifest(raw: string, source: string): ReferenceDescriptor[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch (error) { throw new Error(`Reference manifest ${source}: invalid JSON: ${(error as Error).message}`); }
  if (!Array.isArray(value)) throw new Error(`Reference manifest ${source}: expected an array`);
  return value.map(parseDescriptor);
}

function previousManifest(root: string): ReferenceDescriptor[] | undefined {
  const result = spawnSync("git", ["show", `HEAD^:${MANIFEST_PATH}`], { cwd: root, encoding: "utf8" });
  if (result.error) throw new Error(`Could not read previous reference manifest: ${result.error.message}`);
  if (result.status !== 0) {
    const absent = /does not exist in|exists on disk, but not in|invalid object name|bad revision/i.test(result.stderr);
    if (!absent) throw new Error(`Could not read previous reference manifest: ${result.stderr.trim()}`);
    return undefined;
  }
  return parseManifest(result.stdout, "from HEAD^");
}

function validateVersionPolicy(current: ReferenceDescriptor[], previous: ReferenceDescriptor[]): void {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  for (const item of current) {
    const old = previousById.get(item.id);
    if (!old) continue;
    const expectedVersion = item.sha256 === old.sha256 ? old.version : old.version + 1;
    if (item.version !== expectedVersion) {
      fail(item.id, "version", item.sha256 === old.sha256
        ? `content is unchanged; expected ${expectedVersion}`
        : `content changed; expected ${expectedVersion}`);
    }
  }
}

export function validateReferenceRegistry(root: string): ReferenceDescriptor[] {
  const repositoryRoot = resolve(root);
  const realRepositoryRoot = realpathSync(repositoryRoot);
  const manifestPath = resolve(repositoryRoot, MANIFEST_PATH);
  const descriptors = parseManifest(readFileSync(manifestPath, "utf8"), MANIFEST_PATH);
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const item of descriptors) {
    if (ids.has(item.id)) fail(item.id, "id", "duplicate");
    ids.add(item.id);
    if (paths.has(item.path)) fail(item.id, "path", "duplicate");
    paths.add(item.path);
    if (isAbsolute(item.path)) fail(item.id, "path", "absolute paths are forbidden");
    const fullPath = resolve(repositoryRoot, item.path);
    const fromRoot = relative(repositoryRoot, fullPath);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
      fail(item.id, "path", "path escapes repository root");
    }
    if (!existsSync(fullPath)) fail(item.id, "path", "file does not exist");
    const realFilePath = realpathSync(fullPath);
    const realFromRoot = relative(realRepositoryRoot, realFilePath);
    if (realFromRoot === "" || realFromRoot === ".." || realFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(realFromRoot)) {
      fail(item.id, "path", "symlink target escapes repository root");
    }
    const actualHash = createHash("sha256").update(readFileSync(fullPath)).digest("hex");
    if (actualHash !== item.sha256.toLowerCase()) fail(item.id, "sha256", `expected ${item.sha256}, received ${actualHash}`);
  }
  const previous = previousManifest(repositoryRoot);
  if (previous) validateVersionPolicy(descriptors, previous);
  return Object.freeze(descriptors.map((item) => Object.freeze({
    ...item,
    purposes: Object.freeze([...item.purposes]) as unknown as ReferencePurpose[],
  }))) as unknown as ReferenceDescriptor[];
}

export function selectReferences(
  descriptors: readonly ReferenceDescriptor[],
  purposes: readonly ReferencePurpose[],
): ReferenceDescriptor[] {
  const requested = new Set(purposes);
  return descriptors.filter((descriptor) => descriptor.purposes.some((purpose) => requested.has(purpose)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const descriptors = validateReferenceRegistry(process.cwd());
  console.log(`Validated ${descriptors.length} references.`);
}
