/**
 * Snapshot loader for the public client.
 *
 * The public site never imports the curator corpus directly. It fetches the
 * tracked {@link PublicSnapshot} from `${BASE_URL}snapshot.json` and runs every
 * row through the narrow adapter, which validates fields and refuses unsafe
 * image paths.
 */

import type { PublicSnapshot } from "./public-entry";
import { parsePublicSnapshot } from "./public-entry";

const BASE_URL =
  typeof import.meta !== "undefined" && import.meta.env && import.meta.env.BASE_URL
    ? import.meta.env.BASE_URL
    : "/";

function ensureTrailingSlash(prefix: string): string {
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function snapshotUrl(): string {
  return `${ensureTrailingSlash(BASE_URL)}snapshot.json`;
}

/**
 * Fetch and validate the publication-safe snapshot.
 *
 * Rejects when the network request fails (non-2xx) or when the payload fails
 * structural validation. The resolved snapshot is fully parsed — every entry
 * has a safe {@link PublicEntry.imageUrl}.
 */
export async function loadPublicSnapshot(): Promise<PublicSnapshot> {
  const url = snapshotUrl();
  const response = await fetch(url);
  if (!response || !response.ok) {
    const status = response ? response.status : "no-response";
    throw new Error(`Failed to load public snapshot from ${url} (status: ${status})`);
  }
  const payload: unknown = await response.json();
  return parsePublicSnapshot(payload as Parameters<typeof parsePublicSnapshot>[0]);
}
