import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ModelArtifactRecordSchema,
  type ModelArtifactRecord,
} from "./create-ui-spec-model-contracts.js";

const ArtifactIdSchema = ModelArtifactRecordSchema.shape.artifactId;

export interface ModelArtifactStore {
  save(record: ModelArtifactRecord): Promise<void>;
  read(artifactId: string): Promise<ModelArtifactRecord | null>;
  delete(artifactId: string): Promise<boolean>;
}

/**
 * One-file-per-artifact history store with first-write-wins semantics.
 *
 * Node's rename API overwrites existing files, so publishing a synced temp file
 * via an exclusive hard-link gives us the no-clobber property the contract
 * requires while still installing fully-written bytes atomically.
 */
export function createFileModelArtifactStore(rootDir: string): ModelArtifactStore {
  const resolvedRoot = resolve(rootDir);
  const inflightSaves = new Map<string, Promise<void>>();

  async function ensureRoot(): Promise<void> {
    await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  }

  function artifactPath(artifactId: string): string {
    const safeArtifactId = ArtifactIdSchema.parse(artifactId);
    return resolve(resolvedRoot, `${safeArtifactId}.json`);
  }

  async function syncDirectory(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  return {
    async save(record: ModelArtifactRecord): Promise<void> {
      const parsed = ModelArtifactRecordSchema.parse(record);
      const existingSave = inflightSaves.get(parsed.artifactId);
      if (existingSave) {
        await existingSave;
        return;
      }

      const savePromise = persistRecord(parsed);
      inflightSaves.set(parsed.artifactId, savePromise);

      try {
        await savePromise;
      } finally {
        if (inflightSaves.get(parsed.artifactId) === savePromise) {
          inflightSaves.delete(parsed.artifactId);
        }
      }
    },

    async read(artifactId: string): Promise<ModelArtifactRecord | null> {
      const destination = artifactPath(artifactId);
      let jsonText: string;
      try {
        jsonText = await readFile(destination, "utf-8");
      } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(jsonText);
      } catch {
        throw new Error(`[model-artifact-store] stored record for ${artifactId} is not valid JSON`);
      }

      return ModelArtifactRecordSchema.parse(parsedJson);
    },

    async delete(artifactId: string): Promise<boolean> {
      const destination = artifactPath(artifactId);
      try {
        await unlink(destination);
        await syncDirectory(dirname(destination));
        return true;
      } catch (error) {
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      }
    },
  };

  async function persistRecord(parsed: ModelArtifactRecord): Promise<void> {
    await ensureRoot();

    const destination = artifactPath(parsed.artifactId);
    const tempPath = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    const handle = await open(tempPath, "wx", 0o600);
    let published = false;

    try {
      const body = `${JSON.stringify(parsed, null, 2)}\n`;
      await handle.writeFile(body, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(tempPath, destination);
      published = true;
      await syncDirectory(dirname(destination));
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    } finally {
      await unlink(tempPath).catch((error) => {
        if (!isErrno(error, "ENOENT")) throw error;
      });
      if (published) {
        await syncDirectory(dirname(destination));
      }
    }
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
