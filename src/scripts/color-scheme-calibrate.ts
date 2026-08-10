#!/usr/bin/env node
/**
 * Build and evaluate the private human calibration packet for colorScheme.
 * This command never mutates corpus/entries.json or any image.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSafeOutputPath } from "./color-scheme-audit.js";
import {
  buildColorSchemeCalibrationPacket,
  ColorSchemeCalibrationPacketSchema,
  evaluateColorSchemeCalibration,
  ColorSchemeCalibrationSubmissionSchema,
  sha256,
  type ColorSchemeCalibrationPacket,
} from "../color-scheme-calibration.js";
import { validateColorSchemeAuditReport, type ColorSchemeAuditReport } from "../color-scheme-audit.js";

type ParsedAudit = { audit: ColorSchemeAuditReport; auditSha256: string };

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} is required`);
  return value;
}

function readAudit(path: string): ParsedAudit {
  const bytes = readFileSync(path);
  const auditSha256 = sha256(bytes);
  const audit = validateColorSchemeAuditReport(JSON.parse(bytes.toString("utf8")) as unknown);
  return { audit, auditSha256 };
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

function imagePathFor(corpusRoot: string, relativePath: string): string {
  const segments = relativePath.split(/[\\/]/);
  if (isAbsolute(relativePath) || segments.some((segment) => segment === "." || segment === "..") || (!relativePath.startsWith("images-private/") && !relativePath.startsWith("images-public/"))) {
    throw new Error(`unsafe calibration image path: ${relativePath}`);
  }
  const realCorpusRoot = realpathSync(corpusRoot);
  const absolute = resolve(corpusRoot, relativePath);
  if (!existsSync(absolute)) throw new Error(`calibration image is missing: ${absolute}`);
  const realImage = realpathSync(absolute);
  if (!isWithin(realCorpusRoot, realImage)) throw new Error(`calibration image escapes corpus root: ${relativePath}`);
  return realImage;
}

function assertPacketImagesCurrent(packet: ColorSchemeCalibrationPacket, corpusRoot: string): Map<string, string> {
  const urls = new Map<string, string>();
  for (const entry of packet.entries) {
    const imagePath = imagePathFor(corpusRoot, entry.imagePath);
    const actualHash = sha256(readFileSync(imagePath));
    if (actualHash !== entry.imageSha256) throw new Error(`current image hash mismatch for ${entry.entryId}: expected ${entry.imageSha256}, got ${actualHash}`);
    urls.set(entry.entryId, pathToFileURL(imagePath).href);
  }
  return urls;
}

function writePrivate(path: string, content: string, corpusRoot: string): string {
  const absolute = assertSafeOutputPath(corpusRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, { flag: "wx" });
  return absolute;
}

function parsePositiveInt(value: string | undefined, flag: string, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseUnitInterval(value: string | undefined, flag: string, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${flag} must be between 0 and 1`);
  return parsed;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      audit: { type: "string" },
      corpus: { type: "string", default: "corpus/entries.json" },
      json: { type: "string" },
      html: { type: "string" },
      size: { type: "string", default: "12" },
      packet: { type: "string" },
      submission: { type: "string" },
      out: { type: "string" },
      "minimum-labels": { type: "string", default: "12" },
      "minimum-accuracy": { type: "string", default: "1" },
    },
  });
  const mode = positionals[0];
  if (mode !== "packet" && mode !== "evaluate") throw new Error("usage: color-scheme-calibrate packet|evaluate ...");
  const corpusPath = resolve(values.corpus ?? "corpus/entries.json");
  const corpusRoot = resolve(dirname(corpusPath));
  const { audit, auditSha256 } = readAudit(resolve(required(values.audit, "--audit")));

  if (mode === "packet") {
    if (!values.json && !values.html) throw new Error("packet mode requires --json and/or --html");
    const packet = buildColorSchemeCalibrationPacket(audit, auditSha256, parsePositiveInt(values.size, "--size", 12));
    const imageUrls = assertPacketImagesCurrent(packet, corpusRoot);
    if (values.json) writePrivate(values.json, JSON.stringify(packet, null, 2) + "\n", corpusRoot);
    if (values.html) {
      const { buildColorSchemeCalibrationHtml } = await import("../color-scheme-calibration-html.js");
      writePrivate(values.html, buildColorSchemeCalibrationHtml(packet, imageUrls), corpusRoot);
    }
    console.log(`calibration packet ready: ${packet.entries.length} entries, audit ${auditSha256}`);
    return;
  }

  const packetPath = resolve(required(values.packet, "--packet"));
  const submissionPath = resolve(required(values.submission, "--submission"));
  const outPath = required(values.out, "--out");
  const packet = ColorSchemeCalibrationPacketSchema.parse(JSON.parse(readFileSync(packetPath, "utf8")) as unknown);
  const packetSha256 = sha256(JSON.stringify(packet));
  const submission = ColorSchemeCalibrationSubmissionSchema.parse(JSON.parse(readFileSync(submissionPath, "utf8")) as unknown);
  assertPacketImagesCurrent(packet, corpusRoot);
  const report = evaluateColorSchemeCalibration(audit, auditSha256, packet, submission, {
    packetSha256,
    minimumScoredLabels: parsePositiveInt(values["minimum-labels"], "--minimum-labels", 12),
    minimumAccuracy: parseUnitInterval(values["minimum-accuracy"], "--minimum-accuracy", 1),
  });
  const written = writePrivate(outPath, JSON.stringify(report, null, 2) + "\n", corpusRoot);
  console.log(`calibration ${report.status}: ${written}`);
  console.log(`selected=${report.counts.selected} scored=${report.counts.scored} correct=${report.counts.correct} incorrect=${report.counts.incorrect} abstained=${report.counts.abstained} accuracy=${report.accuracy ?? "n/a"}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
