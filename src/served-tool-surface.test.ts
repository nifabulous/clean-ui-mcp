/**
 * The SERVED and SHIPPED tool surface may not name a tool the server rejects.
 *
 * ─── THE DEFECT THIS PINS (OBSERVED, NOT THEORISED) ─────────────────────────
 *
 * Task 3 of the C3 slice deregistered `generate_design_prompt` and registered
 * `create_ui_spec` in its place. `src/mcp-smoke.test.ts` pinned the tool NAMES
 * over the real protocol — the listing set and the rejected `tools/call` — and
 * that stayed green. What nothing looked at was the `description` STRINGS, which
 * are also `tools/list` output, i.e. bytes an MCP client reads and acts on. Two
 * surviving tools still routed the caller to the removed tool:
 *
 *   - `recommend_ui_direction`  "…use generate_design_prompt when you already
 *                                have ids."
 *   - `get_stealable_techniques` "…rather than a synthesized brief (use
 *                                generate_design_prompt for that)."
 *
 * So the same server advertised a tool it would reject, over the protocol, with
 * a full green suite. The shipped skill (`skill/clean-ui-design/SKILL.md`), the
 * curator Settings tool list (`ui/app.js`) and the README tool table had the
 * same defect, and `create_ui_spec` was named in none of them.
 *
 * ─── WHY A NAME-SET TEST IS NOT ENOUGH ──────────────────────────────────────
 *
 * A test that only compares the registered set against a literal cannot see a
 * referral inside prose. This suite therefore scans the TEXT of each surface for
 * every token in the project's tool-name vocabulary and requires each hit to be
 * a name `createServer()` actually registers. That makes the next deregistration
 * fail here — in the served description, in the skill, in the curator list, and
 * in the README — rather than in a user's session.
 *
 * ─── SCOPE OF THE VOCABULARY ────────────────────────────────────────────────
 *
 * The vocabulary is the LIVE names only: `Object.keys(LEGACY_TO_BETA_MAP)` (the
 * legacy names the server registers today, plus `generate_design_prompt`, which
 * the map deliberately keeps as a migration row) together with the two names
 * that are not legacy at all, `create_ui_spec` and `critique_ui`. The BETA
 * catalog names (`search_ui_references`, `plan_ui_direction`, …) are excluded on
 * purpose: they are a parallel contract system that no live registration uses
 * (`server-factory.ts` never imports `tool-contracts.js`), and documenting them
 * as the forthcoming surface is legitimate rather than drift. If the beta names
 * ever become the registered names, add them here — the exclusion is a statement
 * about today's registrations, not a permanent carve-out.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LEGACY_TO_BETA_MAP } from "./tool-catalog.js";
import { createServer } from "./server-factory.js";
import type { CorpusReader } from "./corpus-reader.js";

const repoRoot = resolve(__dirname, "..");

/**
 * `createServer` is a pure factory: it only calls `server.registerTool`, and no
 * handler runs during registration or during `tools/list`. So the reader can be
 * a stub — this suite reads the ADVERTISED surface, never a tool result.
 */
const stubReader = {} as unknown as CorpusReader;

/** `tools/list` over a real Client ↔ Server transport pair — the actual bytes. */
async function listServedTools(): Promise<Array<{ name: string; description: string }>> {
  const server = createServer(stubReader);
  const client = new Client({ name: "served-tool-surface-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    return listed.tools.map((t) => ({ name: t.name, description: t.description ?? "" }));
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * Every tool name that can appear in live prose. See the header for why the beta
 * catalog names are not in here.
 */
const TOOL_NAME_VOCABULARY: readonly string[] = Object.freeze([
  ...Object.keys(LEGACY_TO_BETA_MAP),
  "create_ui_spec",
  "critique_ui",
]);

/** Vocabulary tokens present in `text`, matched on a word boundary. */
function toolNamesMentionedIn(text: string): string[] {
  return TOOL_NAME_VOCABULARY.filter((name) =>
    new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text),
  ).sort();
}

/**
 * Marks a block of documentation as saying a tool is NOT callable.
 *
 * WHY THE DOC RULE IS NOT "THE NAME MAY NOT APPEAR". A migration note is the
 * single most useful thing a doc can say about a removed tool — "`X` is gone,
 * call `Y` instead" — and a blanket ban would delete exactly the sentence that
 * stops an agent guessing. But a bare mention is also how the four stale
 * referrals survived. So the rule is positional: an unregistered name may appear
 * only in a block that also marks it as removed.
 *
 * WHAT THIS DOES NOT PROVE. The marker is lexical and same-block, so a sentence
 * that both instructs the call and carries a marker word ("use `X` — no longer
 * for palettes") would pass. It is a tripwire against the observed defect (a
 * referral with NO removal context anywhere near it), not a semantic reader. The
 * served-description rule below has no marker escape at all, because protocol
 * output has no legitimate reason to name a rejected tool.
 */
const REMOVAL_MARKER =
  /no longer|deregister|reject|removed|replaced|replaces|supersed|migration|→/i;

/** Blank-line-separated blocks — a markdown paragraph, list item, or blockquote. */
function blocksOf(text: string): string[] {
  return text.split(/\n\s*\n/);
}

/** How much of an offending block the failure message quotes. DISPLAY ONLY. */
const BLOCK_EXCERPT_CHARS = 220;

/**
 * The doc rule, as a callable predicate: every block of `text` that names a tool
 * outside `registered` WITHOUT marking it removed.
 *
 * WHY THE 220-CHARACTER SLICE IS NOT THE PREDICATE'S INPUT. The earlier form of
 * this check computed `unregistered` from the FULL block but stored
 * `block: block.trim().slice(0, 220)` and then filtered on
 * `!REMOVAL_MARKER.test(row.block)` — i.e. it sought the removal marker in the
 * TRUNCATION while deriving the finding from the whole block. A block whose
 * marker sits past character 220 therefore failed the assertion even though it
 * satisfied the rule this test's own title states; a README draft tripped exactly
 * that despite containing the word "removed". The slice exists to keep the failure
 * message readable, which is the only thing it is used for now.
 *
 * THE FIX DOES NOT LOOSEN THE RULE. Truncating the marker search could only
 * produce a FALSE FAILURE, never a false pass (searching less text can only find
 * fewer markers, and fewer markers means more offenders). So restoring the full
 * block as the predicate's input removes false failures and adds no false passes:
 * `unregistered` is still computed from the full block, `REMOVAL_MARKER` is
 * unchanged, and a block that names an unregistered tool with NO marker anywhere
 * in it is still an offender. Both directions are pinned by the two cases below
 * this `describe`'s `it.each`.
 *
 * Exported shape is a plain array so callers can assert on it directly — the
 * synthetic cases exercise the predicate without needing a shipped file.
 */
function unmarkedUnregisteredBlocks(
  text: string,
  registered: ReadonlySet<string>,
): Array<{ unregistered: string[]; block: string }> {
  return blocksOf(text)
    .map((block) => ({
      unregistered: toolNamesMentionedIn(block).filter((n) => !registered.has(n)),
      // The marker is sought in the SAME text the finding is derived from.
      markedRemoved: REMOVAL_MARKER.test(block),
      block: block.trim().slice(0, BLOCK_EXCERPT_CHARS),
    }))
    .filter((row) => row.unregistered.length > 0 && !row.markedRemoved)
    .map(({ unregistered, block }) => ({ unregistered, block }));
}

describe("served tool surface — tools/list advertises only registered tools", () => {
  it("registers the exact 14-tool public set, with create_ui_spec and without generate_design_prompt", async () => {
    const served = await listServedTools();
    expect(served.map((t) => t.name).sort()).toEqual(
      [
        "browse_ui_examples",
        "compare_ui_examples",
        "create_ui_spec",
        "critique_ui",
        "get_anti_patterns",
        "get_color_palette",
        "get_similar_ui_examples",
        "get_stealable_techniques",
        "get_ui_example",
        "list_categories",
        "list_domain_tags",
        "list_style_tags",
        "recommend_ui_direction",
        "search_ui_examples",
      ].sort(),
    );
  });

  it("no served description names a tool this server does not register", async () => {
    // THE ASSERTION mcp-smoke.test.ts CANNOT MAKE. It pins the name SET and the
    // rejected call; a referral buried in a sibling tool's description text is
    // invisible to both. `tools/list` descriptions are protocol output, so a
    // stale referral here is the server telling a client to call something the
    // same server will reject.
    const served = await listServedTools();
    const registered = new Set(served.map((t) => t.name));
    const offenders = served
      .map((t) => ({
        tool: t.name,
        unregistered: toolNamesMentionedIn(t.description).filter((n) => !registered.has(n)),
      }))
      .filter((row) => row.unregistered.length > 0);
    expect(
      offenders,
      `these served descriptions route callers to unregistered tools: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});

describe("shipped tool surface — documentation and clients name only registered tools", () => {
  // Files that TELL A CALLER (human or agent) which tool to invoke. Each is a
  // surface that ships: the skill is loaded by the agent, ui/app.js renders the
  // curator's tool list, README is the operator's reference.
  const SHIPPED_SURFACES: readonly string[] = Object.freeze([
    "skill/clean-ui-design/SKILL.md",
    "ui/app.js",
    "README.md",
  ]);

  it.each(SHIPPED_SURFACES)(
    "%s mentions an unregistered tool only in a block that marks it removed",
    async (relPath) => {
      const registered = new Set((await listServedTools()).map((t) => t.name));
      const text = readFileSync(resolve(repoRoot, relPath), "utf-8");
      const offenders = unmarkedUnregisteredBlocks(text, registered);
      expect(
        offenders,
        `${relPath} refers to tool(s) createServer() does not register, with nothing marking ` +
          `them removed: ${JSON.stringify(offenders)}. Either drop the referral or say the tool ` +
          `is gone and name its replacement.`,
      ).toEqual([]);
    },
  );

  // ── The predicate itself, in both directions ──────────────────────────────
  //
  // Every surface that ships today happens to mark removal EARLY, so neither
  // `it.each` above can tell the truncated predicate from the fixed one. These two
  // cases are the fix's only real proof, and they pin it in both directions: the
  // long marked block must PASS (the false failure that was the bug) and the
  // genuine violation must FAIL (the property that must not be loosened).
  describe("the doc predicate itself — marker position must not decide the verdict", () => {
    /** In the vocabulary (a `LEGACY_TO_BETA_MAP` key) and not registered. */
    const UNREGISTERED = "generate_design_prompt";

    it("the vocabulary token used below really is unregistered — otherwise these two cases prove nothing", async () => {
      const registered = new Set((await listServedTools()).map((t) => t.name));
      expect(TOOL_NAME_VOCABULARY).toContain(UNREGISTERED);
      expect(registered.has(UNREGISTERED)).toBe(false);
    });

    it("accepts a removal marker that sits PAST character 220 — the truncation bug", async () => {
      const registered = new Set((await listServedTools()).map((t) => t.name));
      // Filler carries no vocabulary token and no marker word, so the ONLY marker
      // in the block is the one after it.
      const filler = "Historical context sentence. ".repeat(12);
      const block = `The ${UNREGISTERED} entry point. ${filler}It was removed; call create_ui_spec instead.`;
      // The marker really is beyond the excerpt window, and really is inside the
      // full block — otherwise this case would pass for the wrong reason.
      expect(block.indexOf("removed")).toBeGreaterThan(BLOCK_EXCERPT_CHARS);
      expect(REMOVAL_MARKER.test(block)).toBe(true);
      expect(REMOVAL_MARKER.test(block.slice(0, BLOCK_EXCERPT_CHARS))).toBe(false);
      expect(unmarkedUnregisteredBlocks(block, registered)).toEqual([]);
    });

    it("still refuses a genuine referral with NO removal marker anywhere in the block", async () => {
      const registered = new Set((await listServedTools()).map((t) => t.name));
      const filler = "Historical context sentence. ".repeat(12);
      const block = `Call ${UNREGISTERED} when you already have ids. ${filler}It is the synthesis entry point.`;
      expect(block.length).toBeGreaterThan(BLOCK_EXCERPT_CHARS);
      const offenders = unmarkedUnregisteredBlocks(block, registered);
      expect(offenders.map((o) => o.unregistered)).toEqual([[UNREGISTERED]]);
      // The excerpt is still bounded — the display slice survived the fix.
      expect(offenders[0]!.block.length).toBeLessThanOrEqual(BLOCK_EXCERPT_CHARS);
    });
  });

  it.each(SHIPPED_SURFACES)("%s names create_ui_spec, the synthesis entry point", async (relPath) => {
    // The complement of the check above: removing the stale referral without
    // naming the replacement leaves the branch's headline tool undiscoverable,
    // which is how `generate_design_prompt` came to be documented in four places
    // while `create_ui_spec` was documented in none.
    const text = readFileSync(resolve(repoRoot, relPath), "utf-8");
    expect(toolNamesMentionedIn(text)).toContain("create_ui_spec");
  });
});
