/**
 * crawl-policy.ts — the bounded representative crawl planner.
 *
 * Pure function: takes the user's starting URL plus the links discovered
 * during the initial public, same-origin, unauthenticated, non-mutating
 * inspection, and produces a CrawlPlan that is GUARANTEED:
 *
 *   - bounded: at most `maxRoutes` routes (default 25, hard-capped at 30);
 *   - same-origin: every route shares the startUrl's origin;
 *   - non-destructive: no logout/signout/delete/remove/purchase/checkout/
 *     invite/admin paths;
 *   - html-only: no zip/pdf/png/jpeg/gif/webp/svg/mp4/mp3/json/xml, and no
 *     `/api/` paths (those are data endpoints, not pages);
 *   - credential-free: any non-empty cookie/authorization/password throws.
 *
 * The planner is the single choke point that enforces the global
 * pre-capture constraints. No URL is silently dropped: every accepted
 * route has a reason and every rejected URL has a reason.
 */

/** Deny paths that would mutate state or expose privileged surfaces. */
const DESTRUCTIVE_PATH = /(logout|signout|delete|remove|purchase|checkout|invite|admin)(\/|$)/i;

/** Deny non-HTML asset extensions (binary/media/data, not renderable pages). */
const NON_HTML_EXTENSION = /\.(?:zip|pdf|png|jpe?g|gif|webp|svg|mp4|mp3|json|xml)$/i;

/** Query-string keys that carry no identity (tracking/referral attribution). */
const TRACKING_QUERY_KEYS = new Set(["gclid", "fbclid", "ref"]);
const isTrackingKey = (key: string): boolean =>
  key.startsWith("utm_") || TRACKING_QUERY_KEYS.has(key);

const DEFAULT_MAX_ROUTES = 25;
const HARD_MAX_ROUTES = 30;
const HARD_MIN_ROUTES = 1;

export type CrawlPlanInput = {
  startUrl: string;
  discoveredUrls: readonly string[];
  maxRoutes?: number;
  includeUrls?: readonly string[];
  excludeUrls?: readonly string[];
  cookie?: string;
  authorization?: string;
  password?: string;
};

export type CrawlPlan = {
  origin: string;
  maxRoutes: number;
  routes: Array<{ url: string; reason: "user-supplied" | "discovered" | "user-included" }>;
  skipped: Array<{
    url: string;
    reason: "cross-origin" | "non-html" | "destructive" | "excluded" | "duplicate" | "budget";
  }>;
};

type RouteReason = CrawlPlan["routes"][number]["reason"];
type SkipReason = CrawlPlan["skipped"][number]["reason"];

const CREDENTIAL_REJECTION =
  "raw credentials are not accepted; continue with public routes only";

/**
 * Parse a URL and strip the fragment plus the tracking query keys
 * (utm-prefixed, gclid, fbclid, ref). Returns the parsed URL (whose
 * `.toString()` is the canonical form) or null if the input is not a
 * parseable URL. Canonicalization is what makes a tracking-param variant
 * and a fragment variant of the same page collapse to one route.
 */
function canonicalize(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  parsed.hash = "";
  // searchParams.keys() returns each occurrence; delete() removes all values
  // for that key. Iterate over a snapshot so deletion during iteration is safe.
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (isTrackingKey(key)) parsed.searchParams.delete(key);
  }
  return parsed;
}

type Verdict = { kind: "route" } | { kind: "skip"; reason: SkipReason };

/**
 * Apply the per-URL acceptance filters (origin, destructive, non-html,
 * exclude). Dedup and budget are handled by the caller, since they depend on
 * global planner state (the seen-set and the current route count). Precedence:
 * cross-origin > destructive > non-html > excluded — the most security-
 * relevant reason wins when multiple apply.
 */
function classify(parsed: URL, startOrigin: string, excludeSet: Set<string>): Verdict {
  if (parsed.origin !== startOrigin) return { kind: "skip", reason: "cross-origin" };
  // WHATWG URL.pathname does NOT decode percent-encoding, so a discovered URL
  // like /%61dmin (which decodes to /admin) would bypass the destructive-path
  // regex. Discovered URLs come from crawled pages (attacker-controllable), so
  // decode before applying the destructive / non-html / api filters.
  let pathForFilter = parsed.pathname;
  try {
    pathForFilter = decodeURIComponent(pathForFilter);
  } catch {
    // leave raw on malformed encoding — it will be filtered on the raw form,
    // fail-safe.
  }
  if (DESTRUCTIVE_PATH.test(pathForFilter)) return { kind: "skip", reason: "destructive" };
  if (pathForFilter.includes("/api/") || NON_HTML_EXTENSION.test(pathForFilter)) {
    return { kind: "skip", reason: "non-html" };
  }
  if (excludeSet.has(parsed.toString())) return { kind: "skip", reason: "excluded" };
  return { kind: "route" };
}

/**
 * Plan a bounded, same-origin, non-destructive representative crawl. See the
 * file header for the invariants the result is guaranteed to satisfy.
 */
export function planRepresentativeCrawl(input: CrawlPlanInput): CrawlPlan {
  // Credential gate — checked first, before any planning. Any non-empty
  // credential field rejects the whole call; the caller must continue with
  // public routes only.
  if (input.cookie) throw new Error(CREDENTIAL_REJECTION);
  if (input.authorization) throw new Error(CREDENTIAL_REJECTION);
  if (input.password) throw new Error(CREDENTIAL_REJECTION);

  // Cap the budget. The caller can lower it (down to 1); they cannot raise it
  // past the hard cap of 30 — that's the bound the crawl is guaranteed to fit.
  // A non-finite value (NaN from parseInt("garbage") or JSON, ±Infinity) must
  // fall back to default rather than produce NaN, which would silently unbound
  // the plan (routes.length >= NaN is always false, so the budget never fires).
  // Number.isFinite(undefined) returns false, so the undefined case (no field
  // provided) is also routed to the default.
  const requested = Number.isFinite(input.maxRoutes) ? (input.maxRoutes as number) : DEFAULT_MAX_ROUTES;
  const maxRoutes = Math.min(Math.max(HARD_MIN_ROUTES, requested), HARD_MAX_ROUTES);

  // startUrl is the user's explicit entry — it defines the origin every route
  // must share. Assumed parseable (the caller is providing their own URL).
  const startParsed = canonicalize(input.startUrl) ?? new URL(input.startUrl);
  const startOrigin = startParsed.origin;
  const startCanonical = startParsed.toString();

  // Build the exclude-set from canonicalized excludeUrls. Only parseable
  // exclude entries participate (an unparseable exclude can't match a route).
  const excludeSet = new Set<string>();
  for (const raw of input.excludeUrls ?? []) {
    const parsed = canonicalize(raw);
    if (parsed) excludeSet.add(parsed.toString());
  }

  const routes: CrawlPlan["routes"] = [];
  const skipped: CrawlPlan["skipped"] = [];
  const seen = new Set<string>();

  // startUrl is ALWAYS route[0]. It is same-origin to itself by definition and
  // is the user's explicit choice of entry point, so the destructive/api/html
  // filters do not gate it — only canonicalization (fragment/tracking strip).
  routes.push({ url: startCanonical, reason: "user-supplied" });
  seen.add(startCanonical);

  // Consider a candidate URL for inclusion. Order of checks:
  //   parse → classify(filters) → dedup → budget.
  // The first failing check determines the skip reason; only URLs that pass
  // all of them become routes.
  const consider = (raw: string, routeReason: RouteReason): void => {
    const parsed = canonicalize(raw);
    if (!parsed) {
      // Unparseable — cannot establish same-origin. Safest classification
      // within the allowed reason set is cross-origin. Shown as the raw input.
      skipped.push({ url: raw, reason: "cross-origin" });
      return;
    }
    const canonical = parsed.toString();
    const verdict = classify(parsed, startOrigin, excludeSet);
    if (verdict.kind === "skip") {
      skipped.push({ url: canonical, reason: verdict.reason });
      return;
    }
    if (seen.has(canonical)) {
      skipped.push({ url: canonical, reason: "duplicate" });
      return;
    }
    if (routes.length >= maxRoutes) {
      skipped.push({ url: canonical, reason: "budget" });
      return;
    }
    routes.push({ url: canonical, reason: routeReason });
    seen.add(canonical);
  };

  // Priority order: user-supplied (already added) → user-included → discovered.
  // Explicit user intent precedes discovered links.
  for (const raw of input.includeUrls ?? []) consider(raw, "user-included");
  for (const raw of input.discoveredUrls) consider(raw, "discovered");

  return { origin: startOrigin, maxRoutes, routes, skipped };
}
