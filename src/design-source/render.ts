/**
 * Deterministic renderer for `DesignSourceSnapshot` artifacts.
 *
 * Emits a SOURCE-DESIGN.md document that is clearly marked as OBSERVED source
 * behavior, NOT target design authority. A UiSpec must explicitly retain, adapt,
 * or reject these observations.
 *
 * Guarantees:
 * - Parses first (malformed input throws before any rendering).
 * - Findings are sorted by id within each group for byte-stable output.
 * - Sections are emitted in a fixed order.
 * - Pipe characters in table cells are escaped.
 * - Output uses `\n` line endings and exactly one trailing newline.
 */
import { DesignSourceSnapshotSchema, type DesignSourceSnapshot } from "./contracts.js";

type Finding = DesignSourceSnapshot["foundations"]["colors"][number];

const FOUNDATION_GROUPS = [
  "colors",
  "typography",
  "spacing",
  "radii",
  "shadows",
  "layout",
] as const;

/** Escape pipe characters and collapse CR/CRLF so table cells stay single-line. */
function escapeCell(value: string): string {
  return value.replace(/\r\n?/g, " ").replace(/\|/g, "\\|");
}

/** Format a finding's evidence refs as a stable, space-separated list. */
function evidenceCell(finding: Finding): string {
  return escapeCell(finding.evidenceIds.join(" "));
}

function sortByFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function findingsTable(findings: readonly Finding[]): string[] {
  const rows = sortByFindings(findings);
  const lines: string[] = [
    "| id | value | role | confidence | evidence |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const finding of rows) {
    lines.push(
      `| ${escapeCell(finding.id)} | ${escapeCell(finding.value)} | ${escapeCell(finding.role)} | ${escapeCell(finding.confidence)} | ${evidenceCell(finding)} |`,
    );
  }
  return lines;
}

/**
 * Render a `DesignSourceSnapshot` as a deterministic SOURCE-DESIGN.md string.
 * Throws if the input does not satisfy `DesignSourceSnapshotSchema`.
 */
export function renderSourceDesign(input: unknown): string {
  const snapshot = DesignSourceSnapshotSchema.parse(input);

  const lines: string[] = [
    "# SOURCE-DESIGN.md",
    "",
    "> Observed source, not target design authority. A UiSpec must explicitly retain, adapt, or reject these observations.",
    "",
  ];

  // --- Source ---
  lines.push("## Source");
  lines.push("");
  lines.push(`- kind: ${escapeCell(snapshot.source.kind)}`);
  lines.push(`- origin: ${escapeCell(snapshot.source.origin)}`);
  const startingUrls = snapshot.source.startingUrls.map(escapeCell).join(" ");
  lines.push(`- startingUrls: ${startingUrls}`);
  lines.push("");

  // --- Coverage ---
  lines.push("## Coverage");
  lines.push("");
  lines.push("| url | status | reason | archetype | viewports |");
  lines.push("| --- | --- | --- | --- | --- |");
  const coverageRows = [...snapshot.coverage].sort((a, b) =>
    a.url < b.url ? -1 : a.url > b.url ? 1 : 0,
  );
  for (const row of coverageRows) {
    lines.push(
      `| ${escapeCell(row.url)} | ${escapeCell(row.status)} | ${escapeCell(row.reason)} | ${escapeCell(row.archetype ?? "")} | ${escapeCell(row.viewports.join(" "))} |`,
    );
  }
  lines.push("");

  // --- Foundations (subsections per group) ---
  lines.push("## Foundations");
  lines.push("");
  for (const group of FOUNDATION_GROUPS) {
    lines.push(`### ${group}`);
    lines.push(...findingsTable(snapshot.foundations[group]));
    lines.push("");
  }

  // --- Components ---
  lines.push("## Components");
  lines.push(...findingsTable(snapshot.components));
  lines.push("");

  // --- Responsive Behavior ---
  lines.push("## Responsive Behavior");
  lines.push(...findingsTable(snapshot.responsiveFindings));
  lines.push("");

  // --- Accessibility ---
  lines.push("## Accessibility");
  lines.push(...findingsTable(snapshot.accessibility));
  lines.push("");

  // --- Declared Motion ---
  lines.push("## Declared Motion");
  lines.push(...findingsTable(snapshot.motion));
  lines.push("");

  // --- Voice ---
  lines.push("## Voice");
  lines.push(...findingsTable(snapshot.voice));
  lines.push("");

  // --- Limitations ---
  lines.push("## Limitations");
  lines.push("");
  for (const limitation of snapshot.limitations) {
    lines.push(`- ${escapeCell(limitation)}`);
  }
  lines.push("");

  // --- Evidence Index ---
  lines.push("## Evidence Index");
  lines.push("");
  lines.push("| id | kind | route | basis | summary |");
  lines.push("| --- | --- | --- | --- | --- |");
  const evidenceRows = [...snapshot.evidence].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const evidence of evidenceRows) {
    lines.push(
      `| ${escapeCell(evidence.id)} | ${escapeCell(evidence.kind)} | ${escapeCell(evidence.route)} | ${escapeCell(evidence.basis)} | ${escapeCell(evidence.summary)} |`,
    );
  }

  return lines.join("\n") + "\n";
}
