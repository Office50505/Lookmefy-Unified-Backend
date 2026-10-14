# Implementation Roadmap

## Phase 2: Official Shopify App Foundation

Objective: Scaffold Shopify's official React Router template inside `shopify-app/` and establish install/auth/session/webhook basics.

Status: COMPLETE for the isolated development foundation. Production security readiness remains pending and separate.

Files implemented: `shopify-app/app/`, `shopify-app/package.json`, Shopify config files, Prisma session storage, merchant installation models, lifecycle/privacy webhook route modules, dashboard shell, tests.

External setup: Shopify Partner app, development store, app URL/tunnel, redirect URLs, test billing mode.

Steps: scaffold template without deleting docs; configure app; add server-side session storage; verify install/callback; register uninstall/privacy webhooks; add health checks.

Tests: OAuth install flow, HMAC rejection, session persistence, webhook signature verification.

Acceptance: app installs on dev store, embedded admin loads, sessions persist, required webhooks verify, existing Lookmefy app remains untouched.

Current verification:

- `npm test`: PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run build`: PASS
- `npx prisma validate`: PASS
- Prisma SQL and diff validation: PASS
- `npm run setup`: BLOCKED at `prisma migrate deploy` with blank `Schema engine error`
- Manual Shopify development-store install: NOT VERIFIED

Risks: scaffold overwriting docs; incorrect scopes; tunnel/app URL mismatch.

Dependencies: Shopify account setup and approved Phase 2 start.

Next phase condition: satisfied. Phase 3 development started only after the installed embedded app and session storage were verified.

## Phase 3: Product Integration

Objective: Sync Shopify products/media and allow merchant try-on configuration.

Status: PARTIAL LIVE VALIDATION. Source implementation, local validation, Shopify CLI startup, `read_products` auto-grant, real dev-store Admin GraphQL product reads, and merchant-confirmed individual enable/disable are complete. Embedded UI bulk/detail/filter/pagination/refresh validation remains pending.

Files implemented: `app/routes/app.products.tsx`, `app/routes/app.products.details.tsx`, `app/services/shopify-products.server.ts`, `app/models/product-eligibility.server.ts`, `prisma/migrations/202610130002_phase3_product_eligibility/migration.sql`, `tests/phase3-products.test.mjs`.

External setup: `read_products` scope only. Product create/update/delete webhooks are not implemented in Phase 3; live webhook behavior remains unverified and out of the current implementation surface.

Steps: fetch products via GraphQL Admin API; map product/variant/media IDs; store eligibility settings; validate product ownership before changes; search/filter/page through catalog.

Tests: scope guard, merchant-scoped Prisma eligibility isolation, authenticated route source checks, Shopify GraphQL read checks, product-write mutation absence, existing Phase 2 tests, typecheck, lint, build, Prisma validate.

Acceptance: merchant can see products and enable/disable Lookmefy try-on per product after embedded UI visual validation confirms refresh persistence, bulk operations, product details, search, filters, and pagination.

Risks: product image quality varies; variants need independent garments; API rate limits.

Dependencies: Phase 2 sessions/offline token.

Next phase condition: reliable product media mapping for storefront block.

## Phase 4: AI Try-On Storefront Widget

Objective: Build Theme App Extension product-page button/modal and backend job submission/status/results.

Files expected: `extensions/` theme app extension, app proxy/API routes, Shopify try-on job/result models, AI adapter, worker handler.

External setup: theme app extension registration, app proxy settings if used, storage decision.

Steps: add app block; upload customer photo with consent; validate product entitlement; enqueue job; poll status; show result; return to product/cart flow.

Tests: storefront rendering, mobile modal, upload validation, job lifecycle, provider failure refund, abuse/rate limit cases.

Acceptance: dev store customer can generate and view one try-on for an enabled product without exposing provider secrets.

Risks: long generation time; customer photo privacy; Shopify theme compatibility.

Dependencies: Phase 3 product config and extracted/adapterized AI service.

Next phase condition: end-to-end dev-store try-on works with test data.

## Phase 5: Merchant Dashboard

Objective: Provide merchant controls, usage visibility, generation history, branding, and product configuration.

Files expected: embedded Admin routes/components, merchant settings model, usage/history pages.

External setup: Polaris/App Bridge conventions from official template.

Steps: build product config UI; branding/settings UI; usage dashboard; generation history with deletion controls.

Tests: session auth, authorization per shop, settings persistence, responsive embedded admin views.

Acceptance: merchant can configure app behavior without code edits.

Risks: dashboard scope creep; privacy controls must be understandable.

Dependencies: Phase 4 job/result data.

Next phase condition: merchant can self-serve configuration and inspect usage.

## Phase 6: Shopify Billing and Merchant Credits

Objective: Implement Shopify App Billing and merchant-scoped usage ledger.

Files expected: billing service, subscription routes, ledger model, reconciliation jobs, dashboard billing UI.

External setup: billing plan names/prices, Shopify test charges, production pricing decision.

Steps: create/confirm subscriptions; map active subscription to entitlements; reserve/commit/refund usage; reconcile billing status.

Tests: subscription approval/cancel, usage reservation idempotency, failed generation refund, uninstall billing cleanup.

Acceptance: merchant usage is charged/limited through Shopify, not consumer payment systems.

Risks: double charging, stale subscription status, app review billing requirements.

Dependencies: Phase 5 dashboard and Phase 4 job flow.

Next phase condition: billing and usage ledger pass reconciliation tests.

## Phase 7: Security, Testing and Performance

Objective: Harden app for Shopify review and production traffic.

Files expected: security tests, load tests, retention/deletion jobs, audit docs, privacy copy.

External setup: review privacy/support URLs, monitoring targets.

Steps: threat model; verify HMAC/webhook signatures; add retention cleanup; load-test job submission/status; validate file upload controls; confirm no secrets in storefront assets.

Tests: unit, integration, webhook replay, app proxy verification, rate limits, storage deletion, performance/load.

Acceptance: no known critical security gaps; privacy workflows verified.

Risks: image abuse, expensive provider load, retention non-compliance.

Dependencies: all prior implementation phases.

Next phase condition: release candidate checklist passes.

## Phase 8: Production Launch and Shopify Review

Objective: Prepare production deployment, app listing/review, and launch operations.

Files expected: production config docs, review submission materials, runbooks, release notes.

External setup: production Shopify app, DNS/SSL, production storage/DB/Redis, monitoring, support inbox.

Steps: production deploy; app review submission; smoke tests; monitoring alerts; rollback plan; merchant onboarding docs.

Tests: production install smoke, billing test/live validation, webhook delivery, storefront result flow, uninstall cleanup.

Acceptance: Shopify app is approved or ready for approval with production runbook.

Risks: Shopify review rejection, production provider cost spikes, support readiness.

Dependencies: completed Phases 2 through 7.

Next phase condition: none. This is launch.

