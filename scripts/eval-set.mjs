/**
 * 15-image stratified eval set with gold patternType labels.
 *
 * Stratified by pattern to detect per-pattern regressions. Zero Hume/Origin
 * bias (the prior 9-image set had 5 of 9 from those two products). All image
 * paths verified present on disk.
 *
 * The `patternType` field is the GOLD LABEL — hand-verified from the existing
 * corpus entry. The eval scores the tagger's raw pre-sanitize extraction
 * against this label. This is non-circular: the sanitizer silently coerces
 * unknown patternTypes to "dashboard", masking model errors; the eval catches
 * misclassification the sanitizer can't.
 *
 * Constraints:
 * - calculator: only 1 in the entire corpus (wise-transfer-calculator)
 * - command-palette: only 2 in corpus (both used here)
 * - pricing: only 4 in corpus (2 used here)
 * - mobile: Wealthsimple + cowrywise (avoiding Alan which dominates mobile)
 */
export const EVAL_SET = [
  // dashboard (2)
  { id: "workable-workable-2", imagePath: "images-private/workable-web-screens-2.png", productName: "Workable", platform: "web", patternType: "dashboard" },
  { id: "untitled-untitled", imagePath: "images-private/aboard-web-screens-3-2.png", productName: "Aboard", platform: "web", patternType: "dashboard" },

  // pricing (2)
  { id: "arcade-arcade-web-screens-77", imagePath: "images-private/new-products-batch/Arcade Web Screens/Arcade Web Screens 77.png", productName: "Arcade", platform: "web", patternType: "pricing" },
  { id: "arcade-arcade-web-screens-78", imagePath: "images-private/new-products-batch/Arcade Web Screens/Arcade Web Screens 78.png", productName: "Arcade", platform: "web", patternType: "pricing" },

  // calculator (1 — only one in corpus)
  { id: "wise-transfer-calculator", imagePath: "images-private/wise-web-screens-14.png", productName: "Wise", platform: "web", patternType: "calculator" },

  // auth (2)
  { id: "cash-app-cash-app-7", imagePath: "images-private/cash-app-ios-nov-2025-23.png", productName: "Cash App", platform: "web", patternType: "auth" },
  { id: "wise-wise", imagePath: "images-private/wise-web-screens-4.png", productName: "Wise", platform: "web", patternType: "auth" },

  // landing-page (2)
  { id: "cowrywise-desktop", imagePath: "images-private/cowrywise-com-cowrywise-com-section-b1358425b9-desktop-2026-07-06.png", productName: "Cowrywise", platform: "web", patternType: "landing-page" },
  { id: "wealthsimple-ios-47", imagePath: "images-private/new-products-batch/Wealthsimple iOS Screens/Wealthsimple iOS Screens 47.png", productName: "Wealthsimple", platform: "mobile", patternType: "landing-page" },

  // data-table (2)
  { id: "mercury-web-43", imagePath: "images-private/new-products-batch/Mercury Web Screens/Mercury Web Screens 43.png", productName: "Mercury", platform: "web", patternType: "data-table" },
  { id: "peoplegpt-6", imagePath: "images-private/juicebox-web-screens-26.png", productName: "PeopleGPT", platform: "web", patternType: "data-table" },

  // command-palette (2 — only 2 in corpus)
  { id: "arcade-web-68", imagePath: "images-private/new-products-batch/Arcade Web Screens/Arcade Web Screens 68.png", productName: "Arcade", platform: "web", patternType: "command-palette" },
  { id: "stackai-web-37", imagePath: "images-private/new-products-batch/StackAI Web Screens/StackAI Web Screens 37.png", productName: "StackAI", platform: "web", patternType: "command-palette" },

  // mobile (2 — non-Alan for diversity)
  { id: "wealthsimple-ios-0", imagePath: "images-private/new-products-batch/Wealthsimple iOS Screens/Wealthsimple iOS Screens 0.png", productName: "Wealthsimple", platform: "mobile", patternType: "onboarding" },
  { id: "cowrywise-mobile", imagePath: "images-private/cowrywise-com-cowrywise-com-section-3744063ceb-mobile-2026-07-06.png", productName: "Cowrywise", platform: "mobile", patternType: "landing-page" },
];
