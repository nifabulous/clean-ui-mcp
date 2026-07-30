/**
 * Shared error sanitizers — the single source of truth for rendering error
 * detail that is about to cross a trust boundary (a client HTTP body, an MCP
 * tool response, the DOM, or an operator log).
 *
 * SECURITY: internal error detail must never leak. Node `fs`/errno messages
 * embed absolute filesystem PATHS (`… open '/Users/.../shot.png'`); the tagger
 * builds errors from raw PROVIDER RESPONSE BODIES; Playwright errors embed
 * SOURCE URLs. None of that may reach a client or a log.
 *
 * NOTE: `describeInternalError` (src/scripts/ui-server.ts) and
 * `describeCaughtError` (src/tagger.ts) predate this module and duplicate
 * {@link describeError}. They will migrate here once their in-flight PRs land;
 * new call sites should import from here.
 */

/**
 * Render a caught value as a short descriptor safe for any sink: the error's
 * constructor name plus, for errno errors, the `code` — never `.message` or
 * `.stack`. `name`/`code` are emitted only when they match a strict
 * identifier / errno shape, so a userland-mutable field cannot smuggle a path
 * (or even a bare `secret.png`); anything off-shape collapses to `Error`.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return `non-error (${typeof err})`;
  const rawName = err.name;
  const name =
    typeof rawName === "string" && rawName.length <= 40 && /^[A-Za-z][A-Za-z0-9]*$/.test(rawName)
      ? rawName
      : "Error";
  const rawCode = (err as NodeJS.ErrnoException).code;
  const code =
    typeof rawCode === "string" && rawCode.length <= 40 && /^[A-Z][A-Z0-9_]*$/.test(rawCode)
      ? rawCode
      : null;
  return code ? `${name}: ${code}` : name;
}
