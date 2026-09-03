# FitLook Production Audit

Date: 2026-08-05

## Current Architecture

FitLook currently has four main surfaces:

- Customer storefront: root Vite + React app in `src/`, mounted by `src/main.jsx` and implemented mostly in `src/App.jsx`.
- API backend: Express + Mongoose app in `server/`, started by `server/index.js`.
- Admin console: separate Vite + React app in `admin/`.
- Prototype web app: separate Next.js + Tailwind app in `web/`. This appears to be a design/prototype surface, not the active production customer app.

Root app versions from `package.json`:

- React: `^19.0.0`
- React DOM: `^19.0.0`
- Vite: `^6.0.7`
- Backend: Express `^4.19.2`, Mongoose `^8.9.5`

The customer app is plain JavaScript, not TypeScript. The Next prototype under `web/` is TypeScript and has its own `typecheck` script.

## Routing Structure

The production customer app uses manual browser-history routing in `src/App.jsx`, not React Router. The route is derived from `window.location.pathname`, updated through `pushState`, and re-rendered on `popstate`.

Primary customer routes:

- `/`: opening page.
- `/home`: main shopping home.
- `/categories`: category landing page.
- `/categories/:slug`: department/product category page.
- `/search`: product listing/search page.
- `/product/:id`: product detail page.
- `/try-on` and `/custom-try-on`: custom AI try-on upload flow.
- `/closet`: wardrobe workspace.
- `/closet/add`: closet item upload.
- `/closet/combo`: outfit combo builder.
- `/closet/items`: wardrobe item library.
- `/wishlist`: wishlist.
- `/style-bot`: AI stylist/concierge.
- `/tokens`: credit purchase page.
- `/profile`: profile and body photo page.
- `/signup`: signup.
- `/login`: login.
- Static information pages via `pageMeta`.

Risk: route logic, auth redirects, layout shell selection, footer visibility, floating actions, onboarding, and route transitions all live in the same root component. Small route changes can affect unrelated pages.

## Global Layout Components

Production app global layout is implemented in `App()`:

- `Header`
- `Footer`
- `FloatingStylistLauncher`
- `Toast`
- `OnboardingOverview`
- route page wrapper `#main-content`
- offline network status banner

Header includes:

- desktop navigation
- desktop search
- mobile hamburger menu
- mobile menu search
- mobile bottom navigation
- credits link
- profile/account link
- logout

## Styling Approach

Production customer app uses regular global CSS in `src/styles.css`. There are no CSS modules, styled-components, Tailwind classes, or production component-library primitives in the root app.

Admin app uses its own global CSS in `admin/src/styles.css`.

The Next prototype uses Tailwind in `web/app/globals.css` and Tailwind config, but it is not the active production customer app.

## Existing Design Tokens

The root app has CSS variables in `:root`, including:

- color tokens: `--ink`, `--ink-soft`, `--muted`, `--line`, `--cream`, `--warm`, `--blush`, `--card`
- glass tokens: `--glass`, `--glass-light`, `--glass-line`
- radius tokens: `--radius-xs`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill`
- shadow tokens: `--shadow-sm`, `--shadow-md`, `--shadow-glass`
- layout tokens: `--container`, `--gutter`
- spacing tokens: `--space-1` through `--space-12`
- font tokens: `--font-display`, `--font-interface`, `--font-sans`
- typography tokens: display, heading, body, caption, navigation, button, product title/price, form label

Issue: the token system exists, but many page-level styles still use one-off values and repeated overrides, especially near the bottom of `src/styles.css`.

## Page Inventory

Customer pages in `src/App.jsx`:

- `OpeningPage`
- `AtelierHome`
- `CategoriesPage`
- `CategoryDepartmentPage`
- `SearchPage`
- `ProductPage`
- `ClosetPage`
- `ClosetAddPage`
- `ClosetComboPage`
- `ClosetItemsPage`
- `WishlistPage`
- `CustomTryOnPage`
- `StyleBotPage`
- `TokenPage`
- `ProfilePage`
- `AuthPage`
- `HowItWorks`
- `InfoPage`

Admin pages are implemented inside `admin/src/AdminApp.jsx`.

Prototype pages under `web/app`:

- `/`
- `/explore`

## Component Inventory

Reusable or semi-reusable customer components:

- `Header`
- `Footer`
- `OptimizedImage`
- `ShaderBackground`
- `ProductCard`
- `WishlistHeartButton`
- `ProductSkeletonGrid`
- `ProductDetailSkeleton`
- `EmptyProducts`
- `Toast`
- `FloatingStylistLauncher`
- `OnboardingOverview`
- product rails and category rails inside `AtelierHome` and `CategoriesPage`
- wardrobe model/stage helpers
- shared icon functions inside `App.jsx`

Modal/drawer/toast/forms:

- Toast exists as `Toast`.
- Mobile navigation is implemented as a custom dialog-like drawer.
- Onboarding is implemented as a custom dialog.
- There is no centralized Modal, Drawer, FormField, Select, Button, or Toast system.
- Forms are mostly hand-written per page.

Risk: component reuse is limited because many page components and controls are embedded in a single large `App.jsx`.

## API Inventory

The customer frontend uses a local `api(path, options)` wrapper in `src/App.jsx`. It:

- prefixes requests with `/api`
- reads `fitlook_token` from `localStorage`
- adds bearer auth when present
- supports timeouts and retry for GET requests
- normalizes server error messages
- uses longer timeouts for AI image and video generation

Backend routes:

- `GET /api/health`
- `/api/auth`
  - signup OTP request/verify
  - signup
  - legacy email/username/password login
  - login OTP request/verify
  - admin login
  - admin user/token operations
  - current user profile
  - onboarding state
  - wishlist sync
  - body photo upload
- `/api/products`
  - list with q/tag/category/brand/gender/featured/newArrival/sort/limit
  - product detail
  - Amazon search for authenticated style bot
  - admin product CRUD
  - admin preview link
  - admin recategorize
- `/api/tryons`
  - saved try-ons
  - custom garment try-on upload/generation
  - external try-on
  - product try-on image
  - product video generation
- `/api/closet`
  - closet items
  - closet image upload/analysis
  - closet outfit generation
  - outfit suggestions/chat
- `/api/images`
  - subject isolation for saved uploads
- `/api/recommendations`
  - user events
  - for-you and similar recommendations
  - admin stats
- `/api/payments`
  - PhonePe plan/order/status/callback flow

## Authentication Flow

Frontend:

- First-time access routes to signup.
- Signup is a two-step flow: phone + OTP, then name/style preference/body photo.
- Login is phone + OTP.
- Token is stored as `fitlook_token` in `localStorage`.
- Current user is loaded with `/api/auth/me`.

Backend:

- OTP session maps are in memory for signup and login.
- Login OTP endpoints are present and return JWT.
- Signup OTP endpoints are present.
- Final `/api/auth/signup` still requires `name`, `email`, `password`, `username`, `genderPreference`, and `bodyPhoto`. The frontend currently fabricates email/password/username before posting.
- Legacy `/api/auth/login` still accepts email/username and password.

Risk: OTP state is memory-only, so OTP sessions are lost on server restart or multi-instance deployment. The final signup contract does not yet match the product decision to use mobile + OTP as the real identity field.

## Product API Integration

Product list and detail data come from MongoDB through `/api/products`. The frontend has hooks:

- `useProducts`
- `useProduct`
- `useRecommendedProducts`
- `useSimilarProducts`
- `useWishlistProducts`

Product list caching exists both on the frontend and backend:

- frontend in-memory cache with a 30 second TTL
- backend product list/detail cache

Admin can create and update products. Product images can be local uploads or remote URLs.

## Cart And Wishlist State

Wishlist:

- Anonymous/local wishlist is stored in `localStorage`.
- Authenticated wishlist syncs with `/api/auth/wishlist`.
- Product snapshots are stored locally for rendering offline-ish wishlist cards.
- Wishlist heart buttons are integrated across cards and product pages.

Cart:

- No cart model, cart route, or cart UI was found in the active production app.
- Payments are token/credit purchase oriented, not product checkout/cart oriented.

Risk: product-shopping requirements mention cart and purchase, but implementation currently supports affiliate shop links and token purchases rather than a first-party cart checkout.

## AI Try-On API Flow

Product try-on:

- Product pages and product cards call `/api/tryons/product`.
- Product video generation calls `/api/tryons/product-video`.
- AI generation uses longer frontend timeouts and custom animated loading states.
- Results can be cached locally in component state.

Custom try-on:

- User uploads a garment image.
- Frontend submits FormData to try-on endpoints.
- Backend stores upload/output files under `uploads/`.

Wardrobe try-on:

- Closet items are uploaded/analyzed through `/api/closet`.
- Outfit generation uses `/api/closet/outfits/generate`.
- Background/subject isolation utilities are used for model preview and outfit rendering.

Backend providers:

- FAL models for profile and try-on image/video.
- FitRoom for virtual try-on in several flows.
- Optional OpenAI stylist model for closet suggestions.
- PhonePe for credits.

Risk: AI provider behavior, polling, uploaded files, and credit deduction are tightly connected. Avoid changing endpoint names, payload shape, upload field names, or timeout behavior casually.

## Image Upload And Storage Flow

Uploads use `multer` and write under `uploads/`.

Supported profile image inputs:

- standard image types
- AVIF
- HEIC/HEIF conversion to JPEG

Profile photo flow:

- uploaded photo is stored
- optional full-body profile generation runs in the background
- user `bodyPhoto.status` tracks generating/ready/failed

Product/admin uploads also use local file storage.

Risk: local uploads on an AWS instance are not durable across instance replacement unless backed by persistent volume or object storage. This is production-critical for generated try-ons, profile photos, closet items, and product images.

## Wardrobe Or Saved-Look Flow

Wardrobe features:

- closet item upload
- category buckets: tops, bottoms, outerwear, shoes, accessories
- model/body photo preview
- accessory quick controls
- outfit generation
- saved closet outfits
- recommendations by occasion

Saved looks:

- try-on models exist for product/custom/external try-ons
- closet outfit model exists
- wishlist exists separately

Current UX risk: wardrobe is one of the most visually fragile pages because it combines side panels, model stage, action overlays, recommendations, generated images, and responsive controls.

## Checkout And Payment Flow

Current payment flow is token/credit purchase:

- `TokenPage` shows credit packs and subscription-like plans.
- Backend uses PhonePe order creation, status polling, callback, and token crediting.
- User model stores `tokens` and subscription fields.

No first-party product checkout/cart was found.

## Error Handling

Frontend:

- API wrapper normalizes JSON error messages.
- Offline banner exists.
- Product and wishlist pages show error panels with retry in several places.
- AI timeouts have friendlier long-running messages.
- Toasts are available through a custom event.

Backend:

- Express error middleware normalizes upload errors and general errors.
- Some routes catch provider errors and return 400 with readable messages.

Issues:

- Error presentation is inconsistent across pages.
- Some debug/provider messages can surface too much internal wording to users.
- Console logging exists in image/background-removal routes and debug paths.

## Loading-State Handling

Existing loading patterns:

- product skeleton grids
- product detail skeleton
- AI rendering animation through `ShaderBackground`
- button-level loading text
- page-level loading/error states in hooks

Issues:

- Loading states are implemented per page rather than through a shared skeleton/loading component system.
- AI animation timing is complex and can drift from backend completion state.

## Empty-State Handling

Existing empty states:

- empty products
- empty wishlist
- empty collections
- empty closet item categories
- empty recommendation cards
- empty AI stylist session

Issue: empty-state copy and layout differ heavily across pages.

## Responsive Breakpoints

Breakpoints are regular CSS media queries across `src/styles.css`. Common values include:

- 1220px
- 1180px
- 1120px
- 1080px
- 980px
- 920px
- 900px
- 820px
- 760px
- 720px
- 700px
- 680px
- 640px
- 620px
- 560px
- 520px
- 460px
- 380px

Issue: many breakpoints are repeated in different CSS sections. This makes mobile behavior hard to reason about and has already caused inconsistent layouts between local and deployed builds.

## Identified UX Problems

- Product listing filters are not yet unified into one marketplace-grade pattern across category, department, and search pages.
- Mobile header has improved search/menu controls, but dense pages still need dedicated mobile-first layouts.
- Wardrobe page remains high-risk because controls, stage, and side panels compete for space.
- Category icon rails need a consistent horizontal-scroll pattern on mobile and desktop.
- Large editorial typography can become too large on product/detail pages if not constrained.
- Some CTA states rely on text-only loading and disabled colors that can look low-contrast.
- Floating AI stylist can overlap important mobile controls on dense pages.
- Auth flow has phone OTP UI but backend still has legacy signup requirements hidden behind fabricated fields.

## Responsive Issues

- Mobile pages can still rely on desktop content order in some flows.
- Several sections use large fixed visual blocks that need per-page mobile constraints.
- `src/styles.css` contains many late override blocks, increasing risk of deployed CSS order issues.
- Wardrobe, custom try-on, category, and search pages need the most mobile QA.
- Horizontal overflow protections exist on `html` and `body`, but individual sections can still create practical overflow with fixed-width content.

## Accessibility Issues

Positive:

- Header navigation has labels.
- Search inputs have accessible labels.
- Wishlist hearts use `aria-label` and `aria-pressed`.
- Mobile menu has dialog semantics.
- Skip link exists.
- Many generated image placeholders have alt text.

Issues:

- Many icon components are inline SVG without explicit `aria-hidden`.
- Mobile custom dialog focus trapping is not clearly implemented.
- Some image `alt=""` values are acceptable for decoration, but some category/audience visuals may need meaningful alt text depending on context.
- Some form fields rely on placeholder or compact visual labels in dense layouts.
- Some buttons use symbolic text such as arrows or x that should consistently have screen-reader labels.
- Reduced-motion support exists in parts of the CSS, but animation-heavy AI states need a full reduced-motion fallback review.

## SEO Issues

- Root Vite app has static `index.html` metadata only.
- Manual client-side routing means product/category pages do not get server-rendered titles, descriptions, Open Graph tags, canonical URLs, or structured data.
- Product detail pages do not appear to update document metadata per product.
- The Next prototype has basic metadata, but it is not the active production app.

Production recommendation: add route-aware metadata at minimum, and consider SSR/prerendering for product/category pages if SEO is important.

## Performance Issues

- `src/App.jsx` is very large, so page-specific code is not split by route.
- `src/styles.css` is very large and contains repeated overrides.
- Product images are optimized by URL pattern where possible, but remote image reliability and dimensions vary.
- AI generation routes are long-running and can tie up user-visible flows.
- Local upload serving from Express is simple but not CDN/object-storage optimized.
- Wishlist snapshots and recent searches use `localStorage`; this is fine for small state but should stay bounded.
- Product list cache TTL is short and in-memory; multi-instance deploys will not share cache.
- Root and admin Vite builds both target a `dist/` folder. Running `admin:build` after `build` overwrites the customer storefront artifact unless deploy scripts isolate outputs.

## Duplicate Or Dead Components

- `web/` duplicates the customer experience direction in a Next/Tailwind prototype.
- `admin/` has separate versions of product/listing UI helpers.
- `src/App.jsx` contains many page-specific components and icons in one file instead of a shared component tree.
- CSS has multiple waves of header/mobile/filter/category overrides.

No safe dead-code deletion was performed in this audit phase.

## Hardcoded Or Mock-Like Data

Hardcoded UI/editorial data exists for:

- homepage hero slides
- promo/category visual assets
- audience/category visual mappings
- feature/benefit copy
- some default recommendation prompts
- mock OTP delivery is limited to server-local automation storage and is blocked in production

Backend product data is used for actual catalog cards and detail pages. Hardcoded editorial data is acceptable as presentation content, but any product/count display should continue to prefer backend facets.

## Security-Sensitive Frontend Code

- JWT is stored in `localStorage`, which is vulnerable to XSS token theft if any script injection lands.
- Admin session token is also stored in `localStorage`.
- The frontend does not expose provider secrets directly.
- `.env.example` and Terraform examples contain placeholder secret names only.
- `deploy/aws/terraform/terraform.tfvars.save` exists and should be checked carefully before commits/deploys to ensure real secrets are not present.
- OTP endpoints return only opaque session state to the browser; production must use `OTP_DELIVERY_PROVIDER=webhook` with a server-only webhook URL.

## Technical Debt

- Monolithic `src/App.jsx`.
- Monolithic global `src/styles.css` with many repeated override blocks.
- No root lint script.
- No root type-check script because active app is JS.
- Auth product decision and backend signup contract are not fully aligned.
- OTP sessions are in-memory.
- Uploaded/generated media stored locally.
- No cart implementation despite product requirement.
- No centralized design-system primitives yet.
- No consistent filter/sort component across catalog pages.
- Manual routing complicates metadata, protected-route logic, focus management, and code splitting.
- Admin build output is not isolated from the customer build output.

## Recommended Implementation Order

1. Stabilize scripts and quality gates: add lint for root app, decide whether the root app remains JS or migrates selected shared utilities to TS, and separate slow/provider tests from fast unit tests.
2. Keep auth contract aligned around phone OTP signup/login and verify the production webhook provider before launch.
3. Split `src/App.jsx` into route/page modules without changing behavior.
4. Extract design-system primitives: Button, IconButton, TextField, Select, Sheet/Dialog, Toast, ProductCard, ProductRail, FilterBar, EmptyState, Skeleton.
5. Consolidate responsive breakpoints and layout tokens.
6. Standardize catalog/filter UX across home, categories, department, and search.
7. Refactor wardrobe into desktop and mobile layout components with a stable model stage.
8. Move uploaded/generated media to durable object storage/CDN.
9. Add route-aware metadata and product/category SEO.
10. Add cart only after product purchase requirements and payment ownership are clear.

## Risky Areas Not To Change Carelessly

- `/api/tryons/*` payloads, upload field names, timeout assumptions, and credit deduction.
- `/api/closet/*` generation and background-removal flow.
- `/api/auth/signup` and `/api/auth/login/*` until backend and frontend auth contracts are aligned together.
- Product model fields exposed by `productToClient`.
- Wishlist sync keys and `localStorage` migration behavior.
- Header route logic and auth return paths.
- AWS deploy files and environment variables.
- Upload paths under `uploads/`.
- CSS late override blocks that currently patch mobile and deployed layout regressions.

## Verification Plan For This Phase

Required checks:

- lint: root app currently has no lint script.
- type-check: root app is JavaScript and currently has no type-check script.
- web type-check: available under `web/` with `npm --prefix web run typecheck`.
- web lint: available under `web/`, but `next lint` is deprecated/interactive and needs migration to ESLint CLI.
- tests: `npm test`.
- production build: `npm run build`.

No UI redesign or API change was made in this audit phase.
