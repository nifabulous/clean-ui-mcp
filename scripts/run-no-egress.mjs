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

const REDACTED_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "XAI_API_KEY",
  "VOYAGE_API_KEY",
  "IMAGE_EMBEDDING_API_KEY",
];

const env = { ...process.env };
for (const key of REDACTED_KEYS) delete env[key];
env.RUN_LIVE_INTEGRATION = "0";

const args = process.argv.slice(2);
// Handle `-- <command>` or direct command
const cmd = args[0] === "--" ? args.slice(1) : args;

if (cmd.length === 0) {
  console.error("Usage: run-no-egress.mjs -- <command> [args...]");
  process.exit(1);
}

console.error(`[no-egress] Running: ${cmd.join(" ")}`);
console.error(`[no-egress] Redacted keys: ${REDACTED_KEYS.join(", ")}`);
console.error(`[no-egress] RUN_LIVE_INTEGRATION=0`);

const child = spawn(cmd[0], cmd.slice(1), {
  env,
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
