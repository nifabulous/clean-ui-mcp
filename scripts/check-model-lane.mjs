#!/usr/bin/env node
/**
 * Operator-side model-lane health check. Resolves config through the SAME
 * create-ui-spec-model-config path the server uses, then makes one tiny call.
 * Exit 0 when reachable (or not configured); exit 1 when configured but
 * unreachable, so CI or a boot script can gate on it.
 */
import { loadEnv } from "../dist/env.js";
import { resolveCreateUiSpecModelConfig } from "../dist/create-ui-spec-model-config.js";
import { runModelLaneCheck } from "../dist/model-lane-check.js";

loadEnv();
const config = resolveCreateUiSpecModelConfig(process.env);
const result = await runModelLaneCheck(config);
console.log(JSON.stringify(result, null, 2));
if (result.configured && result.reachable === false) {
  process.exit(1);
}
