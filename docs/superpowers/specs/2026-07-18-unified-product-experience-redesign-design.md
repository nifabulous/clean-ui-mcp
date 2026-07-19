# Unified Product Experience Redesign

**Date:** 2026-07-18
**Status:** Approved design
**Scope:** Public product site, Playground, and curator dashboard

## 1. Objective

Redesign clean-ui-mcp as one coherent product experience for two primary audiences:

1. AI and frontend developers evaluating, installing, and using the MCP.
2. Design and product teams exploring and applying its recommendations.

The public site and Playground are equally important to the curator dashboard. The public experience must explain and demonstrate the product; the dashboard must make the corpus operationally trustworthy and efficient to maintain.

The redesign must feel modern, clean, and product-led. It must preserve clean-ui's distinctive premise—a taste library grounded in real, critiqued interfaces—without retaining the current editorial styling by inertia.

## 2. Governing invariant

The redesign changes presentation, information architecture, and client-side interaction patterns without weakening publication safety, corpus integrity, curator persistence protections, or existing API contracts.

Public users may only access publication-approved snapshot data. Curator mutations retain the current server-side validation, same-origin restrictions, serialization, recovery behavior, and persistence safeguards.

## 3. Approved product architecture

Use a shared product system with two separately maintained applications.

### 3.1 Public React/Vite application

Reconstruct `site/` as a maintained React/Vite source application. It owns:

- Marketing homepage.
- Playground search and filtering.
- Public evidence-detail pages.
- Install guidance.
- Navigation to documentation, changelog, npm, and GitHub.
- SEO metadata, social metadata, `robots.txt`, and sitemap output.
- GitHub Pages deployment under `/clean-ui-mcp/`.

The public application is read-only. It consumes a generated publication-safe snapshot and never reads the private curator corpus or calls curator mutation endpoints.

### 3.2 Curator dashboard

Keep the curator as the existing vanilla JavaScript SPA served by `src/scripts/ui-server.ts`. Preserve its endpoint shapes, selectors required by browser tests, persistence behavior, and workflows while redesigning the shell, navigation, layouts, and feedback states.

### 3.3 Shared product system

Both applications implement the same documented contract for:

- Color and theme tokens.
- Typography.
- Spacing and layout rhythm.
- Radii, borders, and elevation.
- Focus and interaction states.
- Loading, empty, error, success, and disabled states.
- Motion and reduced-motion behavior.
- Copy terminology and content hierarchy.

The applications do not share runtime components. The public React components and curator CSS/markup remain independently deployable.

## 4. Experience journey

The cross-surface journey has three stages:

1. **Understand:** The homepage communicates the value, differentiation, evidence model, and trust signals.
2. **Experience:** The Playground lets a visitor search the corpus immediately and inspect useful evidence without installation.
3. **Adopt or operate:** Developers install the MCP; curators use the dashboard to maintain corpus quality.

The primary public conversion paths are "Try Playground" and "Install MCP." Both appear in the first viewport with the Playground action visually primary and install guidance immediately available.

## 5. Visual direction

### 5.1 Structural direction

Use a clean, neutral-first developer-product aesthetic informed by current patterns from Linear, Vercel, Resend, Stripe, Firecrawl, Cowrywise, and the Dark Design gallery. These are references for principles, not templates to reproduce.

The approved structure is:

- Strong modern sans-serif hierarchy.
- A restrained editorial italic used only for selected headline phrases.
- Generous public-site whitespace.
- Crisp borders and minimal elevation.
- Product screenshots and working UI as the primary proof.
- No decorative terminal motif overload.
- No inherited green brand accent.

### 5.2 Light mode

Light mode uses the approved warm architectural structure with a Cowrywise-inspired spatial background treatment:

- Pale cool canvas rather than plain white.
- Faint architectural linework.
- Original abstract forms based on layout regions and layered interface cards.
- Forms frame the hero but never cross critical copy or controls.
- Background geometry simplifies or disappears on narrow screens and constrained devices.

Do not reproduce Cowrywise's financial objects, specific illustrations, or composition.

### 5.3 Dark mode

Dark mode is a true neutral charcoal interface similar in restraint to the Codex application:

- Near-black neutral canvas.
- Neutral charcoal raised surfaces.
- Crisp low-contrast borders.
- High-legibility neutral text.
- No navy, violet, green, or neon tint applied to the base theme.
- Corpus screenshots supply most of the color.

Dark mode uses the gallery principle observed across Dark Design: the canvas recedes while authentic showcased work carries visual energy.

### 5.4 Theme behavior

- Default to `prefers-color-scheme` when no explicit choice exists.
- Persist an explicit theme choice in local storage.
- Apply the resolved theme before first paint to prevent a flash of the wrong theme.
- Keep layout, information hierarchy, and semantic meaning identical between themes.
- Verify semantic status colors independently in each theme.

## 6. Public-site information architecture

### 6.1 Global navigation

Global navigation includes:

- Product.
- Playground.
- Docs.
- Changelog.
- GitHub.
- Theme control.

On mobile, collapse secondary links into an accessible menu while keeping Playground and install entry points discoverable.

### 6.2 Homepage

The homepage uses the approved proof-led hybrid structure.

First viewport:

- A concise promise explaining that clean-ui gives AI agents design judgment grounded in real interfaces.
- A short supporting explanation.
- Primary "Try Playground" action.
- Secondary "Install MCP" action.
- A real product preview using corpus search/results UI.
- Quantified proof using values derived from the published snapshot or verified project metadata.

Subsequent sections each communicate one message:

1. Why screenshot galleries are insufficient.
2. The evidence model: decision, evidence, steal, avoid, and provenance.
3. How clean-ui connects to an agent.
4. Representative use cases for AI/frontend developers and design/product teams.
5. Open-source and reliability proof.
6. FAQ.
7. Final Playground/install call to action.

Do not present unverified adoption claims, fabricated customer logos, or metrics not derived from repository/publication data.

### 6.3 Playground

The Playground is a first-class product surface, not a secondary gallery.

It provides:

- Prompt-led corpus search.
- Category, style, domain, and platform filters.
- Canonical query parameters so searches can be shared and restored.
- Responsive result cards with authentic screenshots.
- A concise decision or critique summary on each card.
- Visible pattern, platform, and quality metadata.
- Progressive disclosure for dense critique content.
- Actions to open evidence detail, copy an agent-ready prompt, or install the MCP.

The initial scan must not render full critique paragraphs. Detailed reasoning appears only when the user opens a result.

### 6.4 Evidence detail

Evidence detail provides:

- A large authentic screenshot with intrinsic dimensions.
- Product, source, platform, capture date, and publication provenance.
- Structured decision, evidence, steal, avoid, and accessibility content.
- Categories, styles, domains, components, and quality tier.
- Copyable agent-ready context.
- Clear navigation back to the preserved search result state.

## 7. Curator dashboard information architecture

The curator application must read unmistakably as a dashboard product.

### 7.1 Persistent application shell

The shell provides:

- Workspace identity.
- Persistent sidebar.
- Dashboard title/breadcrumb context.
- Global search or command access.
- Quick add-entry action.
- Theme control.
- System-health access.

Navigation modules:

- **Dashboard**
- **Library:** Entries, Search, Compare.
- **Curation:** Add entry, Capture triage, Review queue, Bulk import.
- **Insights:** Analytics, Sources, Decision Lab.
- **System:** Health and settings.

Routes may continue to use the existing hash router. The redesign does not require a router migration.

### 7.2 Dashboard home

Dashboard is the default curator-application home and corpus control center. It displays:

- Overall system and corpus health.
- Entry count.
- Average quality and exceptional/cautionary distribution.
- Image and embedding coverage.
- Items requiring review.
- Corpus growth and quality trends using available aggregation data.
- Work queues for drafts, duplicates, failed tags, and missing images.
- Recent curator activity when the underlying data is available.
- Coverage gaps derived from corpus distributions.

Every metric or summary card links to a focused module and carries the relevant filter into that destination. Do not invent analytics or activity data that the server cannot supply; omit or replace unavailable widgets with a defined empty state.

### 7.3 Library and inspection

- Entries support gallery and list modes.
- Filters remain visible and preserve their state.
- Selecting an entry opens an accessible master-detail surface without losing results or scroll position.
- Detail exposes critique, provenance, tags, assets, and permitted actions.
- Search, Compare, and Query tools retain their existing functional contracts.

### 7.4 Curation workflows

Preserve Add entry, capture, auto-fill, review, bulk import, re-tag, duplicate handling, source management, and Decision Lab behavior.

Improve these workflows with:

- Explicit step hierarchy.
- Persistent progress and state.
- Clear primary and secondary actions.
- Inline validation tied to fields.
- Busy states for long-running provider operations.
- Recovery instructions that preserve work.
- Confirmation for destructive or irreversible actions.

### 7.5 Responsive dashboard

Desktop remains the complete curation environment. Mobile prioritizes:

- Dashboard monitoring.
- Search.
- Entry inspection.
- Lightweight review.
- Quick capture/add entry where technically safe.

Bulk editing and other high-density workflows may remain desktop-first. Mobile must explain the limitation instead of presenting broken or compressed controls.

## 8. Data flow and publication safety

### 8.1 Public data

The public build consumes a generated snapshot based on the existing publication eligibility policy. The build/export pipeline must:

- Include only publication-approved entries and public assets.
- Validate snapshot and entry schemas.
- Preserve existing integrity/hash verification.
- Produce a public asset URL mapping compatible with the Vite base path.
- Fail the build on an invalid or missing required snapshot rather than silently publishing private or malformed data.

The client parses the snapshot through a narrow adapter that exposes only fields needed by the public UI.

### 8.2 Public search

Public search is client-side over the publication-safe snapshot. A focused search module:

- Normalizes query text.
- Searches relevant product, critique, category, style, domain, component, and platform fields.
- Applies filters deterministically.
- Returns stable ordering for equal scores.
- Serializes query and filters to canonical URL parameters.

### 8.3 Dashboard data

The curator uses existing local APIs and aggregation responses. New dashboard widgets must consume verified fields from existing responses or introduce narrowly scoped read-only endpoints with explicit tests. Existing mutation endpoints and request/response shapes remain unchanged.

## 9. Resilience and feedback

Every asynchronous surface implements loading, empty, partial-data, offline, success, and error states.

### 9.1 Public surface

- Failed images render structured wireframe fallbacks and never broken-image icons.
- Failed searches preserve query and filters.
- Empty search results identify restrictive filters and offer related queries.
- One unavailable asset does not prevent other results from rendering.
- Copy actions confirm success and provide a fallback when clipboard access is unavailable.

### 9.2 Dashboard

- One failed dashboard widget does not blank the page.
- Unavailable data is visually distinct from an unhealthy corpus.
- Mutations disable duplicate submission while pending.
- Server validation is presented as actionable field or operation feedback.
- Destructive actions require confirmation and state their scope.
- Successful mutations update the relevant view or clearly offer refresh/retry.

## 10. Accessibility

WCAG 2.2 AA is the minimum quality bar.

Requirements:

- Semantic landmarks and a skip link.
- Logical heading order.
- Complete keyboard operation.
- Visible focus in both themes.
- Accessible menus, drawers, dialogs, tabs, and disclosure controls.
- Announced asynchronous search results and mutation outcomes.
- Meaningful image alternatives; decorative background geometry is hidden from assistive technology.
- Minimum 44px touch targets for primary mobile controls.
- No hover-only actions.
- Status never communicated by color alone.
- Independent contrast validation for light and dark themes.
- `prefers-reduced-motion` support.

## 11. Motion

Motion explains state and hierarchy rather than decorating scroll position.

- Use 150–250ms transitions for disclosure, drawers, filter changes, and theme-sensitive surface transitions.
- Do not use scroll-jacking, autoplay video, continuous background animation, or decorative parallax.
- Disable nonessential transitions under reduced motion.
- Avoid layout-shifting entrance animations.

## 12. Performance

Public performance budgets:

- Initial JavaScript under 150KB gzip, excluding lazily loaded Playground code.
- LCP below 2.5 seconds on a representative mobile profile.
- CLS below 0.1.
- Responsive images with intrinsic width and height.
- Route-level code splitting for Playground and evidence detail.
- No third-party runtime required for core navigation, search, theming, or content rendering.

The dashboard should avoid full-page rerenders for local widget changes and should lazy-load image-heavy content where practical within the existing vanilla architecture.

## 13. Deployment and routing

- Vite development must serve the public application at `/clean-ui-mcp/`.
- The production build must work under the same GitHub Pages base path.
- Direct navigation to `/clean-ui-mcp/`, `/clean-ui-mcp/playground`, and public evidence-detail routes must load the application and assets without 404s.
- The current state—an active Vite process with missing public source/config and a 404 at `localhost:5173/clean-ui-mcp/`—is explicitly corrected by reconstructing source and build configuration.
- The compiled `site/dist` artifact is reference material, not the maintained source of truth.

## 14. Verification strategy

### 14.1 Unit and component tests

Cover:

- Theme resolution and persistence.
- Query/filter serialization and restoration.
- Public snapshot parsing.
- Search normalization, ranking, filtering, and stable ordering.
- Loading, empty, partial, and error-state mapping.
- Navigation, menus, drawers, disclosures, and copy actions.
- Dashboard aggregation adapters.

### 14.2 End-to-end journeys

Cover:

1. Homepage to Playground to filtered results to evidence detail to copied agent prompt.
2. Homepage to install guidance to successful command copy.
3. Dashboard to review queue to entry inspection and back with filters preserved.
4. Add/capture to auto-fill to review to save.
5. Decision Lab setup to comparison to analysis report.
6. Theme selection across reloads in both applications.

### 14.3 Accessibility verification

- Automated axe checks on representative routes and states.
- Keyboard-only walkthroughs.
- Focus-order and focus-return assertions.
- Live-region/status announcement checks.
- Light/dark contrast verification.
- Reduced-motion verification.

### 14.4 Visual regression

Capture homepage, Playground, evidence detail, dashboard, entry gallery/detail, add flow, and Decision Lab at desktop, tablet, and mobile widths in light and dark modes.

### 14.5 Deployment and performance

- Build with `/clean-ui-mcp/` as the base.
- Serve the compiled artifact and test direct route navigation.
- Assert scripts, styles, snapshot data, and images return without 404s.
- Record public bundle sizes and Lighthouse thresholds in CI.
- Fail required checks when budgets regress.

## 15. Implementation boundaries

In scope:

- Reconstructing public React/Vite source from the compiled experience and approved design.
- Rebuilding public information architecture and Playground UX.
- Adding public evidence-detail routes.
- Establishing shared token and interaction specifications.
- Redesigning the curator shell and dashboard.
- Applying the shared system across existing curator modules.
- Adding accessibility, responsive, deployment, visual, and performance verification.

Out of scope:

- Replacing the MCP server protocol or tool contracts.
- Migrating the curator SPA to React.
- Replacing JSON persistence with a database.
- Adding authentication, billing, hosted user accounts, or collaborative workspaces.
- Publishing private/unapproved corpus assets.
- Changing provider selection or tagger behavior except where existing state must be represented more clearly.
- Fabricating customer logos, adoption statistics, testimonials, or analytics.

## 16. Success criteria

The redesign is successful when:

- A new visitor can explain clean-ui and choose Playground or install within 30 seconds.
- Playground returns scannable useful results without requiring setup.
- Every public recommendation is traceable to publication-safe evidence and provenance.
- The dashboard communicates corpus health, trends, and required curator work at a glance.
- Existing curator workflows and API contracts remain functional.
- Both applications provide complete keyboard paths and meet WCAG 2.2 AA.
- Light and dark modes are coherent, persistent, and flash-free.
- Direct public routes under `/clean-ui-mcp/` no longer return 404.
- Required tests, deployment checks, visual baselines, and performance budgets pass.
