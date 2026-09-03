# FitLook Design System

Date: 2026-08-05

## Scope

FitLook currently uses regular CSS in `src/styles.css`. The design system foundation is token-first and should be reused before adding page-specific values.

## Tokens

- Background: `--cream`, page surfaces built from `#f8f3ef` / white translucent panels.
- Foreground: `--ink`, `--ink-soft`.
- Muted text: `--muted`.
- Borders: `--line`, rgba borders for soft ecommerce surfaces.
- Primary: near-black `#211e1c`.
- Error: red error surfaces used by `.error-message`.
- Radius: `--radius-xs`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill`.
- Shadows: `--shadow-sm`, `--shadow-md`, `--shadow-glass`.
- Spacing: `--space-1` through `--space-12`, based on 4px increments.
- Fonts: `--font-display` for editorial headings and `--font-interface` for UI.

## Typography

- Display/page headings: `var(--font-display)`, tight line height, clamp-based size.
- Section headings: use existing `.text-heading-section` or page section styles.
- Card headings: `var(--font-interface)` for product cards, `var(--font-display)` only for editorial cards.
- Labels/eyebrows: uppercase, small, high letter spacing, never as the only meaningful label.
- Body: `var(--font-interface)`, 1rem default.

## Buttons

Required rules:

- Minimum tap target: 44px.
- Primary action: dark background, white text.
- Secondary action: white or transparent surface, dark text, visible border.
- Disabled: visible disabled state and `cursor: not-allowed`.
- Loading: use `aria-busy` where possible and keep width stable.
- Icon-only: must have `aria-label`.

Current reusable button classes:

- `.button`
- `.hero-cta`
- `.text-button`
- `.icon-button`
- `.apply`
- page-specific CTA classes such as `.product-editorial-tryon`

Next extraction target: create a shared `Button` component so page-specific CTA classes can share variants.

## Forms

Current patterns:

- `AuthPage` fields use visible labels.
- filter forms use visible labels and native selects.
- profile and try-on upload fields use real file inputs wrapped in styled labels.

Rules:

- Do not rely only on placeholders.
- Use `autocomplete` for phone, name, email, and address fields.
- Use inline errors near the failed field where practical.
- Use native inputs/selects unless a custom control is truly needed.
- File upload fields must show accepted file types and size guidance.

## Feedback

Current feedback components:

- `Toast`
- `ProductSkeletonGrid`
- `ProductDetailSkeleton`
- `EmptyProducts`
- `StatusPanel`
- `TryOnGenerating`
- `OnboardingOverview`
- `ErrorBoundary`

Rules:

- Use `role="status"` for passive progress.
- Use `role="alert"` for blocking errors.
- Respect `prefers-reduced-motion`.
- Every recoverable error should include one clear next action.

## Product Cards

Use the single `ProductCard` in `src/App.jsx` until it is extracted.

Requirements:

- Product image at 4:5.
- Clamp long names.
- Wishlist button must not navigate.
- Try On action remains visually prominent.
- Hide unavailable fields gracefully.
- Use Indian currency formatting from `formatMoney`.

## Navigation

Header requirements:

- Desktop: logo, nav, search, credits, wishlist, cart, profile.
- Mobile: logo, compact actions, hamburger with search.
- Bottom nav: Home, Explore, Try-On, Wardrobe, Profile.
- Try-On stays prominent.
- Safe-area padding must be preserved.

## Accessibility Rules

- Icon-only controls need names.
- Focus states must be visible.
- Dialogs should trap focus and restore focus where possible.
- Carousels/rails must support keyboard scrolling.
- Avoid fake links and dead CTAs.

## Implementation Notes

New production foundations added:

- `src/utils/analytics.js`
- `src/utils/cart.js`
- `src/utils/seo.js`
- `src/components/common/ErrorBoundary.jsx`

Avoid creating duplicate button, card, search, modal, and product-listing implementations before extracting the existing ones.
