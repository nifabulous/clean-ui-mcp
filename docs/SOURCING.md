# Sourcing guide — read before adding entries

This corpus stores screenshots and critiques of real product UIs. That means
copyright applies, and the rules are different depending on whether something
is stored privately (just for you) or shipped in the public/open-source repo.

## The three visibility tiers (`image.visibility` in schema.ts)

### `private` — default, safest, recommended for almost everything
- Lives only in `corpus/images-private/`, which is **gitignored**.
- Never published, never redistributed.
- Use this for: anything you scraped/automated-collected, anything from
  Mobbin/Dribbble/Behance/competitor products, anything you're not 100%
  sure you have rights to redistribute.
- The metadata + critique fields are still fully public and shippable —
  you're just not shipping the raster.

### `public-thumb` — low-res thumbnail + link-out
- Small (e.g. max 480px wide) downsized image, stored in
  `corpus/images-public/`, committed to git.
- Always paired with a clear source URL and attribution.
- Closer to a fair-use posture (transformative use, doesn't substitute for
  the original, used for commentary/critique) but still not risk-free —
  this is a judgment call, not a legal guarantee.
- Only use for entries where you're comfortable defending the use if asked,
  and remove promptly if a rights-holder objects.

### `public-own` — full image, you hold the rights
- Use for: screenshots of your own products, your own original mockups
  recreating a pattern you observed elsewhere (transformative + owned),
  or screenshots of explicitly permissively-licensed open-source projects.
- The only tier where shipping a full-resolution image is uncomplicated.

## Practical workflow

1. Automated collection (script, scraper, whatever) always writes to
   `corpus/images-private/` and creates entries with `visibility: "private"`.
2. You manually review and write the `critique` / `whatToSteal` fields —
   this is the actual value-add and is unambiguously yours to publish
   regardless of image visibility.
3. Only promote an entry to `public-thumb` or `public-own` as a deliberate,
   individual decision — never in bulk, never by default.
4. If you ever get a takedown/objection for a `public-thumb` entry, pull it
   immediately and downgrade to `private`. Don't argue with it.

## Things to never do

- Never scrape and rehost from a site whose ToS explicitly forbids it
  (Mobbin's ToS is a clear example — don't mirror their archive).
- Never bulk-promote private entries to public without per-entry review.
- Never claim ownership of the underlying design in critique text — you're
  commenting on someone else's work, not claiming it.

This is operational guidance, not legal advice. If this project grows into
something with real traffic/revenue, get an actual IP lawyer to review the
sourcing model before scaling it up.
