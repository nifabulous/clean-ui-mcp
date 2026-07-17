import { describe, it, expect } from "vitest";
import { safeOrphanPaths } from "./orphans.js";
import type { CorpusEntryT } from "./schema.js";

// safeOrphanPaths only reads e.image.path from entries, so a narrow cast is
// enough — we don't need a full schema-valid entry to exercise the logic.
const entry = (imagePath: string | null): CorpusEntryT =>
  ({ image: { path: imagePath } }) as unknown as CorpusEntryT;

describe("safeOrphanPaths", () => {
  it("never returns anything under images-private/captures/", () => {
    const { orphans } = safeOrphanPaths({
      entries: [],
      privateFiles: [
        "images-private/captures/batch-1/shot.png",
        "images-private/captures/batch-1/manifest.json",
        "images-private/loose-orphan.png",
      ],
    });
    expect(orphans).toEqual(["images-private/loose-orphan.png"]);
  });

  it("protects images referenced by decisions.json", () => {
    const decisionsRaw = JSON.stringify({
      version: 1,
      decisions: [
        {
          id: "d1",
          title: "t",
          createdAt: "2026-07-17",
          directions: [
            { name: "a", screens: [{ imageRef: "images-private/decisions/d1/screen.png" }] },
          ],
        },
      ],
    });
    const { orphans } = safeOrphanPaths({
      entries: [],
      privateFiles: ["images-private/decisions/d1/screen.png"],
      decisionsRaw,
    });
    expect(orphans).toEqual([]);
  });

  it("protects images referenced by entries-draft.json", () => {
    // Draft file shape is { version: 1, exportedAt, entries: [{ image: { path } }] }
    // (confirmed in src/scripts/commit-draft.ts and src/scripts/bulk-import.ts).
    const draftRaw = JSON.stringify({
      version: 1,
      exportedAt: "2026-07-17T00:00:00.000Z",
      entries: [{ image: { path: "images-private/staged/draft-img.png" } }],
    });
    const { orphans } = safeOrphanPaths({
      entries: [],
      privateFiles: ["images-private/staged/draft-img.png"],
      draftRaw,
    });
    expect(orphans).toEqual([]);
  });

  it("with corrupt decisionsRaw, deletes nothing under images-private/decisions/", () => {
    const { orphans } = safeOrphanPaths({
      entries: [],
      privateFiles: ["images-private/decisions/d1/screen.png", "images-private/loose.png"],
      decisionsRaw: "{not json",
    });
    // Fail-closed: if we can't parse the manifest that references these files,
    // we must not treat its subtree as deletable.
    expect(orphans).toEqual(["images-private/loose.png"]);
  });

  it("still reports genuine orphans", () => {
    const { orphans } = safeOrphanPaths({
      entries: [entry("images-private/kept.png")],
      privateFiles: ["images-private/kept.png", "images-private/orphan.png"],
    });
    expect(orphans).toEqual(["images-private/orphan.png"]);
  });
});
