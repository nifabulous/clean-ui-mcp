# Scouting — finding new UI examples for the corpus

`npm run scout` is the discovery front-end for the corpus. It finds real
product UIs that fill coverage gaps and hands them to the capture pipeline
as a `sources.json`-compatible file — you never type a candidate list by hand
unless you want to.

```
scout-sources → sources-scouted.json → npm run capture-batch →
tagger/review → commit-draft → corpus/entries.json
```

## What the scout does

1. **Gap analysis** — reads `corpus/entries.json` and ranks under-represented
   `patternType`, `category`, `styleTag`, and `industryVertical` values
   (rarest first). You can override this with explicit `--pattern`,
   `--category`, `--style`, `--industry` flags.
2. **Candidate generation** — asks the configured text model for real product
   URLs that plausibly fill the gaps. The prompt bans gallery/aggregator sites
   (Mobbin, Dribbble, Behance, Awwwards, ...) and sites whose ToS forbids
   automated collection, per `docs/SOURCING.md`.
3. **Verification** — every candidate passes the same guards as capture:
   the SSRF navigation check and the robots.txt hard gate, plus a reachability
   probe with per-hop redirect SSRF checks and `<title>`/`<meta>` extraction.
4. **Dedupe** — drops URLs, hostnames, and product names already in the corpus
   (or already accepted in the same run).
5. **Vision scoring** — screenshots each survivor into
   `corpus/images-private/scout/<runId>/` (gitignored) and asks the vision
   model to judge suitability against the targeted gaps. `suitable ≥ 3/5`
   is accepted; `unsuitable` is rejected; `uncertain` is listed for manual
   review.
6. **Output** — writes three files (default: repo root):
   - `sources-scouted.json` — capture-batch-ready array, with the scout's
     rationale and expected tags in each entry's `note`.
   - `scout-report-<runId>.md` — human-readable: accepted / uncertain /
     rejected / dropped, with reasons.
   - `scout-details.json` — full machine-readable records, including model
     scores and dropped-candidate reasons.

## Usage

```bash
# Fill the rarest gaps automatically (defaults to 10 accepted sources)
npm run scout

# Target specific gaps
npm run scout -- --pattern pricing --style glassmorphic --limit 5

# Skip screenshots + vision (metadata-only — cheaper, no image models)
npm run scout:no-vision

# Dry run: gap analysis + candidate generation only, no page fetches
npm run scout -- --dry-run

# LLM-free mode: load a hand-researched candidate list
npm run scout -- --candidates-file candidates.json --no-vision
```

Then capture and review:

```bash
npm run capture-batch -- sources-scouted.json
npm run review-draft
npm run commit-draft
```

## Options

| Flag | Meaning |
|---|---|
| `--limit <n>` | Max accepted sources (default 10) |
| `--max-candidates <n>` | Cap on LLM-generated candidates (default 12) |
| `--pattern / --category / --style / --industry <v>` | Target a specific gap (repeatable) |
| `--candidates-file <p>` | Skip LLM generation; load candidates from JSON |
| `--no-vision` | Skip screenshots + vision scoring |
| `--dry-run` | Stop after gap analysis + generation |
| `--out <dir>` | Output directory (default repo root) |
| `--run-id <id>` | Run id used in output filenames (default timestamp) |
| `--provider <p>` | Generation provider override |
| `--vision-provider <p>` | Vision-scoring provider override |
| `--corpus <path>` | Corpus entries.json path (default `corpus/entries.json`) |

## Model configuration

The scout reuses the tagger's provider abstraction — no new plumbing:

- **Generation** routes through `callTextModel` (the critique-pass routing).
  Override with `SCOUT_PROVIDER`, `SCOUT_MODEL`, `SCOUT_BASE_URL`,
  `SCOUT_API_KEY` (see `.env.example`). Unset → falls back to ambient
  `AUTO_TAG_PROVIDER` / critique-pass keys.
- **Vision scoring** routes through `callVisionModel` (the extraction-pass
  routing, which requires a vision provider). Override with
  `SCOUT_VISION_PROVIDER`, `SCOUT_VISION_MODEL`, `SCOUT_VISION_BASE_URL`,
  `SCOUT_VISION_API_KEY`.

## Sourcing rules (read before promoting anything)

- Everything the scout touches is private: screenshots live in
  `corpus/images-private/` (gitignored) and the emitted `sources-scouted.json`
  claims no redistribution rights. Promotion to `public-thumb` / `public-own`
  is a per-entry human decision — never bulk.
- The scout never proposes gallery/aggregator archives or sites whose ToS
  forbids automated collection. If a candidate sneaks through, reject it in
  review.
- The scout's output is a *candidate list*, not corpus truth. The critique /
  `whatToSteal` writing is still the human (or tagger-assisted) step — that is
  where the corpus's actual value is created.

## Security posture

The scout uses the same guards as the capture pipeline:
- `assertSafeNavigationTarget` (SSRF) before every fetch and screenshot.
- Per-hop redirect checks with `redirect: "manual"` for the metadata probe.
- `isAllowedByRobots` as a hard gate — candidates disallowed by robots.txt are
  dropped before any screenshot.

These are shared imports from `src/ssrf.ts` and `src/scripts/capture.ts`, so
the scout cannot drift into a laxer policy than capture itself.
