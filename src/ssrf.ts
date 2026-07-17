/**
 * ssrf.ts — Server-Side Request Forgery guard for URL capture.
 *
 * Both the curator dashboard (/api/capture-url) and the CLI capture script
 * (npm run capture / npm run capture-batch) launch a real browser on the
 * operator's machine using their network. Without this check, any web page
 * could ask the system to screenshot internal services or cloud-metadata
 * endpoints (http://169.254.169.254/...) and read the resulting file path
 * back. The guard resolves the hostname and rejects if any resolved address
 * is non-public.
 *
 * Exported from here so the CLI and UI paths share one rule rather than
 * drifting — a drift that silently re-enables SSRF on one path is the
 * worst-case failure mode.
 */
import { lookup } from "node:dns";
import { promisify } from "node:util";

const lookupAll = promisify(lookup);

/**
 * True if the given IP string is private, loopback, link-local, or in a
 * known cloud-metadata range. Handles IPv4-mapped IPv6 (`::ffff:1.2.3.4`)
 * by recursing on the mapped IPv4.
 */
export function isPrivateAddress(ip: string): boolean {
  const normalized = ip.toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) return isPrivateAddress(mappedIpv4[1]);

  // IPv4
  if (/^(10\.|192\.168\.|169\.254\.)/.test(normalized)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return true;
  if (/^127\./.test(normalized)) return true;
  if (/^0\./.test(normalized)) return true;
  // CGNAT shared address space 100.64.0.0/10 (RFC 6598) — octet2 in 64..127.
  // Cloud metadata and internal services have been observed on these ranges;
  // prefix-style regex mirrors the checks above. Boundary: 100.128.0.0 is OUT.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalized)) return true;
  // Benchmarking 198.18.0.0/15 (RFC 2544) — octet2 in {18,19}. Boundary: 198.20.0.0 is OUT.
  if (/^198\.1[89]\./.test(normalized)) return true;
  // IETF protocol assignments 192.0.0.0/24 (RFC 6890, includes 192.0.0.0/24 and
  // the 192.0.0.{0..255} benchmarking/discovery block). octet2=0 AND octet3=0.
  // Note: 192.0.0.0/24 is a subset of the /24, so octet3 must equal 0.
  if (/^192\.0\.0\./.test(normalized)) return true;
  // IPv6
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  return false;
}

/**
 * If a validated capture URL points at localhost, return its exact origin
 * (`http://localhost:3000`) so installSsrfGuard can permit that one local
 * origin for same-origin requests. Returns undefined for public targets (no
 * local origin to allow). This preserves the local-dev capture workflow: the
 * operator's initial localhost target and its same-origin assets load, while
 * redirects/subresources to other private targets are still rejected.
 */
export function localOriginIfLocal(rawUrl: string | URL): string | undefined {
  let parsed: URL;
  try {
    parsed = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
  } catch {
    return undefined;
  }
  if (EXPLICIT_LOCALHOST.test(parsed.hostname)) {
    return parsed.origin;
  }
  return undefined;
}

/**
 * Cloud-metadata hostnames blocked regardless of what they resolve to —
 * Google's metadata.google.internal and AWS/Azure's 169.254.169.254 are
 * the canonical SSRF targets.
 */
const METADATA_HOSTNAMES = /metadata\.google\.internal|169\.254\.169\.254/i;

/**
 * Explicit localhost hostnames — allowed because local-dev captures against
 * a sandbox running on the same machine are a legitimate use case (the
 * common dev workflow). The UI additionally gates this on the request having
 * no cross-origin Origin; the CLI has no Origin concept so it just allows.
 */
const EXPLICIT_LOCALHOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

/**
 * Validate a URL is safe to launch a browser at. Returns the parsed URL on
 * success; throws an Error with a user-facing message on rejection.
 *
 * Rules:
 *   1. Must parse and use http or https.
 *   2. Hostname must not be a known metadata endpoint.
 *   3. Unless the hostname is explicit localhost, DNS must resolve to at
 *      least one address AND none of the resolved addresses may be private.
 */
export async function assertSafeCaptureTarget(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs can be captured");
  }
  if (METADATA_HOSTNAMES.test(parsed.hostname)) {
    throw new Error("Capture target resolves to a blocked metadata or private address");
  }
  if (!EXPLICIT_LOCALHOST.test(parsed.hostname)) {
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookupAll(parsed.hostname, { all: true });
    } catch {
      throw new Error(`Could not resolve host: ${parsed.hostname}`);
    }
    const bad = addresses.map((a) => a.address).find(isPrivateAddress);
    if (bad) {
      throw new Error("Capture target resolves to a blocked metadata or private address");
    }
  }
  return parsed;
}

/**
 * Per-hop navigation/resource check. Validates a URL the browser is about to
 * fetch during a capture — used for redirect hops AND subresource requests.
 *
 * Unlike assertSafeCaptureTarget (the INITIAL user-supplied target), this does
 * NOT apply the EXPLICIT_LOCALHOST bypass. Rationale: the localhost allowance
 * exists for legitimate local-dev capture (operator points capture at their own
 * sandbox). But a redirect FROM a public URL TO localhost, or a public page
 * embedding a localhost subresource, is an SSRF vector — the operator did not
 * intend to capture their local service. So per-hop/per-request checks reject
 * ALL private addresses including localhost, regardless of the original target.
 */
export async function assertSafeNavigationTarget(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // Allow data:/blob: subresources (inline images, fonts) — they don't make
    // network requests and can't be an SSRF vector. They pass without DNS check.
    if (parsed.protocol === "data:" || parsed.protocol === "blob:") return;
    throw new Error("Only http and https URLs can be captured");
  }
  if (METADATA_HOSTNAMES.test(parsed.hostname)) {
    throw new Error("Capture target resolves to a blocked metadata or private address");
  }
  // NO EXPLICIT_LOCALHOST bypass here — see the doc comment above.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookupAll(parsed.hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve host: ${parsed.hostname}`);
  }
  const bad = addresses.map((a) => a.address).find(isPrivateAddress);
  if (bad) {
    throw new Error("Capture target resolves to a blocked metadata or private address");
  }
}

/**
 * Intercept EVERY network request the page makes (navigations, redirects,
 * subresources — images, stylesheets, scripts, iframes, XHR/fetch) and abort
 * any whose target fails SSRF policy. Closes two bypasses:
 *   1. public-URL-302-to-metadata/localhost via page.goto's redirect-following;
 *   2. a public page embedding an internal URL as a subresource (e.g.
 *      <img src="http://169.254.169.254/...">) whose response leaks into the
 *      captured screenshot or DOM.
 *
 * Every request is validated (not just main-frame navigations) because any
 * subresource response can disclose internal-service data in the screenshot or
 * via page.evaluate. Public CDNs and assets pass normally — the guard only
 * blocks private/metadata/localhost targets.
 *
 * KNOWN RESIDUAL: DNS rebinding between our dns.lookup and Chromium's own
 * resolution is NOT closed here. A host that flips its A record from public to
 * 169.254.169.254 inside the TOCTOU window could still slip through; closing
 * that requires pinning the resolved IP at the socket layer, which is out of
 * scope for this task. Documented for the next hardening pass.
 */
export async function installSsrfGuard(
  page: import("playwright").Page,
  allowedLocalOrigin?: string,
): Promise<void> {
  // Normalize the allowed local origin once: when the operator's initial
  // capture target was localhost (permitted by assertSafeCaptureTarget), pass
  // its exact origin here so the guard can let the initial page.goto and its
  // same-origin subresources through. A redirect to a DIFFERENT localhost port,
  // a different private IP, or metadata is still rejected — the origin match
  // is exact (scheme+host+port), so http://localhost:3001 ≠ http://localhost:3000.
  const allowed = allowedLocalOrigin ?? null;
  await page.route("**/*", async (route) => {
    const req = route.request();
    try {
      const target = req.url();
      // Permit the exact approved local origin (local-dev capture workflow).
      // This lets the initial page.goto(localhost) and its same-origin assets
      // load, without opening the door to other private targets.
      if (allowed) {
        try {
          if (new URL(target).origin === allowed) return route.continue();
        } catch { /* not a parseable URL — fall through to the full check */ }
      }
      await assertSafeNavigationTarget(target);
      return route.continue();
    } catch {
      // Abort as blockedbyclient so the caller sees a clear failure rather than
      // a silent fetch of an internal target.
      return route.abort("blockedbyclient");
    }
  });
}
