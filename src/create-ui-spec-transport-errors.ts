/**
 * create-ui-spec-transport-errors.ts — the ONE core→transport error mapping
 * shared by every create_ui_spec transport adapter (Task 5 of the C3 slice).
 *
 * WHY THIS MODULE EXISTS. Two adapters serve `create_ui_spec`: the MCP adapter
 * (create-ui-spec-mcp.ts, Task 3) and the loopback HTTP adapter
 * (create-ui-spec-http.ts, Task 5). Their SUCCESS shapes genuinely differ — MCP
 * returns the standard tool envelope, HTTP returns the parsed
 * `DesignArtifactEnvelope` itself — so those cannot be shared. Their ERROR
 * decisions are the same decision three times over:
 *
 *   1. which transport code a core error becomes,
 *   2. which bounded, path-free message is safe to publish,
 *   3. whether the caller may retry.
 *
 * If each adapter owned its own copy, the two transports would drift the first
 * time one of the three changed — and the drift would be invisible, because each
 * adapter's own tests would still pass. So the triple is produced HERE, once,
 * and both adapters serialize what this module returns.
 *
 * WHAT IS NOT SHARED, DELIBERATELY. The transport ENVELOPE around the triple is
 * each adapter's own: MCP wraps it in `structuredContent.error` + `isError` and
 * revalidates through `parseToolResult`; HTTP wraps it in `{ error }` with an
 * HTTP status. Sharing the envelope would force one transport's shape onto the
 * other, which is precisely the mistake the shape difference exists to avoid.
 *
 * NOTHING DERIVED FROM AN EXCEPTION IS EVER PUBLISHED. A thrown value that
 * parses as a typed core error contributes its own already-`SafeErrorMessage`
 * validated text (re-asserted here so this boundary does not depend on that
 * remaining true upstream). Anything else — a raw `Error`, a string, a rejected
 * reader promise carrying a filesystem path or a url — is an unexpected internal
 * fault: it becomes `PROVIDER_ERROR` with a FIXED message, and its text is
 * discarded, never surfaced and never logged from here.
 */
import {
  CreateUiSpecErrorSchema,
  SafeErrorMessage,
} from "./create-ui-spec-contracts.js";
import { ERROR_RETRYABLE } from "./tool-contracts.js";

/**
 * The transport error codes create_ui_spec may publish — exactly the two in the
 * tool descriptor's `errorCodes`. No adapter introduces a third: a new code
 * would have to be taught to the shared contract first, and an HTTP-only code
 * would be a shape the MCP surface could never serve.
 */
export type CreateUiSpecTransportErrorCode = "INVALID_INPUT" | "PROVIDER_ERROR";

/** The bounded triple both adapters serialize. No other field is ever added. */
export interface CreateUiSpecTransportError {
  readonly code: CreateUiSpecTransportErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Fixed messages, used when a caller-facing failure has no typed core message of
 * its own (transport input that never reached the core) or when a core message
 * somehow fails {@link SafeErrorMessage}. Never derived from an exception, a
 * caller value, or the brief.
 */
export const CREATE_UI_SPEC_TRANSPORT_FALLBACK_MESSAGE: Readonly<
  Record<CreateUiSpecTransportErrorCode, string>
> = Object.freeze({
  INVALID_INPUT: "The create_ui_spec request could not be accepted.",
  PROVIDER_ERROR: "Design spec assembly is temporarily unavailable.",
});

/**
 * The ONE core→transport code mapping. Core `INVALID_INPUT` becomes the existing
 * non-retryable transport `INVALID_INPUT`; core `RETRIEVAL_UNAVAILABLE` becomes
 * the existing retryable `PROVIDER_ERROR`.
 */
const CORE_TO_TRANSPORT_CODE: Readonly<
  Record<"INVALID_INPUT" | "RETRIEVAL_UNAVAILABLE", CreateUiSpecTransportErrorCode>
> = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  RETRIEVAL_UNAVAILABLE: "PROVIDER_ERROR",
});

/**
 * Build the triple for a transport-level refusal — a request that never reached
 * the core producer (input that failed the transport schema, or a request
 * carrying something the C3 surface refuses to accept at all). The message is
 * the fixed fallback: there is no core error to take one from, and the caller's
 * own values must not be echoed back.
 *
 * `retryable` comes from the SHARED {@link ERROR_RETRYABLE} table rather than a
 * literal, so a code and its retryability cannot drift apart here.
 */
export function createUiSpecTransportError(
  code: CreateUiSpecTransportErrorCode,
): CreateUiSpecTransportError {
  return {
    code,
    message: CREATE_UI_SPEC_TRANSPORT_FALLBACK_MESSAGE[code],
    retryable: ERROR_RETRYABLE[code]!,
  };
}

/**
 * The triple for a DETERMINISTIC integrity refusal — the envelope about to be
 * served failed its own re-check, i.e. a producer or adapter defect.
 *
 * WHY THIS IS NOT `createUiSpecTransportError("PROVIDER_ERROR")`. The code and the
 * message must stay the shared `PROVIDER_ERROR` pair: a caller must not learn from
 * the response that it hit a producer defect rather than a transient retrieval
 * failure. But `retryable` is a PROMISE TO THE CLIENT about repeatability, and
 * this failure is reproducible for the same request — the shared
 * `ERROR_RETRYABLE.PROVIDER_ERROR` value (`true`) would tell a conforming client
 * to retry a request that will fail identically forever. So this ONE case departs
 * from the table, deliberately and by name rather than through a general override
 * parameter that any caller could reach for.
 */
export function createUiSpecIntegrityRefusalError(): CreateUiSpecTransportError {
  return {
    ...createUiSpecTransportError("PROVIDER_ERROR"),
    retryable: false,
  };
}

/**
 * Map a thrown producer failure onto the shared triple.
 *
 * The thrown value is validated through {@link CreateUiSpecErrorSchema} — the
 * core's OWN error contract — so both the code and the bounded, path-free
 * message are the core's, not a re-interpretation. Anything that does not parse
 * as a typed core error becomes `PROVIDER_ERROR` with the fixed message and its
 * raw text (which can carry a path, a url or a stack) is discarded.
 */
export function mapCoreErrorToTransportError(err: unknown): CreateUiSpecTransportError {
  const typed = CreateUiSpecErrorSchema.safeParse(err);
  if (!typed.success) {
    return createUiSpecTransportError("PROVIDER_ERROR");
  }
  const code = CORE_TO_TRANSPORT_CODE[typed.data.code];
  const safe = SafeErrorMessage.safeParse(typed.data.message);
  return {
    code,
    message: safe.success ? safe.data : CREATE_UI_SPEC_TRANSPORT_FALLBACK_MESSAGE[code],
    retryable: ERROR_RETRYABLE[code]!,
  };
}
