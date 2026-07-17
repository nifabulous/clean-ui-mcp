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
 * Per-hop navigation check. Same policy as assertSafeCaptureTarget but returns
 * void (throw-or-pass) — the contract every caller in the navigation path needs.
 *
 * assertSafeCaptureTarget validates only the URL a capture was *initiated* with.
 * Playwright's page.goto follows server redirects (302/301/307/308) without
 * re-checking, so a public URL that 302s to http://169.254.169.254/... would
 * sail through. installSsrfGuard (below) calls this on every main-frame
 * navigation hop to close that gap.
 */
export async function assertSafeNavigationTarget(url: string): Promise<void> {
  await assertSafeCaptureTarget(url);
}

/**
 * Intercept every main-frame navigation (including server redirects) and abort
 * any hop whose target fails SSRF policy. Closes the public-URL-302-to-metadata
 * bypass that page.goto's unchecked redirect-following opened.
 *
 * The route handler runs for every request Playwright issues from the page; we
 * narrow to main-frame navigation requests only (subresource fetches, XHRs, and
 * iframe navigations are out of scope — those don't move the captured page to a
 * new origin) and re-run the same hostname/address check on each hop's URL.
 *
 * KNOWN RESIDUAL: DNS rebinding between our dns.lookup and Chromium's own
 * resolution is NOT closed here. A host that flips its A record from public to
 * 169.254.169.254 inside the TOCTOU window could still slip through; closing
 * that requires pinning the resolved IP at the socket layer, which is out of
 * scope for this task. Documented for the next hardening pass.
 */
export async function installSsrfGuard(page: import("playwright").Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const req = route.request();
    // Only main-frame navigations move the captured page; subresources and
    // child-frame navs are left to continue normally.
    if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) {
      return route.continue();
    }
    try {
      await assertSafeNavigationTarget(req.url());
      return route.continue();
    } catch {
      // Abort as blockedbyclient so the caller sees a clear failure rather than
      // a silent redirect to an internal target.
      return route.abort("blockedbyclient");
    }
  });
}
