<!-- SPDX-License-Identifier: MIT -->
<!-- © Emil Kowalski. Derived from https://github.com/emilkowalski/skills (MIT License) -->
<!-- See THIRD_PARTY_LICENSES.md for details. -->

# Design Engineering — Emil Kowalski's UI Polish Philosophy

> Vendored from [emilkowalski/skills](https://github.com/emilkowalski/skills) (`emil-design-eng`).
> Applied as reference material when synthesizing design briefs and critiques —
> NOT asserted into stored corpus entries (the corpus is static screenshots;
> motion principles are editorial guidance for the agent, not observed facts).

This skill encodes Emil Kowalski's philosophy on UI polish, component design,
animation decisions, and the invisible details that make software feel great.

---

## Core Philosophy

### Taste is trained, not innate

Good taste is not personal preference. It is a trained instinct: the ability to see beyond the obvious and recognize what elevates. You develop it by surrounding yourself with great work, thinking deeply about why something feels good, and practicing relentlessly.

When building UI, don't just make it work. Study why the best interfaces feel the way they do. Reverse engineer animations. Inspect interactions. Be curious.

### Unseen details compound

Most details users never consciously notice. That is the point. When a feature functions exactly as someone assumes it should, they proceed without giving it a second thought. That is the goal.

> "All those unseen details combine to produce something that's just stunning, like a thousand barely audible voices all singing in tune." — Paul Graham

Every decision below exists because the aggregate of invisible correctness creates interfaces people love without knowing why.

### Beauty is leverage

People select tools based on the overall experience, not just functionality. Good defaults and good animations are real differentiators. Beauty is underutilized in software. Use it as leverage to stand out.

---

## The Animation Decision Framework

Before writing any animation code, answer these questions in order:

### 1. Should this animate at all?

| Frequency | Decision |
|---|---|
| 100+ times/day (keyboard shortcuts, command palette toggle) | No animation. Ever. |
| Tens of times/day (hover effects, list navigation) | Remove or drastically reduce |
| Occasional (modals, drawers, toasts) | Standard animation |
| Rare/first-time (onboarding, feedback forms, celebrations) | Can add delight |

**Never animate keyboard-initiated actions.** These actions are repeated hundreds of times daily. Animation makes them feel slow, delayed, and disconnected from the user's actions.

### 2. What is the purpose?

Valid purposes: spatial consistency, state indication, explanation, feedback, preventing jarring changes. If the purpose is just "it looks cool" and the user will see it often, don't animate.

### 3. What easing should it use?

- Entering → ease-out (starts fast, feels responsive)
- Moving/morphing on screen → ease-in-out
- Hover/color change → ease
- Constant motion → linear
- Default → ease-out

**Never use ease-in for UI animations.** It starts slow, making the interface feel sluggish.

Custom easing curves:
```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
```

### 4. How fast should it be?

| Element | Duration |
|---|---|
| Button press feedback | 100–160ms |
| Tooltips, small popovers | 125–200ms |
| Dropdowns, selects | 150–250ms |
| Modals, drawers | 200–500ms |

**Rule: UI animations should stay under 300ms.**

---

## Component Building Principles

### Buttons must feel responsive
Add `transform: scale(0.97)` on `:active`. Subtle, instant feedback.

### Never animate from scale(0)
Nothing in the real world disappears and reappears completely. Start from `scale(0.9)` or higher, combined with opacity.

### Make popovers origin-aware
Popovers should scale from their trigger, not from center. Exception: modals stay centered.

### Tooltips: skip delay on subsequent hovers
Once one tooltip is open, adjacent tooltips should appear instantly with no animation.

### Use CSS transitions over keyframes for interruptible UI
Transitions can be retargeted mid-animation. Keyframes restart from zero.

### Use blur to mask imperfect transitions
When a crossfade feels off, add subtle `filter: blur(2px)` during the transition. Blur bridges the visual gap.

---

## CSS Transform Mastery

- `translateY(100%)` moves by element's own height — prefer over hardcoded px
- `scale()` scales children proportionally
- `transform-origin` should match the trigger location for origin-aware interactions
- 3D transforms (`rotateX/Y` with `preserve-3d`) create real depth without JS

---

## clip-path for Animation

`clip-path: inset(top right bottom left)` is one of the most powerful animation tools in CSS:
- Tabs with perfect color transitions (duplicate tab list, clip the copy)
- Hold-to-delete pattern (animate inset over 2s on `:active`)
- Image reveals on scroll (`inset(0 0 100% 0)` → `inset(0 0 0 0)`)
- Comparison sliders (adjust inset based on drag position)

---

## Gesture and Drag Interactions

- Momentum-based dismissal: calculate velocity, dismiss on flick regardless of distance
- Damping at boundaries: things in real life slow down, they don't hit walls
- Pointer capture for drag
- Multi-touch protection: ignore additional touch points after drag begins
- Friction instead of hard stops

---

## Performance Rules

- **Only animate transform and opacity** — these skip layout and paint (GPU)
- CSS variables are inheritable — changing `--x` on a parent recalculates all children
- Framer Motion `x`/`y` shorthand drops frames under load — use full `transform` string
- CSS animations beat JS under load (run off main thread)
- Use WAAPI for programmatic CSS animations (hardware-accelerated, interruptible)

---

## Accessibility

- `prefers-reduced-motion`: fewer and gentler animations, not zero. Keep opacity/color transitions that aid comprehension. Remove movement.
- Touch device hover states: gate behind `@media (hover: hover) and (pointer: fine)`

---

## Stagger Animations

Each element enters with a small delay after the previous one. Keep delays short (30–80ms). Stagger is decorative — never block interaction.

---

## Review Checklist

| Issue | Fix |
|---|---|
| `transition: all` | Specify exact properties |
| `scale(0)` entry | Start from `scale(0.95)` with `opacity: 0` |
| `ease-in` on UI | Switch to `ease-out` or custom curve |
| `transform-origin: center` on popover | Set to trigger location |
| Animation on keyboard action | Remove entirely |
| Duration > 300ms on UI | Reduce to 150–250ms |
| Hover animation without media query | Add `@media (hover: hover)` |
| Keyframes on rapidly-triggered element | Use transitions |
| Framer Motion `x`/`y` under load | Use `transform: "translateX()"` |
| Same enter/exit speed | Make exit faster |
| Elements all appear at once | Add 30–80ms stagger |
