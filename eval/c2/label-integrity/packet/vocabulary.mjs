// SINGLE SOURCE OF TRUTH for the labeling vocabulary.
//
// validate-reviewer-file.mjs and the sheet generator both import this, so the
// browser sheet and the validator can never disagree about what is allowed.
// VOCABULARY.md documents these same lists for humans — when you change a list
// here, update the matching fenced block in VOCABULARY.md too, and re-run the
// generator so label.html picks it up.
//
// Provenance of each list:
//   patternType / categories  — the corpus snapshot taxonomy, plus `gallery`
//                               and `interstitial` added from reviewer gap flags
//   components                — corpus taxonomy (28) enriched to 44 from the
//                               gap flags raised during the first draft pass
//   domainTags                — authored: the corpus populates this field on
//                               only 2 of the 40 entries, so it was built by
//                               identifying the product behind each screen
//   layout                    — the corpus snapshot's own `layout.form` values

export const VOCAB = {
  patternType:
    "auth calculator chat-interface checkout command-palette dashboard data-table editor-canvas empty-state forms gallery interstitial landing-page marketing-hero mobile-nav modal navigation notifications onboarding pricing profile search settings".split(" "),
  categories:
    "auth chat-interface checkout dashboard data-table editor-canvas empty-state forms landing-page marketing-hero mobile-nav navigation notifications onboarding pricing profile search settings".split(" "),
  components:
    "area-chart avatar avatar-group badge banner bar-chart bottom-nav carousel card-list chart checklist command-palette cta-button data-table donut-chart drawer empty-state feed-list filter-controls form-controls icon-button illustration kpi-card line-chart list-row media-grid metric-grid modal-dialog notification-bell pricing-card primary-button progress-bar report-list search-command search-input segmented-control sidebar-nav status-chip stepper summary-card tab-nav timeline toggle-switch top-nav".split(" "),
  domainTags:
    "ai-ml analytics banking communication crypto developer-tools ecommerce education enterprise-saas fintech healthcare hr infrastructure insurance investing marketing media payments productivity recruiting security social".split(" "),
};

/** visualFields entries that are closed lists rather than free text. */
export const VISUAL_VOCAB = {
  density: ["sparse", "moderate", "dense"],
  "color-scheme": ["light", "dark", "mixed"],
  layout: ["single-column", "two-column", "three-column", "modal-overlay"],
};

export const CRITIQUE_QUALITY = ["insufficient", "acceptable", "strong"];

export const A11Y_EVIDENCE = [
  "a11y:visible-focus",
  "a11y:skip-link",
  "a11y:contrast-control",
];

/** Guidance maxima — warnings, not hard errors. */
export const LIMITS = { categories: 4, components: 8, domainTags: 4 };

export const VISUAL_KEYS = ["density", "color-scheme", "typography", "layout"];

/** Fields a reviewer can flag as having no adequate option. */
export const GAP_FIELDS = [
  "patternType", "categories", "components", "domainTags",
  "layout", "density", "color-scheme", "critiqueQuality",
];
