import { z } from "zod";

const Url = z.string().url().refine(
  (value) => ["http:", "https:"].includes(new URL(value).protocol),
  { message: "URL must use http or https protocol" },
);
const Confidence = z.enum(["low", "medium", "high"]);
const EvidenceId = z.string().min(1);
const EvidenceRef = z.object({
  id: EvidenceId,
  kind: z.enum(["dom-signal", "screenshot-observation", "css-declaration", "machine-inference", "public-content"]),
  route: Url,
  summary: z.string().min(1),
  basis: z.enum(["visible", "dom-grounded", "declared", "inferred"]),
}).strict();
const Finding = z.object({ id: z.string().min(1), value: z.string().min(1), role: z.string().min(1), confidence: Confidence, evidenceIds: z.array(EvidenceId).min(1) }).strict();

export const DesignSourceSnapshotSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("design-source-snapshot"),
  artifactId: z.string().min(1),
  projectId: z.string().min(1),
  source: z.object({ kind: z.literal("user-supplied-public-reference"), origin: Url, startingUrls: z.array(Url).min(1) }).strict(),
  capturedAt: z.string().datetime(),
  crawl: z.object({ maxRoutes: z.number().int().min(1).max(30), sameOrigin: z.literal(true), authenticated: z.literal(false), mutationAllowed: z.literal(false) }).strict(),
  coverage: z.array(z.object({ url: Url, status: z.enum(["inspected", "skipped", "blocked", "duplicate", "failed"]), reason: z.string().min(1), archetype: z.string().min(1).nullable(), viewports: z.array(z.enum(["desktop", "tablet", "mobile"])) }).strict()).min(1),
  foundations: z.object({ colors: z.array(Finding), typography: z.array(Finding), spacing: z.array(Finding), radii: z.array(Finding), shadows: z.array(Finding), layout: z.array(Finding) }).strict(),
  components: z.array(Finding),
  responsiveFindings: z.array(Finding),
  accessibility: z.array(Finding),
  motion: z.array(Finding),
  voice: z.array(Finding),
  evidence: z.array(EvidenceRef),
  limitations: z.array(z.string().min(1)),
}).strict().superRefine((snapshot, ctx) => {
  // Reject duplicate evidence IDs BEFORE building the resolution set. Two
  // evidence records sharing an ID collapse into a single Set entry, so a
  // finding's evidenceIds reference would point ambiguously at two records
  // and provenance becomes unreadable (review P1 #3).
  const seenEvidenceIds = new Set<string>();
  for (const item of snapshot.evidence) {
    if (seenEvidenceIds.has(item.id)) {
      ctx.addIssue({ code: "custom", message: `duplicate evidence ID: ${item.id}` });
    } else {
      seenEvidenceIds.add(item.id);
    }
  }

  // Recompute same-origin from the declared source origin rather than trusting
  // `crawl.sameOrigin: true`. Without this, a snapshot can claim same-origin
  // while carrying starting/coverage/evidence URLs from unrelated origins
  // (review P1 #3). WHATWG URL.origin is the canonical scheme+host+port tuple.
  let originTuple: string;
  try {
    originTuple = new URL(snapshot.source.origin).origin;
  } catch {
    // origin already passed the Url schema, so this should not occur; if it
    // somehow does, flag it explicitly rather than silently passing.
    ctx.addIssue({ code: "custom", path: ["source", "origin"], message: "source.origin is not a parseable URL" });
    return;
  }
  const offOrigin: Array<[string, string, string]> = [];
  for (const [index, url] of snapshot.source.startingUrls.entries()) {
    try { if (new URL(url).origin !== originTuple) offOrigin.push([`source.startingUrls.${index}`, url, originTuple]); } catch { /* Url schema already caught it */ }
  }
  for (const [index, entry] of snapshot.coverage.entries()) {
    try { if (new URL(entry.url).origin !== originTuple) offOrigin.push([`coverage.${index}.url`, entry.url, originTuple]); } catch { /* caught upstream */ }
  }
  for (const [index, item] of snapshot.evidence.entries()) {
    try { if (new URL(item.route).origin !== originTuple) offOrigin.push([`evidence.${index}.route`, item.route, originTuple]); } catch { /* caught upstream */ }
  }
  for (const [path, url, expected] of offOrigin) {
    ctx.addIssue({ code: "custom", path: path.split("."), message: `URL ${url} is not same-origin with source.origin (expected ${expected})` });
  }

  // Resolve every finding's evidenceIds against the now-unique evidence set.
  const groups = [...Object.values(snapshot.foundations), snapshot.components, snapshot.responsiveFindings, snapshot.accessibility, snapshot.motion, snapshot.voice];
  for (const finding of groups.flat()) for (const id of finding.evidenceIds) if (!seenEvidenceIds.has(id)) ctx.addIssue({ code: "custom", message: `unresolved evidence ID: ${id}` });
});

export type DesignSourceSnapshot = z.infer<typeof DesignSourceSnapshotSchema>;
