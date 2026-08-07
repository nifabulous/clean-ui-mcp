// src/verify/__fixtures__/fixtures.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureEntry, FixtureManifest } from "./generate-detector-fixtures.js";

const DIR = fileURLToPath(new URL(".", import.meta.url));

export function fixtureManifest(): FixtureManifest {
  return JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as FixtureManifest;
}

export function fixtureEntries(field: string): FixtureEntry[] {
  return fixtureManifest().fixtures.filter((f) => f.field === field);
}

export function fixtureImagePath(id: string): string {
  const entry = fixtureManifest().fixtures.find((f) => f.id === id);
  if (!entry) throw new Error(`no fixture with id ${id}`);
  return join(DIR, "images", entry.file);
}
