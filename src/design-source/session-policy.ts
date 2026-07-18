/**
 * session-policy.ts — the ephemeral cookie + consent policy.
 *
 * Pure functions only. No browser clicking, no cookie persistence, no
 * cookie jar, no I/O. These decisions are deterministic and
 * session-only — they never persist and never leak across capture
 * contexts.
 *
 * Global constraints enforced here:
 *   - Essential first-party cookies may exist only inside ONE ephemeral
 *     capture context; third-party cookies are blocked.
 *   - Cookie decisions are deterministic and session-only.
 *
 * `decideCookie` is the single choke point that decides whether a cookie
 * observed during a capture is permitted (session-scoped, first-party,
 * essential) or must be blocked.
 *
 * `chooseConsentAction` selects the safest rejection button from the
 * visible consent surface, or signals that no safe action exists.
 */

/** A cookie under consideration for the ephemeral capture context. */
export type CookieInput = {
  /** Full request origin URL, e.g. `https://example.com`. */
  requestOrigin: string;
  /** Cookie's own domain attribute (host or parent host). */
  cookieDomain: string;
  /** Must be explicitly `true` for an essential cookie. */
  essential: boolean;
};

/** The verdict for a single cookie. */
export type CookieDecision = "allow-session-first-party" | "block";

/** The chosen action for a consent surface. */
export type ConsentDecision =
  | { kind: "click"; label: string }
  | { kind: "stop"; reason: string };

/**
 * The set of consent-button labels that constitute a safe rejection.
 * Anchored (^...$) so that ambiguous prefixes/affixes like "Continue",
 * "Accept", "Save", "Submit", bare "Reject", or bare "Necessary" do NOT
 * match. Case-insensitive.
 */
const SAFE_REJECTION_LABEL = /^(reject (?:all|non-essential)|necessary only|decline optional)$/i;

/**
 * Returns `true` when `cookieDomain` is the same host as `hostname` or a
 * PARENT domain of it (e.g. `example.com` is a parent of `www.example.com`
 * and of `example.com` itself).
 *
 * Implemented as: hostname === cookieDomain OR hostname ends with
 * `"." + cookieDomain`. This deliberately avoids bare-suffix matching so
 * that `xexample.com` is NOT treated as a child of `example.com`.
 */
const isFirstParty = (hostname: string, cookieDomain: string): boolean =>
  hostname === cookieDomain || hostname.endsWith("." + cookieDomain);

/**
 * Decide whether a cookie may live in the ephemeral first-party capture
 * context. Returns `"allow-session-first-party"` ONLY when:
 *   - `essential === true` (explicitly), AND
 *   - the cookie's domain is the request hostname OR a parent domain of it.
 *
 * Everything else — non-essential cookies, third-party/tracker cookies,
 * suffix-aliasing traps, child-domain cookies, and unparseable request
 * origins — fails closed to `"block"`.
 */
export const decideCookie = (cookie: CookieInput): CookieDecision => {
  if (cookie.essential !== true) {
    return "block";
  }
  let hostname: string;
  try {
    hostname = new URL(cookie.requestOrigin).hostname;
  } catch {
    // Malformed origin → fail closed.
    return "block";
  }
  return isFirstParty(hostname, cookie.cookieDomain)
    ? "allow-session-first-party"
    : "block";
};

/**
 * Choose the safest consent action from the visible consent buttons.
 *
 * Selects the FIRST label (in array order) matching a safe rejection
 * phrase (`reject all`, `reject non-essential`, `necessary only`, or
 * `decline optional`, case-insensitive). Returns the label exactly as
 * provided (original casing/spacing preserved).
 *
 * If no label matches — including ambiguous labels like `Continue`, `OK`,
 * `Accept`, `Save`, `Submit`, bare `Reject`, bare `Necessary`, or
 * `Preferences` — returns a stop decision so the caller declines to act
 * rather than risk an unintended consent grant.
 */
export const chooseConsentAction = (
  actions: readonly string[],
): ConsentDecision => {
  for (const label of actions) {
    if (SAFE_REJECTION_LABEL.test(label)) {
      return { kind: "click", label };
    }
  }
  return { kind: "stop", reason: "no safe rejection action" };
};
