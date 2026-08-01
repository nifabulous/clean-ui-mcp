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

interface FileModelArtifactStoreOptions {
  /** Test seam for deterministic post-publication durability failures. */
  readonly syncDirectory?: (path: string) => Promise<void>;
}

/**
 * One-file-per-artifact history store with first-write-wins semantics.
 *
 * Node's rename API overwrites existing files, so publishing a synced temp file
 * via an exclusive hard-link gives us the no-clobber property the contract
 * requires while still installing fully-written bytes atomically.
 */
export function createFileModelArtifactStore(
  rootDir: string,
  options: FileModelArtifactStoreOptions = {},
): ModelArtifactStore {
  const resolvedRoot = resolve(rootDir);
  const inflightSaves = new Map<string, Promise<void>>();

  async function ensureRoot(): Promise<void> {
    await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  }

  function artifactPath(artifactId: string): string {
    const safeArtifactId = ArtifactIdSchema.parse(artifactId);
    return resolve(resolvedRoot, `${safeArtifactId}.json`);
  }

  async function syncDirectoryDurably(path: string): Promise<void> {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const syncDirectory = options.syncDirectory ?? syncDirectoryDurably;

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
    let tempExists = false;
    let published = false;

    try {
      const handle = await open(tempPath, "wx", 0o600);
      tempExists = true;
      try {
        const body = `${JSON.stringify(parsed, null, 2)}\n`;
        await handle.writeFile(body, "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      await link(tempPath, destination);
      published = true;
      await unlink(tempPath);
      tempExists = false;
      await syncDirectory(dirname(destination));
    } catch (error) {
      const duplicate = !published && isErrno(error, "EEXIST");
      const cleanupErrors: unknown[] = [];

      if (published) {
        await unlink(destination).catch((cleanupError) => {
          if (!isErrno(cleanupError, "ENOENT")) cleanupErrors.push(cleanupError);
        });
      }
      if (tempExists) {
        await unlink(tempPath).catch((cleanupError) => {
          if (!isErrno(cleanupError, "ENOENT")) cleanupErrors.push(cleanupError);
        });
      }
      if (published || tempExists || duplicate) {
        await syncDirectory(dirname(destination)).catch((cleanupError) => {
          cleanupErrors.push(cleanupError);
        });
      }

      if (duplicate && cleanupErrors.length === 0) return;
      if (duplicate && cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "model artifact store failed and cleanup did not complete",
        );
      }
      throw error;
    }
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
