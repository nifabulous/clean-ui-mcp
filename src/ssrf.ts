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
