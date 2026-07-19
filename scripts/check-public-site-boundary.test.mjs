import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPublicSiteBoundary } from "./check-public-site-boundary.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clean-ui-public-boundary-"));
  roots.push(root);
  mkdirSync(join(root, "site/public"), { recursive: true });
  writeFileSync(
    join(root, "site/public/snapshot.json"),
    JSON.stringify({
      count: 0,
      generatedAt: "2026-07-18T00:00:00.000Z",
      categories: [],
      styleTags: [],
      entries: [],
    }),
  );
  return root;
}

describe("public site disclosure boundary", () => {
  it("accepts a corpus-free synthetic snapshot", () => {
    expect(checkPublicSiteBoundary(fixture())).toEqual({ ok: true });
  });

  it("passes when site/public does not exist yet (no content to leak)", () => {
    // Before the public-site reconstruction lands, site/public/ is absent.
    // The boundary holds trivially.
    const root = mkdtempSync(join(tmpdir(), "clean-ui-public-boundary-empty-"));
    roots.push(root);
    expect(checkPublicSiteBoundary(root)).toEqual({ ok: true });
  });

  it("rejects public entry image directories (entries/private.png)", () => {
    const root = fixture();
    mkdirSync(join(root, "site/public/entries"));
    writeFileSync(join(root, "site/public/entries/private.png"), "private");
    expect(() => checkPublicSiteBoundary(root)).toThrow(/site\/public\/entries/);
  });

  // P1 #3 regression: the original checker gated only entries/ and snapshot.json,
  // so a corpus asset placed ANYWHERE ELSE passed and was emitted by the bundler.
  // The allowlist now rejects any unsanctioned file regardless of location.
  it("rejects a leak OUTSIDE entries/ (the original P1 #3 bypass)", () => {
    const root = fixture();
    // Top-level leak.
    writeFileSync(join(root, "site/public/private-corpus.png"), "private-image");
    expect(() => checkPublicSiteBoundary(root)).toThrow(/not on the sanctioned public-asset allowlist/);
  });

  it("rejects a nested leak outside entries/ (site/public/data/leak.json)", () => {
    const root = fixture();
    mkdirSync(join(root, "site/public/data"), { recursive: true });
    writeFileSync(join(root, "site/public/data/leak.json"), '{"private":"corpus"}');
    expect(() => checkPublicSiteBoundary(root)).toThrow(/not on the sanctioned public-asset allowlist/);
  });

  it("rejects an entries/ leak at a nested depth", () => {
    const root = fixture();
    mkdirSync(join(root, "site/public/entries/sub/deep"), { recursive: true });
    writeFileSync(join(root, "site/public/entries/sub/deep/leak.png"), "private");
    expect(() => checkPublicSiteBoundary(root)).toThrow(/site\/public\/entries/);
  });

  it("rejects a non-empty browser-downloadable corpus snapshot", () => {
    const root = fixture();
    writeFileSync(
      join(root, "site/public/snapshot.json"),
      JSON.stringify({
        count: 1,
        generatedAt: "2026-07-18T00:00:00.000Z",
        categories: ["dashboard"],
        styleTags: ["minimal"],
        entries: [{ id: "private-entry", critique: "private critique" }],
      }),
    );
    expect(() => checkPublicSiteBoundary(root)).toThrow(/entries must be empty/);
  });
});
