/**
 * Shared private-corpus marker policy for C3 proposal and artifact contracts.
 * This is the single list used by candidate, envelope, transport, and retained
 * model-record checks; adding a marker here changes every boundary together.
 */
export const PRIVATE_MARKERS: readonly string[] = [
  "private-corpus-id",
  ".c2-private/",
  "/corpus/private/",
  "corpus/images-private/",
  "images-private/",
];

const PRIVATE_PATH_RE = /\.c2-private\/|\/corpus\/private\/|corpus\/images-private\//;

/**
 * True when a string carries any C3 private-corpus marker or private path form.
 * This policy is intentionally distinct from broader URL/path rejection used
 * for operator-safe error messages.
 */
export function containsPrivateMarker(value: string): boolean {
  for (const marker of PRIVATE_MARKERS) {
    if (value.includes(marker)) return true;
  }
  return PRIVATE_PATH_RE.test(value);
}
