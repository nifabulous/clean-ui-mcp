# UI Taste Memory — CockroachDB × AWS Hackathon Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Supersedes v1** of this file. v1 tried to swap `corpus.ts` / `CorpusReader` onto an async `MemoryStore`. That is rejected: see “Why v1 died” below. This plan is **additive**.

**Goal:** Ship a Devpost submission where clean-ui-mcp gains a **CockroachDB-backed agentic taste-memory layer** beside the existing file corpus: episodic events → consolidated semantic preferences → vector recall, with time-travel (`AS OF SYSTEM TIME`), transactional writes, new MCP tools, CRDB Managed MCP Server, mirrored corpus embeddings under a distributed vector index, and AWS S3 (plus optional Lambda) for the demo surface.

**Architecture:** Leave `src/corpus.ts`, `src/corpus-reader.ts`, `src/embeddings.ts`, `src/persistence.ts`, and `src/decisions.ts` **untouched** as the taste *library*. Add `src/agent-memory/` as an async-native CRDB client. Agents write/read memory through **three new MCP tools**. Corpus search stays on today's sync hybrid path (Voyage + JSON index). CRDB holds (1) agent memory rows + their embeddings, (2) a **mirror** of corpus text embeddings for ANN demos and cross-memory joins, never as the hot path for the existing 14 tools unless a later plan explicitly opts in.

**Tech Stack:** TypeScript, `pg` → CockroachDB Cloud, `VECTOR(1024)` + vector index, Voyage `voyage-4` for embed *generation* only, AWS S3 for demo artifacts, Vitest; integration tests skip without `DATABASE_URL`.

**Hackathon:** https://cockroachdb-ai.devpost.com/ — deadline Aug 18, 2026 5pm EDT.

---

## Why v1 died (do not reintroduce)

Verified against real code (review round):

| v1 claim | Reality |
|----------|---------|
| Async `MemoryStore` behind corpus | `loadCorpus()` is **sync** (`corpus.ts`); `CorpusReader` is **8/11 methods sync**; `PublicCorpusReader` ctor is sync and **18 tests** use `expect(() => new …).toThrow()` |
| `createPrivateReader` / `createPublicReader` | **Do not exist.** Use `new PrivateCorpusReader()`, `new PublicCorpusReader(snapshotPath, now?)` |
| Wire `vectorSearch` | **Module-private** at `corpus.ts` (~line 253), not exported |
| `FileMemoryStore` + “store null → old path” | Contradicts “flag-off = no new path”: file mode still constructed a non-null store and routed search through it |
| Days 1–5 on store refactor | Zero judge-visible value; burns schedule before agentic-memory work |

**Governing invariant (v2):**  
`DATABASE_URL` unset ⇒ **zero** `pg` connections and **zero** behavior change on the existing 14 tools (same inputs → same outputs).  
**Tool-list invariant (stricter, from eng review):** default CI / no-DB smoke must keep advertising **exactly the historical 14 tools** unless an explicit env opts into the memory surface. Do **not** always-register 3 tools that only error — that changes `tools/list` for every Cursor user and forces every surface pin (served-tool-surface, mcp-smoke) forever.  
**Registration rule:** register the 3 memory tools **only when** `isAgentMemoryEnabled()` is true **and** mode is `private`. When disabled: `createServer(reader)` signature and 14-tool list stay as today.

---

## Global Constraints

1. **Do not modify** for this plan (except allowlisted wiring below): `src/corpus.ts`, `src/corpus-reader.ts`, `src/embeddings.ts` (except optional **exported read-only helpers** if needed for mirror import — prefer calling existing **exported** `loadIndex` / `cosine` / `embedQuery` only), `src/persistence.ts`, `src/decisions.ts`, public site MiniSearch.
2. **Allowlisted production edits:** `src/server-factory.ts` (optional 2nd arg; conditional register only), `src/server.ts` (construct memory client if configured), surface pins that run **with** memory enabled (new describe blocks — do not break default 14-tool pins), `package.json`, `.env.example`, `README.md`, new files under `src/agent-memory/`, `src/scripts/`, `infra/`, `docs/hackathon/`, `skill/`.
3. **Corpus isolation:** tests never write real `corpus/entries.json` / `decisions.json`.
4. **No secrets in git.**
5. **Hackathon minimums:** CRDB tools ≥2 → **Managed MCP Server** + **Distributed Vector Indexing**. AWS ≥1 → **S3** minimum; prefer **S3 + one Lambda Function URL** for recall/transcript (stronger “on AWS” story). Lambda is stretch only if T1–T4 slip.
6. **Public mode:** memory tools **must not register** when `CLEAN_UI_MODE=public`, even if `DATABASE_URL` is set (fail closed — not merely empty results).
7. **TDD + task review artifacts** per repo hooks.
8. **Wiring verification:** new exports need production callers or allowlist comments.
9. **Vector distance:** use cosine distance `<=>` for all memory ANN queries. Voyage vectors are L2-normalized; stick to one operator end-to-end.
10. **Tool surface pin:** Default `served-tool-surface.test.ts:165` and `mcp-smoke.test.ts` (“all 14 tools”) stay on **14** with no `DATABASE_URL`. Add a **separate** describe that injects a fake client and asserts 17 names — do not rewrite the default pin to 17.
11. **createServer call sites** (MCP factory only — not `node:http.createServer`): `server.ts:123`, `served-tool-surface.test.ts:65`, `public-mcp-contract.test.ts:264`, `create-ui-spec-mcp.test.ts` (multiple). Second arg optional: `createServer(reader, opts?: { agentMemory?: AgentMemoryClient | null })`. Ignore `ui-server.ts` / `ui-browser.test.ts` / `dom-motion-capture.test.ts` — those use Node's HTTP `createServer`.
12. **Import boundary:** `server-factory.ts` must not import `./corpus.js`, `./persistence.js`, or `./embeddings.js` (enforced by `public-import-boundary.test.ts`). Memory registration imports only `./agent-memory/register-tools.js`. Mirror/`loadIndex` stays in scripts + `mirror-corpus.ts`, never in the factory.
13. **Embed outside the DB transaction.** Voyage HTTP must complete **before** `BEGIN`. Transaction = episode + preference + vector rows only.
14. **Preference writes:** CRDB `UPSERT` matches **primary key only**. Preferences use `INSERT … ON CONFLICT (session_id, key) DO UPDATE` (not the `UPSERT` keyword). Never put `id` in the SET clause — existing UUID is preserved so `memory_vectors.owner_id` stays stable.
15. **`AS OF SYSTEM TIME`:** CRDB does **not** allow placeholders (`$1`) in `AS OF SYSTEM TIME`. Timestamp must be a SQL literal. Sanitize MCP `asOf` via `new Date(iso)` → reject NaN → interpolate **only** `d.toISOString()` quoted (Date round-trip cannot carry SQL injection). Bind `session_id` as `$1` as usual.

---

## Product story (judges / video)

> The 14 existing tools are a **taste library** (curated UI examples). Production agents also need **taste memory**: what this user rejected, which anti-patterns fired, which decision won last Tuesday, and whether the agent changed its mind.
>
> Memory lives in **CockroachDB**: episodic events consolidate into semantic preferences; both are embedded into `VECTOR(1024)` under a distributed vector index. Writes are **transactional** (event + preference revision + embedding commit together). Beliefs are **auditable** with `AS OF SYSTEM TIME`. The agent process can die; multi-region CRDB does not. Agents use new MCP tools on clean-ui-mcp **and** the CockroachDB Managed MCP Server for SQL-level inspection.

### Judging map

| Criterion | How we score |
|-----------|----------------|
| Agentic Memory Design | Episodic → semantic consolidation + vector recall + time-travel — not a flat chat log |
| Technical Implementation | Real VECTOR index; transactional multi-row writes; MCP tools; Managed MCP config |
| Real-World Impact | Design agents already fail by forgetting curator intent across sessions |
| Production Readiness | Fail-closed without DB; public mode isolation; no corpus regression |
| Creativity | `AS OF SYSTEM TIME` belief revision; “why did I change my mind?”; transactional memory |

### Hero demo (not “DB survives kill”)

1. Session A: agent rejects purple gradients, steals Stripe spacing, decides Direction B for billing.
2. Consolidate → semantic prefs embedded.
3. Kill process. New session: `recall_context("billing settings")` returns prior decision + prefs via **vector recall over memory**, not keyword log scan.
4. `why_did_i` + `AS OF SYSTEM TIME` show preference weight before/after a reversal.
5. Side panel: CRDB MCP / SQL `EXPLAIN` on vector query; S3 artifact pointer.

Every entrant can kill a process. **Belief revision over distributed SQL** is the differentiator.

---

## File structure

```
src/agent-memory/
  types.ts                 # Zod + TS types for events, preferences, recall hits
  config.ts                # isAgentMemoryEnabled(), requireDatabaseUrl()
  pool.ts                  # lazy pg Pool (only if enabled)
  schema.sql               # DDL
  migrate.ts
  embed-text.ts            # thin wrapper: Voyage embed via existing embeddings.embedQuery / document path
  write.ts                 # transactional remember + consolidate
  recall.ts                # ANN over memory (+ optional corpus mirror join)
  time-travel.ts           # AS OF SYSTEM TIME readers
  mirror-corpus.ts         # one-shot / incremental mirror of corpus embeddings → CRDB
  client.ts                # public AgentMemoryClient façade
  register-tools.ts        # registerRememberPreference, registerRecallContext, registerWhyDidI
  *.test.ts                # unit tests with mocked pool
  *.integration.test.ts    # skip without DATABASE_URL

src/scripts/
  crdb-migrate.ts
  crdb-mirror-embeddings.ts
  demo-agent-memory.ts     # hero script for video

infra/cockroach/
  README.md                # cluster, VECTOR INDEX verify, Managed MCP setup
  mcp-config.example.json

infra/aws/
  README.md                # S3 bucket for demo transcripts / screenshots
  # optional: template.yaml Lambda later

docs/hackathon/
  ARCHITECTURE.md
  DEMO_SCRIPT.md
  SUBMISSION.md

skill/agent-taste-memory/SKILL.md   # portable agent skill (optional CRDB “Agent Skills” checkbox)
```

**Modify:**
- `src/server-factory.ts` — optional 2nd arg; `if (opts?.agentMemory) registerAgentMemoryTools(...)`
- `src/server.ts` — dynamic-import client only when private + `DATABASE_URL`
- `src/served-tool-surface.test.ts` — keep default 14 pin; **add** describe with fake client → 17
- `package.json` — `pg`, scripts
- `.env.example`, `README.md`

---

## Data model (CockroachDB)

```sql
-- src/agent-memory/schema.sql

-- Episodic log (append-mostly; corrections via new events, not silent UPDATE of history)
CREATE TABLE IF NOT EXISTS memory_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id STRING NOT NULL,
  kind STRING NOT NULL,
  -- kind ∈ preference | rejection | steal_applied | decision | retrieval | note | reversal
  subject STRING NULL,          -- corpus entry id, decision id, or free tag
  content STRING NOT NULL,      -- human-readable; also embedding source
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (session_id, created_at DESC),
  INDEX (kind, created_at DESC)
);

-- Consolidated semantic preferences (mutable beliefs; revisions are new rows or versioned updates IN TX with episode)
CREATE TABLE IF NOT EXISTS memory_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id STRING NOT NULL,
  key STRING NOT NULL,           -- e.g. "accent_count", "avoid_palette", "preferred_ref"
  value JSONB NOT NULL,
  confidence FLOAT NOT NULL DEFAULT 0.5,
  source_episode_id UUID NULL REFERENCES memory_episodes(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, key)
);

-- Embeddings for episodes + preferences (and optional corpus mirror)
CREATE TABLE IF NOT EXISTS memory_vectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind STRING NOT NULL,   -- episode | preference | corpus_entry
  owner_id STRING NOT NULL,     -- uuid string or corpus entry id
  session_id STRING NULL,       -- null for corpus_entry mirror
  model STRING NOT NULL,
  dims INT NOT NULL CHECK (dims = 1024),
  content_hash STRING NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_kind, owner_id)
);

-- VERIFY at implement time against your CRDB version docs before merge:
CREATE VECTOR INDEX IF NOT EXISTS memory_vectors_embedding_idx
  ON memory_vectors (embedding);

-- Optional sessions metadata
CREATE TABLE IF NOT EXISTS memory_sessions (
  id STRING PRIMARY KEY,
  title STRING NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta JSONB NOT NULL DEFAULT '{}'::JSONB
);
```

**Env:**
```
DATABASE_URL=postgresql://...     # enables agent memory
# existing CLEAN_UI_MODE, VOYAGE_API_KEY, ...
AWS_REGION=
S3_BUCKET_HACKATHON_DEMO=         # demo transcripts / screenshots only
```

No `CLEAN_UI_STORE`. Corpus is not a store mode.

---

### Task 1: Types, config, schema migrate, pool

**Files:**
- Create: `src/agent-memory/types.ts`, `config.ts`, `pool.ts`, `schema.sql`, `migrate.ts`
- Create: `src/agent-memory/config.test.ts`, `migrate.integration.test.ts`
- Create: `src/scripts/crdb-migrate.ts`
- Modify: `package.json` — add `pg`, `@types/pg`, script `crdb:migrate`

**Interfaces:**
- Produces: `isAgentMemoryEnabled(env)`, `getPool(url)`, `migrateAgentMemory(pool)`, kinds union in Zod

- [ ] **Step 1: Failing unit test for config**

```ts
// src/agent-memory/config.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { isAgentMemoryEnabled, requireDatabaseUrl } from "./config.js";

describe("agent-memory config", () => {
  const prev = process.env.DATABASE_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  });

  it("disabled when DATABASE_URL unset", () => {
    delete process.env.DATABASE_URL;
    expect(isAgentMemoryEnabled()).toBe(false);
  });

  it("enabled when DATABASE_URL set", () => {
    process.env.DATABASE_URL = "postgresql://localhost/test";
    expect(isAgentMemoryEnabled()).toBe(true);
  });

  it("requireDatabaseUrl throws when missing", () => {
    delete process.env.DATABASE_URL;
    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing)

```bash
npx vitest run src/agent-memory/config.test.ts
```

- [ ] **Step 3: Implement config + types + schema + migrate + pool**

```ts
// src/agent-memory/config.ts
export function isAgentMemoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DATABASE_URL?.trim());
}

export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is required for agent memory");
  return url;
}
```

```ts
// src/agent-memory/types.ts
import { z } from "zod";

export const MemoryKindZ = z.enum([
  "preference",
  "rejection",
  "steal_applied",
  "decision",
  "retrieval",
  "note",
  "reversal",
]);
export type MemoryKind = z.infer<typeof MemoryKindZ>;

export const RememberInputZ = z.object({
  sessionId: z.string().min(1).max(128),
  kind: MemoryKindZ,
  content: z.string().min(1).max(4000),
  subject: z.string().max(256).optional(),
  payload: z.record(z.unknown()).optional(),
  /** If set, upsert memory_preferences[key] in the same transaction */
  consolidateKey: z.string().max(128).optional(),
  consolidateValue: z.unknown().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type RememberInput = z.infer<typeof RememberInputZ>;

export const RecallHitZ = z.object({
  ownerKind: z.enum(["episode", "preference", "corpus_entry"]),
  ownerId: z.string(),
  sessionId: z.string().nullable(),
  distance: z.number(),
  content: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});
export type RecallHit = z.infer<typeof RecallHitZ>;
```

`pool.ts`: create Pool from URL; export `async function withPool<T>(fn): Promise<T>` for tests.  
`migrate.ts`: apply `schema.sql`. **Before finalizing VECTOR INDEX DDL**, run against the provisioned cluster and paste verified syntax into `schema.sql` (document CRDB version in `infra/cockroach/README.md`).

- [ ] **Step 4: Integration test** (`describe.skip` if no `DATABASE_URL`): migrate twice idempotent; `memory_episodes` exists.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/agent-memory src/scripts/crdb-migrate.ts
git commit -m "feat(agent-memory): config, schema, migrate, pool"
```

---

### Task 2: Transactional write + embed + consolidate

**Files:**
- Create: `src/agent-memory/embed-text.ts`, `write.ts`, `client.ts`
- Create: `src/agent-memory/write.test.ts` (mock client / transactional ordering)
- Create: `src/agent-memory/write.integration.test.ts`

**Interfaces:**
- Consumes: pool; Voyage via already-exported `embedQuery` / `embedDocuments` from `src/embeddings.ts` (lines 81, 87) — do not reimplement fetch
- Produces: `remember(input: RememberInput): Promise<{ episodeId, preferenceId? }>`

**Write sequence (eng review — embed outside TX):**
1. Validate input (Zod)
2. **Embed** content (and consolidated preference text if any) via Voyage — **before** any `BEGIN`
3. `BEGIN`
4. `INSERT memory_episodes`
5. Preference row via **`INSERT … ON CONFLICT (session_id, key) DO UPDATE`** (not CRDB `UPSERT` keyword — that only matches PK). Do not SET `id`.
6. Vector rows via `INSERT … ON CONFLICT (owner_kind, owner_id) DO UPDATE` for episode (+ preference if consolidated)
7. `COMMIT` — on SQL error `ROLLBACK`; never leave episode without vector when embed succeeded

Preference SQL (copy exactly — hero demo reversal depends on this):

```sql
INSERT INTO memory_preferences (session_id, key, value, confidence, source_episode_id, updated_at)
VALUES ($1, $2, $3::jsonb, $4, $5, now())
ON CONFLICT (session_id, key) DO UPDATE SET
  value = EXCLUDED.value,
  confidence = EXCLUDED.confidence,
  source_episode_id = EXCLUDED.source_episode_id,
  updated_at = now();
-- RETURNING id  -- use for memory_vectors.owner_id
```

- [ ] **Step 1: Unit tests**
  - embed before BEGIN; voyage fail skips TX
  - second remember with same `(sessionId, consolidateKey)` does **not** throw unique violation; returned preference `id` is unchanged

- [ ] **Step 2: FAIL then implement `write.ts`**

Vector insert shape (adjust cast to verified CRDB):

```sql
INSERT INTO memory_vectors (owner_kind, owner_id, session_id, model, dims, content_hash, embedding)
VALUES ($1, $2, $3, $4, 1024, $5, $6::vector)
ON CONFLICT (owner_kind, owner_id) DO UPDATE SET
  embedding = EXCLUDED.embedding,
  content_hash = EXCLUDED.content_hash,
  model = EXCLUDED.model;
```

Where `$6` is the canonical vector string e.g. `[0.1,0.2,…]`.

- [ ] **Step 3: Integration test** round-trip one remember; row counts = 1 episode + 1 pref + ≥1 vector.

- [ ] **Step 4: Commit** `feat(agent-memory): transactional remember with embeddings`

---

### Task 3: Vector recall + corpus embedding mirror + time-travel

**Files:**
- Create: `src/agent-memory/recall.ts`, `time-travel.ts`, `mirror-corpus.ts`
- Create: `src/scripts/crdb-mirror-embeddings.ts`
- Create: `src/agent-memory/recall.integration.test.ts`, `time-travel.integration.test.ts`
- Modify: `package.json` scripts `crdb:mirror`

**Interfaces:**
- Produces:
  - `recall(sessionId | null, query: string, k: number, opts?: { includeCorpusMirror?: boolean }): Promise<RecallHit[]>`
  - `preferencesAsOf(sessionId, timestamp: Date): Promise<PreferenceRow[]>`
  - `mirrorCorpusEmbeddingsFromFile(): Promise<{ mirrored: number }>` using exported `loadIndex()` from `embeddings.ts:162` (script/mirror module only — never import into server-factory).

**ANN SQL** (verify operator; prefer cosine for unit vectors):

```sql
SELECT owner_kind, owner_id, session_id,
       embedding <=> $1::vector AS distance
FROM memory_vectors
WHERE ($2::string IS NULL OR session_id = $2 OR owner_kind = 'corpus_entry')
ORDER BY embedding <=> $1::vector
LIMIT $3;
```

Join back to `memory_episodes.content` / preferences / optional local `getEntryById` **only inside the demo script or tool handler** (tool handler may call existing sync `reader.getById` — fine; memory layer stays async).

**Time-travel (D1 — no placeholders in AS OF):**

```ts
// src/agent-memory/time-travel.ts
export function asOfSystemTimeLiteral(asOfIso: string): string {
  const d = new Date(asOfIso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid asOf: ${asOfIso}`);
  // Only ISO from Date — never interpolate raw MCP string (injection).
  return `'${d.toISOString()}'`;
}

export async function preferencesAsOf(
  pool: Pool,
  sessionId: string,
  asOfIso: string,
): Promise<PreferenceRow[]> {
  const lit = asOfSystemTimeLiteral(asOfIso);
  const { rows } = await pool.query(
    `SELECT key, value, confidence, updated_at
     FROM memory_preferences
     AS OF SYSTEM TIME ${lit}
     WHERE session_id = $1`,
    [sessionId],
  );
  return rows;
}
```

- [ ] **Step 1: Integration tests** (must run before demo — catches D1/D2)
  - Two preference writes same key; second succeeds; `id` stable (D2)
  - After reversal, `preferencesAsOf(earlierIso)` returns old confidence (D1)
  - `asOfSystemTimeLiteral("'; DROP TABLE")` throws invalid asOf
  - Embed two episodes; semantic query ranks closer first
  - Mirror ≥1 corpus vector; `owner_kind='corpus_entry'`

- [ ] **Step 2: Implement**

- [ ] **Step 3: Commit** `feat(agent-memory): ANN recall, corpus mirror, AS OF time-travel`

---

### Task 4: Three MCP tools (conditional) + dual surface pins

**Files:**
- Create: `src/agent-memory/register-tools.ts`
- Create: `src/agent-memory/register-tools.test.ts` (in-memory MCP like other contract tests)
- Modify: `src/server-factory.ts` — after existing registrations:

```ts
import { registerAgentMemoryTools } from "./agent-memory/register-tools.js";
// createServer(reader, opts?: { agentMemory?: AgentMemoryClient | null })
// Only register when a live client is provided (private + DATABASE_URL path).
if (opts?.agentMemory) {
  registerAgentMemoryTools(server, opts.agentMemory, reader);
}
```

- Modify: `src/server.ts` — if `isAgentMemoryEnabled()` **and** `pickMode()==="private"`, construct client and `createServer(reader, { agentMemory })`; else `createServer(reader)` only. Use dynamic `import("./agent-memory/...")` so default path never loads `pg`.
- Modify: `src/served-tool-surface.test.ts` — **keep** default 14-tool pin; **add** `describe("agent memory tools when client injected")` that calls `createServer(stub, { agentMemory: fake })` and expects 17 names:
  - `remember_ui_preference`
  - `recall_ui_context`
  - `why_did_i_prefer`
- Modify: `src/mcp-smoke.test.ts` — default spawn stays 14; optional smoke with `DATABASE_URL` only if CI secret present (skip otherwise)
- Modify: `src/server-factory.ts` signature comment “14 tools” → “14 + optional 3 memory tools”

**Tool contracts (Zod input → structured JSON text result):**

| Tool | Behavior |
|------|----------|
| `remember_ui_preference` | Validates `RememberInputZ`; calls `remember`; only registered in private+enabled |
| `recall_ui_context` | `query`, `sessionId`, `k?`; ANN recall; corpus mirror hits labeled `ownerKind=corpus_entry` |
| `why_did_i_prefer` | `sessionId`, `key`, optional `asOf` ISO; current pref + `preferencesAsOf` + supporting episodes |

When memory disabled: tools **absent** from `tools/list` (not error stubs). Existing 14 tools untouched.

- [ ] **Step 1: Unit-test register-tools with fake client (3 tools present)**

- [ ] **Step 2: Wire conditional registration; default served-surface still 14**

- [ ] **Step 3: `npx vitest run src/served-tool-surface.test.ts src/agent-memory/register-tools.test.ts src/mcp-smoke.test.ts`**

- [ ] **Step 4: Commit** `feat(agent-memory): conditional MCP tools remember/recall/why_did_i`

---

### Task 5: Demo script, S3 artifact dump, infra docs, skill file

**Files:**
- Create: `src/scripts/demo-agent-memory.ts`
- Create: `infra/cockroach/README.md`, `mcp-config.example.json`
- Create: `infra/aws/README.md`
- Create: `docs/hackathon/ARCHITECTURE.md`, `DEMO_SCRIPT.md`, `SUBMISSION.md`
  - **SUBMISSION.md must lead with enable path** (judges clone → 14 tools only until configured):
    1. CockroachDB Cloud URL → `DATABASE_URL`
    2. `npm run crdb:migrate && npm run crdb:mirror`
    3. `CLEAN_UI_MODE=private npm start` → tools/list shows 17
    4. `npm run demo:agent-memory` for hero script
- Create: `skill/agent-taste-memory/SKILL.md`
- Modify: `README.md` short section + link
- Modify: `.env.example`

**Demo script steps (stdout + optional S3 put of JSON transcript):**
1. migrate (idempotent)
2. mirror corpus embeddings (subset ok if full index huge — document)
3. session `billing-hackathon`
4. remember rejection + steal_applied + decision (with consolidate keys)
5. print `recall_ui_context` style results
6. update preference (reversal episode + new consolidate)
7. print `why_did_i` current vs `asOf` 5s earlier
8. print `EXPLAIN` output for ANN query (subprocess `cockroach sql` or `pool.query('EXPLAIN …')`)
9. if `S3_BUCKET_HACKATHON_DEMO` set, upload transcript JSON

**Managed MCP:** document Cloud Console → enable MCP → example Cursor config (placeholders only).

**ccloud optional one-liner** in README (third CRDB tool if you want margin).

- [ ] **Step 1: Implement demo; dry-run with real `DATABASE_URL`**
- [ ] **Step 2: Write docs from commands you actually ran**
- [ ] **Step 3: Commit** `docs+demo: hackathon agent memory demo and infra`

---

### Task 6: Submission packaging (video + Devpost)

**Files:** finalize `docs/hackathon/SUBMISSION.md` URLs only

- [ ] Record ≤3:00 video per `DEMO_SCRIPT.md` (belief revision + EXPLAIN + MCP tools — not just process kill)
- [ ] Public repo, MIT visible
- [ ] Devpost: list CRDB MCP Server, Vector Indexing, (ccloud/skills); AWS S3
- [ ] Tag `hackathon-crdb-aws-2026`
- [ ] Branch review artifact before push if shipping via PR

---

## Out of scope (explicit)

- Replacing file corpus / decisions / hybrid search with CRDB
- `FileMemoryStore` / `CLEAN_UI_STORE`
- Async-ifying `CorpusReader`
- Image embeddings in CRDB
- Bedrock (optional stretch only if S3+core done early)
- Dual-write of MCP query-log to CRDB

---

## Verification matrix

| Check | Evidence |
|-------|----------|
| Existing suite green without DB | `npm test` on clean env (no `DATABASE_URL`) |
| **Default tool list exactly 14** | no `DATABASE_URL` → `tools/list` length 14, names match historical pin |
| 14 tools unchanged behavior | existing contract tests |
| **17 tools when fake client injected** | `served-tool-surface` new describe only |
| Memory disabled = tools **absent** | not registered; uncallable (not structured-error stubs) |
| **Public + DATABASE_URL** | memory tools **ABSENT** from `tools/list` |
| TX integrity | embed fail → no BEGIN; SQL fail → rollback; preference second-write no unique violation |
| Preference id stable | two consolidates same key → same `id` |
| Vector index used | `EXPLAIN` in demo output / docs screenshot |
| Time-travel | integration test: AS OF literal + sanitized ISO; demo reversal |
| No secret leak | `git grep -E 'postgresql://[^s]|AKIA'` |
| Judge enable path | `docs/hackathon/SUBMISSION.md` + README top: `DATABASE_URL` + private mode + migrate + demo |

---

## Timeline (~16 days)

| Days | Tasks |
|------|-------|
| 1 | T1 schema + cluster provision |
| 2–3 | T2 transactional write |
| 4–5 | T3 recall + mirror + AS OF |
| 6–7 | T4 MCP tools + pins |
| 8–9 | T5 demo + docs + S3 |
| 10–12 | Polish, review, bugfix |
| 13–14 | Video + Devpost |
| 15–16 | Buffer / submit |

---

## Self-review (v2)

1. **Sync/async:** memory is async-native; corpus path untouched → Blocker 1 closed.
2. **Flag-off:** no store adapter on hot path; enabled only via `DATABASE_URL` → Blocker 2 closed.
3. **Names:** no `createPrivateReader`; tools registered on real `createServer(reader)` → Blocker 3 closed.
4. **Scoring:** effort on agentic memory design + CRDB primitives → Blocker 4 closed.
5. **Surface pin:** default 14 unchanged; optional 17 describe when client injected (post-review).
6. **VECTOR DDL:** still must be verified live in T1 — called out, not fictionalized.
7. **Review patches applied:** conditional tools, embed-outside-TX, import boundary, preference id stability.

---

## Execution handoff

Plan v2 (+ review patches) at `docs/superpowers/plans/2026-08-02-cockroachdb-agentic-memory-hackathon.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task + review  
2. **Inline Execution** — this session with checkpoints  

**Which approach?**

---

## GSTACK REVIEW REPORT

**Date:** 2026-08-02  
**Target:** this plan (v2), not a branch diff  
**Modes:** Eng = HOLD SCOPE (bulletproof). CEO = HOLD SCOPE + deferred expansions listed. Superpowers = code-claim + whole-ticket coherence.  
**Verdict:** **CONDITIONAL GO → GO after D1/D2 + stale-ref scrub (this edit).** Architecture correct. Hero-demo blockers (AS OF placeholder, CRDB UPSERT-on-unique) fixed in Task 2/3. Re-read Constraints 9–15 + Task 2 preference SQL before coding.

### CEO review (strategy)

| Question | Answer |
|----------|--------|
| Right problem? | Yes. Taste *library* without taste *memory* is the real agent failure mode. |
| Right wedge? | Yes for hackathon: additive memory layer, not corpus migration. |
| 10-star vs ship? | Belief revision + vector recall is enough story. Multi-region live failover is nice-to-have demo, not required. |
| Scope risk | Do not re-open corpus-on-CRDB. That is a product rewrite, not a hackathon. |
| AWS | S3-only is legal but weak. One Lambda URL that recalls memory is the cheap credibility upgrade (deferred expansion E1). |
| Build vs skip hackathon | Build: forces durable memory design you want anyway; deadline is ~16d and v2 fits. |

**Deferred expansions (not in scope unless you opt in):**
- **E1** Lambda Function URL for `recall` + health (AWS compute checkbox)
- **E2** Bedrock Titan embeddings as optional embed backend (multi-cloud story)
- **E3** Decision Lab → `remember` hook on analyze complete (real product loop)
- **E4** Multi-region CRDB demo with forced node kill (creativity max, ops cost)

**CEO score:** 8/10 as hackathon plan after patches; 6/10 if tools always-register and S3 is the only AWS touch.

### Eng review (architecture / failure modes)

**What is solid**
- Additive `src/agent-memory/` avoids sync `CorpusReader` impedance mismatch (v1 fatal).
- Episodic → preference → vector is a real agentic memory design, not a chat log.
- `AS OF SYSTEM TIME` + transactional multi-row write is CRDB-native differentiation.
- `embedQuery` / `embedDocuments` / `loadIndex` **are** exported (`embeddings.ts:81,87,162`) — use them; no duplicate Voyage client required.
- Import boundary constraints now explicit (Constraint 12).

**Critical issues found (patched in plan body — rounds 1+2)**
1. ~~Always register 3 tools~~ → conditional registration; default tools/list stays 14.
2. ~~Embed inside TX~~ → embed then BEGIN.
3. ~~Rewrite surface pin to 17~~ → dual describes; mcp-smoke stays 14 by default.
4. ~~Preference UUID / CRDB `UPSERT`~~ → `INSERT … ON CONFLICT (session_id, key) DO UPDATE` (D2).
5. `createServer` second arg optional — MCP call sites only (not node:http).
6. ~~`AS OF SYSTEM TIME $1`~~ → ISO sanitized to Date → literal only (D1); no raw MCP string concat.
7. ~~Stale “always registered / structured error” cross-refs~~ → scrubbed File structure + verification matrix.

**Important residual risks (implementer must handle; not optional)**
| ID | Risk | Mitigation |
|----|------|------------|
| R1 | VECTOR INDEX / `<=>` syntax wrong for cluster version | T1 live verify; paste real DDL; EXPLAIN proves index |
| R2 | AS OF literal + injection | `asOfSystemTimeLiteral()` only; unit test rejects garbage; integration test reversal |
| R3 | No auth on `sessionId` | README: shared DB ≠ multi-tenant |
| R4 | Public mode + DATABASE_URL set | Must not register when `pickMode()==="public"` |
| R5 | Voyage outage | remember fails before BEGIN |
| R6 | Corpus mirror stale | demo re-mirrors; document |
| R7 | Judge clones repo, sees 14 tools only | SUBMISSION.md enable path first screen |
| R8 | wiring-verification new exports | client used by server.ts + demo script |

**Test diagram (eng)**
```
remember happy: embed OK → TX commits episode+pref+vector
remember voyage fail: no rows
remember SQL fail mid-TX: rollback, no partial
recall empty session: []
recall semantic: closer episode ranks first
as-of: after reversal, old confidence returned
tools/list no DB: exactly 14
tools/list + fake client: 17
public mode + DB url: memory tools absent
import boundary: server-factory still clean
```

**Eng score:** 8.5/10 after patches; was 6/10 on registration invariant alone.

### Superpowers review (coherence / claims)

**Governing invariant check**
1. Completed txn re-routed? N/A (no money). Memory: reversal is explicit episode — OK.
2. New code under default off? After patch: registration skipped; dynamic import of pool only when enabled — OK if `server.ts` does not top-level import pool.
3. ACs satisfy invariant? After patch yes. Before patch Task 4 violated tools/list byte-compat.

**Code claim audit**
| Claim | Status |
|-------|--------|
| loadCorpus sync / CorpusReader mostly sync | Confirmed |
| No createPrivateReader | Confirmed |
| vectorSearch private | Confirmed |
| served-tool-surface 14 pin | Confirmed `:165` |
| mcp-smoke 14 | Confirmed |
| createServer(reader) only | Confirmed; optional 2nd arg plan OK |
| embedDocuments exported | Confirmed — plan now uses it |
| public-import-boundary blocks corpus/embeddings in factory | Confirmed — Constraint 12 |
| VECTOR INDEX DDL | Unverified live (docs fetch failed) — T1 gate remains |

**Whole-ticket questions**
1. Double-write memory? TX + unique keys — OK if embed outside TX.
2. Flag-off new paths? Conditional register + lazy import — OK.
3. Collectively satisfy hackathon ≥2 CRDB + ≥1 AWS? Yes if T3 vector index + T5 Managed MCP + S3/Lambda ship.

### Converged findings (all three lenses)

1. **Conditional tool registration** (eng + superpowers) — patched  
2. **Embed outside TX** (eng) — patched  
3. **Keep default 14-tool pins** (eng + superpowers) — patched  
4. **AWS compute thin** (CEO) — deferred E1; S3 minimum OK  
5. **Live VECTOR DDL verify** (eng) — still open until T1  

### STATUS

**DONE** (plan review rounds closed) — D1/D2 + stale cross-refs fixed in-body. Implement with TDD on T2 preference conflict + T3 AS OF before demo script. First action: T1 cluster + verified `schema.sql`.

**Converged round-2 findings (applied):**
- D1 AS OF no `$1` + Date-sanitize literal
- D2 no CRDB `UPSERT` on non-PK unique → `INSERT ON CONFLICT`
- Stale always-register / structured-error matrix rows
- Constraint 9 simplified; node:http createServer excluded; judge enable path in matrix
