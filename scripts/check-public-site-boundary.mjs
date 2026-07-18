import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkPublicSiteBoundary(root) {
  const publicRoot = resolve(root, "site/public");
  const entryRoot = resolve(publicRoot, "entries");
  if (existsSync(entryRoot) && readdirSync(entryRoot, { recursive: true }).length > 0) {
    throw new Error("site/public/entries must not contain corpus assets");
  }

  const snapshotPath = resolve(publicRoot, "snapshot.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (!Array.isArray(snapshot.entries) || snapshot.entries.length !== 0 || snapshot.count !== 0) {
    throw new Error("site/public/snapshot.json entries must be empty until a separately cleared collection exists");
  }
  return { ok: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkPublicSiteBoundary(process.cwd());
  process.stdout.write("public site boundary: PASS\n");
}
