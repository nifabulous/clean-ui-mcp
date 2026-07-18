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
  const ids = new Set(snapshot.evidence.map((item) => item.id));
  const groups = [...Object.values(snapshot.foundations), snapshot.components, snapshot.responsiveFindings, snapshot.accessibility, snapshot.motion, snapshot.voice];
  for (const finding of groups.flat()) for (const id of finding.evidenceIds) if (!ids.has(id)) ctx.addIssue({ code: "custom", message: `unresolved evidence ID: ${id}` });
});

export type DesignSourceSnapshot = z.infer<typeof DesignSourceSnapshotSchema>;
