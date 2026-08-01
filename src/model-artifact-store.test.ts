import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ModelProposalSchema } from "./tool-contracts.js";
import { canonicalJsonStringify, sha256Hex } from "./readiness/contracts.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactStoreModulePath = new URL("./model-artifact-store.js", import.meta.url).href;

function sha(char: string): string {
  return char.repeat(64);
}

function hashCanonical(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJsonStringify(value), "utf-8"));
}

function validProposal() {
  return ModelProposalSchema.parse({
    status: "proposal-only",
    disclaimer: "Proposal only; not accepted into token authority.",
    designDirection: "Use a focused workspace with restrained emphasis.",
    colorTokens: {
      primary: "#2563eb",
      surface: "#ffffff",
      ink: "#111827",
      muted: "#6b7280",
      accent: "#f59e0b",
    },
    typographyTokens: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
    motionNotes: ["Keep view transitions brief and interruptible."],
    contentVoiceGuidance: "Direct, calm, and concise.",
  });
}

function buildRecord(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const proposal = validProposal();
  const parameters = {
    temperature: 0,
    maxOutputTokens: 4096,
    maxAttempts: 1,
    seed: null,
  };
  return {
    recordVersion: "1.0",
    artifactId: `uispec-${sha("a")}`,
    specSha256: sha("b"),
    semanticSpecSha256: sha("c"),
    proposalSha256: hashCanonical(proposal),
    promptSha256: sha("d"),
    parametersSha256: hashCanonical(parameters),
    proposal,
    provider: "openai",
    model: "gpt-5-mini",
    endpointOrigin: "https://api.openai.com",
    parameters,
    usage: { promptTokens: 420, completionTokens: 180 },
    attempts: 1,
    latencyMs: 640,
    storedAt: "2026-08-01T12:00:00.000Z",
    retention: "until-explicit-delete",
    ...overrides,
  };
}

function snapshotPath(path: string): string {
  if (!existsSync(path)) return "missing";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function snapshotCorpusTree(): Record<string, string> {
  return {
    "corpus/entries.json": snapshotPath(resolve(repoRoot, "corpus/entries.json")),
    "corpus/decisions.json": snapshotPath(resolve(repoRoot, "corpus/decisions.json")),
  };
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function loadStoreModule() {
  return import(artifactStoreModulePath);
}

describe("createFileModelArtifactStore", () => {
  it("saves a validated record atomically, keeps retention metadata, and leaves corpus bytes unchanged", async () => {
    const { createFileModelArtifactStore } = await loadStoreModule();
    const parent = mkdtempSync(join(tmpdir(), "model-artifact-store-parent-"));
    const root = join(parent, "history");
    const beforeCorpus = snapshotCorpusTree();
    const record = buildRecord();

    try {
      const store = createFileModelArtifactStore(root);
      await store.save(record);

      const filePath = join(root, `${record.artifactId}.json`);
      expect(existsSync(filePath)).toBe(true);
      expect(readdirSync(root).sort()).toEqual([`${record.artifactId}.json`]);
      expect(readdirSync(root).filter((name) => name.includes(".tmp-"))).toEqual([]);
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual(record);
      await expect(store.read(record.artifactId)).resolves.toEqual(record);
      expect(snapshotCorpusTree()).toEqual(beforeCorpus);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("returns null for a missing record and false when deleting one", async () => {
    const { createFileModelArtifactStore } = await loadStoreModule();
    const root = mkdtempSync(join(tmpdir(), "model-artifact-store-"));

    try {
      const store = createFileModelArtifactStore(root);
      await expect(store.read(`uispec-${sha("f")}`)).resolves.toBeNull();
      await expect(store.delete(`uispec-${sha("f")}`)).resolves.toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes a stored record only when explicitly requested", async () => {
    const { createFileModelArtifactStore } = await loadStoreModule();
    const root = mkdtempSync(join(tmpdir(), "model-artifact-store-"));
    const record = buildRecord();

    try {
      const store = createFileModelArtifactStore(root);
      await store.save(record);
      await expect(store.delete(record.artifactId as string)).resolves.toBe(true);
      await expect(store.read(record.artifactId as string)).resolves.toBeNull();
      await expect(store.delete(record.artifactId as string)).resolves.toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the first stored record on duplicate saves for the same artifactId", async () => {
    const { createFileModelArtifactStore } = await loadStoreModule();
    const root = mkdtempSync(join(tmpdir(), "model-artifact-store-"));
    const first = buildRecord({
      storedAt: "2026-08-01T12:00:00.000Z",
      usage: { promptTokens: 111, completionTokens: 222 },
      latencyMs: 100,
    });
    const second = buildRecord({
      storedAt: "2026-08-01T12:01:00.000Z",
      usage: { promptTokens: 999, completionTokens: 333 },
      latencyMs: 200,
    });

    try {
      const store = createFileModelArtifactStore(root);
      await store.save(first);
      await store.save(second);
      await expect(store.read(first.artifactId as string)).resolves.toEqual(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the first write under concurrent saves for the same artifactId", async () => {
    const { createFileModelArtifactStore } = await loadStoreModule();
    const root = mkdtempSync(join(tmpdir(), "model-artifact-store-"));
    const first = buildRecord({
      storedAt: "2026-08-01T12:00:00.000Z",
      usage: { promptTokens: 111, completionTokens: 222 },
      latencyMs: 100,
    });
    const second = buildRecord({
      storedAt: "2026-08-01T12:01:00.000Z",
      usage: { promptTokens: 999, completionTokens: 333 },
      latencyMs: 200,
    });

    try {
      const store = createFileModelArtifactStore(root);
      const firstSave = store.save(first);
      const secondSave = Promise.resolve().then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await store.save(second);
      });

      await Promise.all([firstSave, secondSave]);
      await expect(store.read(first.artifactId as string)).resolves.toEqual(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back a newly published record when post-publication directory sync fails", async () => {
    const { createFileModelArtifactStore } = await loadStoreModule();
    const root = mkdtempSync(join(tmpdir(), "model-artifact-store-sync-failure-"));
    const record = buildRecord();
    let syncCalls = 0;

    try {
      const store = createFileModelArtifactStore(root, {
        syncDirectory: async () => {
          syncCalls += 1;
          if (syncCalls === 1) throw new Error("post-publication sync failed");
        },
      });

      await expect(store.save(record)).rejects.toThrow("post-publication sync failed");
      await expect(store.read(record.artifactId as string)).resolves.toBeNull();
      expect(readdirSync(root)).toEqual([]);
      expect(syncCalls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws a bounded identifiable error when rollback durability cannot complete", async () => {
    const { createFileModelArtifactStore } = await loadStoreModule();
    const root = mkdtempSync(join(tmpdir(), "model-artifact-store-rollback-incomplete-"));
    const record = buildRecord();

    try {
      const store = createFileModelArtifactStore(root, {
        syncDirectory: async () => {
          throw new Error(`raw sync failure at ${root}`);
        },
      });

      await expect(store.save(record)).rejects.toMatchObject({
        name: "ModelArtifactRollbackIncompleteError",
        code: "MODEL_ARTIFACT_ROLLBACK_INCOMPLETE",
        message: "Model artifact persistence rollback did not complete.",
      });
      await expect(store.read(record.artifactId as string)).resolves.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never deletes a pre-existing first-write-wins record when duplicate cleanup fails", async () => {
    const { createFileModelArtifactStore } = await loadStoreModule();
    const root = mkdtempSync(join(tmpdir(), "model-artifact-store-existing-"));
    const first = buildRecord({ latencyMs: 100 });
    const duplicate = buildRecord({ latencyMs: 200 });

    try {
      const initialStore = createFileModelArtifactStore(root);
      await initialStore.save(first);
      const failingDuplicateStore = createFileModelArtifactStore(root, {
        syncDirectory: async () => {
          throw new Error("duplicate cleanup sync failed");
        },
      });

      await expect(failingDuplicateStore.save(duplicate)).rejects.toThrow(
        "duplicate cleanup sync failed",
      );
      await expect(initialStore.read(first.artifactId as string)).resolves.toEqual(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects EEXIST from random temp-file creation instead of treating it as a duplicate link", async () => {
    const { createFileModelArtifactStore } = await loadStoreModule();
    const root = mkdtempSync(join(tmpdir(), "model-artifact-store-temp-collision-"));
    const record = buildRecord();
    const collision = Object.assign(new Error("random temp file already exists"), {
      code: "EEXIST",
    });

    try {
      const store = createFileModelArtifactStore(root, {
        openTempFile: async () => {
          throw collision;
        },
      });

      await expect(store.save(record)).rejects.toBe(collision);
      await expect(store.read(record.artifactId as string)).resolves.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal-shaped artifact identifiers on save, read, and delete", async () => {
    const { createFileModelArtifactStore } = await loadStoreModule();
    const root = mkdtempSync(join(tmpdir(), "model-artifact-store-"));

    try {
      const store = createFileModelArtifactStore(root);
      await expect(store.save({
        ...buildRecord(),
        artifactId: "../escape",
      })).rejects.toThrow();
      await expect(store.read("../escape")).rejects.toThrow();
      await expect(store.delete("../escape")).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects corrupt JSON already on disk", async () => {
    const { createFileModelArtifactStore } = await loadStoreModule();
    const root = mkdtempSync(join(tmpdir(), "model-artifact-store-"));
    const artifactId = `uispec-${sha("d")}`;

    try {
      writeFileSync(join(root, `${artifactId}.json`), "{\"recordVersion\":", "utf-8");
      const store = createFileModelArtifactStore(root);
      await expect(store.read(artifactId)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("schema-validates reads and rejects malformed stored records", async () => {
    const { createFileModelArtifactStore } = await loadStoreModule();
    const root = mkdtempSync(join(tmpdir(), "model-artifact-store-"));
    const record = buildRecord();
    const badRecord = { ...record };
    delete badRecord.retention;

    try {
      writeFileSync(join(root, `${record.artifactId}.json`), JSON.stringify(badRecord, null, 2), "utf-8");
      const store = createFileModelArtifactStore(root);
      await expect(store.read(record.artifactId as string)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("model-artifact-store import boundary", () => {
  it("does not import persistence, corpus readers, ranking, or discovery", () => {
    const source = stripComments(readFileSync(resolve(repoRoot, "src/model-artifact-store.ts"), "utf-8"));
    const forbiddenImportLines = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) =>
        /^import\b.*from\s+["'](?:\.\/persistence\.js|\.\/corpus\.js|\.\/corpus-reader\.js|\.\/recommend\.js|\.\/embeddings\.js|\.\/image-index\.js|\.\/references\/loader\.js)["']/.test(
          line,
        ),
      );

    expect(
      forbiddenImportLines,
      `model-artifact-store.ts imports from a forbidden module: ${JSON.stringify(forbiddenImportLines)}`,
    ).toEqual([]);
  });
});
