#!/usr/bin/env node
/**
 * run-no-egress — a shell-level network-scrubbed runner for Phase 0 verification.
 *
 * Stripped from the plan's Docker-container approach to a pragmatic shell version
 * that unsets all API keys, sets RUN_LIVE_INTEGRATION=0, and runs a command.
 * The safety property: "tests pass without API keys and without live provider
 * calls." This is not a cryptographic egress guarantee — it's a practical
 * verification that the codebase is self-contained without keys.
 *
 * Usage:
 *   node scripts/run-no-egress.mjs -- npm test
 *   node scripts/run-no-egress.mjs -- npm run build
 *
 * For full no-egress (DNS-level blocking), run inside:
 *   docker run --network none -v "$PWD":/work -w /work node:22 node scripts/run-no-egress.mjs -- npm test
 */
import { spawn } from "node:child_process";

// Scrub ALL provider credentials, not just the base key names. Production code
// reads suffixed variants (OPENAI_API_KEY_EXTRACTION, OPENAI_API_KEY_CRITIQUE,
// OPENAI_API_KEY_<tier>, etc.) — a hard-coded list misses those, leaving live
// credentials available during a supposed credential-scrubbed run. Pattern-based
// scrubbing catches every recognized variant.
const PROVIDER_KEY_PATTERNS = [
  /^OPENAI_API_KEY/i,       // base + _EXTRACTION + _CRITIQUE + _<tier> variants
  /^ANTHROPIC_API_KEY/i,
  /^GEMINI_API_KEY/i,
  /^MISTRAL_API_KEY/i,
  /^MINIMAX_API_KEY/i,
  /^XAI_API_KEY/i,
  /^VOYAGE_API_KEY/i,
  /^IMAGE_EMBEDDING_API_KEY/i,
];

const env = { ...process.env };
const redacted = [];
for (const key of Object.keys(env)) {
  if (PROVIDER_KEY_PATTERNS.some((p) => p.test(key))) {
    delete env[key];
    redacted.push(key);
  }
}
env.RUN_LIVE_INTEGRATION = "0";

const args = process.argv.slice(2);
// Handle `-- <command>` or direct command
const cmd = args[0] === "--" ? args.slice(1) : args;

if (cmd.length === 0) {
  console.error("Usage: run-no-egress.mjs -- <command> [args...]");
  process.exit(1);
}

console.error(`[no-egress] Running: ${cmd.join(" ")}`);
console.error(`[no-egress] Redacted keys: ${redacted.join(", ") || "(none found)"}`);
console.error(`[no-egress] RUN_LIVE_INTEGRATION=0`);

// No shell: true — spawn receives an executable + argv array directly. Shell mode
// would reparse the argv through the shell, breaking arguments with spaces,
// quotes, or metacharacters, and emits DEP0190 for the unsafe combination.
const child = spawn(cmd[0], cmd.slice(1), {
  env,
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
