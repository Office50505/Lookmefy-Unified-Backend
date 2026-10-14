# Phase 1 Audit

Date: 2026-10-13

## Scope and Safety Result

This audit inspected the existing repository without changing existing application code, dependencies, environment files, databases, queues, AWS services, or deployment configuration. The new Shopify planning area is isolated under `shopify-app/`.

`shopify-app/` did not exist before Phase 1.

## Repository Overview Verified From Source

- Root project is a private ESM Node/React project named `lookmefy` in `package.json`.
- Frontend entry points are `src/main.jsx` and `src/App.jsx`, built with Vite.
- Main API server is `server/index.js`, using Express, CORS, Mongoose, JSON middleware, security headers, global rate limiting, observability, and route modules.
- Worker entry point is `scripts/worker.js`, using MongoDB plus BullMQ workers when Redis queueing is enabled.
- Admin UI exists under `admin/`.
- Android/mobile release assets and release reports exist under `fit-look-APP/` and `output/pdf/`.
- Existing instructions in `AGENTS.md` concern Android release generation only and do not apply to this Shopify Phase 1 task.

## Current API and Infrastructure

Verified source facts:

- Node.js / Express: `server/index.js` mounts `/api/auth`, `/api/closet`, `/api/orders`, `/api/payments`, `/api/products`, `/api/recommendations`, `/api/storefront`, `/api/tryons`, `/api/images`, `/api/jobs`, and `/api/admin`.
- MongoDB: `server/index.js` connects with Mongoose; models include `User`, `Product`, `TryOn`, `CustomTryOn`, `ExternalTryOn`, `CreditEvent`, `TokenOrder`, and operational/admin models.
- Redis / BullMQ: `server/utils/jobQueue.js` enables queues only when BullMQ imports, `QUEUE_ENABLED` is truthy, and `REDIS_URL` exists. `scripts/worker.js` starts `profile`, `maintenance`, `tryon`, and `payments` workers.
- Object storage: `server/utils/storage.js` supports local upload paths and Bunny Storage/CDN through `STORAGE_PROVIDER=bunny`, `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_API_KEY`, and `BUNNY_CDN_BASE_URL`.
- AWS: repository contains AWS deployment/SSM scripts and admin cost probes, but the try-on storage code audited here uses Bunny/local storage rather than S3.
- Observability: `server/index.js` exposes health/readiness and protected Prometheus metrics. Provider/infrastructure spend probes are in `server/services/providerIntegrations.js`.

## Current AI Try-On Implementation

Primary code path: `server/routes/tryons.js`

Verified endpoints:

- `GET /api/tryons` and `GET /api/tryons/history`: user-scoped history.
- `GET /api/tryons/credit-history`: credit usage history.
- `GET /api/tryons/custom/latest`: latest custom try-on.
- `GET /api/tryons/image/:scope/:id`, `/video/:scope/:id`, `/garment/:scope/:id`, and `/:tryOnId/video/media`: token-gated media serving.
- `POST /api/tryons/custom`: uploaded garment custom try-on.
- `POST /api/tryons/external`: external product try-on from source/image URLs.
- `POST /api/tryons/:productId`: catalog product try-on.
- `POST /api/tryons/:productId/video`: generated video from a try-on image.

Current providers and provider helpers:

- Pruna image/video integration is in `server/utils/prunaClient.js` and called from `server/routes/tryons.js`.
- FAL image edit, WAN image-to-image, saree virtual try-on, and Pixverse video logic are implemented inside `server/routes/tryons.js`.
- FitRoom fallback/integration logic is implemented inside `server/routes/tryons.js`.
- Provider cost estimation for FAL is in `server/services/providerIntegrations.js`; Pruna cost estimates are in `server/utils/prunaClient.js`.

Customer photograph handling:

- Product try-on requires a user profile/body photo through `ensureTryOnProfileReady` in `server/routes/tryons.js`.
- Body photo paths are stored on `User` and converted to URLs in `server/models/User.js`.
- Uploaded garments use Multer memory storage with an 8 MB limit and raster/AVIF checks in `server/routes/tryons.js`.
- Security helpers for file type and safe remote fetches are imported from `server/utils/security.js`.

Clothing image processing:

- Catalog product images are loaded by `dataUriFromProduct` / `filePartFromProduct` in `server/routes/tryons.js`.
- Custom garment uploads are normalized by `normalizeMemoryImageFile` and stored by `saveUploadFile`.
- External products are normalized by `externalProductFromBody`, then fetched with safe URL helpers.

Generation status management:

- Synchronous generation is supported directly in route handlers.
- Product try-ons can be queued through `runProductTryOnJob`, `enqueueJobAndWait`, and `/api/jobs`.
- `server/routes/jobs.js` exposes BullMQ job status but only for authenticated consumer users and user-owned job data.
- There is no verified Shopify-specific job state model or merchant-scoped job API yet.

Credit/token deductions:

- `reserveToken` and `refundToken` in `server/routes/tryons.js` mutate `User.tokens` directly for try-on generation.
- `server/services/creditLedger.js` provides a more formal credit ledger service, but the audited try-on route still uses direct token reservation/refund helpers.
- Consumer payments use Razorpay, PhonePe naming compatibility, and Apple purchase verification in `server/routes/payments.js`.
- Shopify should not reuse consumer Razorpay/PhonePe/Apple billing. Use Shopify App Billing.

Retry and error handling:

- BullMQ jobs have configured attempts and exponential backoff in `server/utils/jobQueue.js`.
- Provider polling retries exist for Pruna/FAL/FitRoom status waits in `server/routes/tryons.js` and `server/utils/prunaClient.js`.
- On generation failure, token refunds are attempted in route/job code.
- Human-readable provider error normalization exists in `readableError` and `readableVideoError`.

Generation history:

- Product try-on records: `server/models/TryOn.js`, unique by user/product.
- Custom upload records: `server/models/CustomTryOn.js`.
- External product records: `server/models/ExternalTryOn.js`, unique by user/source URL.
- Credit history combines payment orders, try-ons, custom try-ons, and closet outfits in `server/routes/payments.js` and `server/routes/tryons.js`.

Authentication and authorization:

- Consumer routes use `requireUser` from `server/routes/auth.js`.
- Admin routes use `requireAdmin` and section-level permissions.
- Media access uses signed media tokens in `server/routes/tryons.js`.
- There is no verified Shopify OAuth/session model, Shopify HMAC verification, Shopify app proxy verification, or merchant/customer separation yet.

## Existing Reuse Potential

Safe candidates to reuse behind a new internal adapter:

- Provider clients and generation orchestration, after extracting route-local functions out of `server/routes/tryons.js`.
- Storage helper `server/utils/storage.js`, provided Shopify result retention and access rules are separated from consumer media URLs.
- BullMQ queue utilities `server/utils/jobQueue.js`, with Shopify-specific queue names, job IDs, and ownership data.
- Rate limiter utility `server/utils/rateLimit.js`, with merchant/app-proxy keys.
- Security helpers in `server/utils/security.js`, especially upload validation and safe outbound fetch.
- Background removal helpers in `server/utils/backgroundRemoval.js`.
- Observability and structured logging utilities.

Components that should stay isolated or be redesigned:

- Consumer `User.tokens` and consumer credit routes.
- Razorpay, PhonePe, and Apple payment flows.
- Consumer authentication/session model.
- Consumer `TryOn` unique key of user/product, because Shopify needs merchant/customer/job scoped records.
- Existing public `/uploads` URL assumptions for storefront results.

## Architecture Gaps for Shopify

- No `ShopifyMerchant`, `ShopifyShop`, `ShopifySession`, `ShopifyProduct`, `ShopifyTryOnJob`, `ShopifyUsageLedger`, or `ShopifySubscription` models exist.
- No Shopify OAuth install/callback handling exists.
- No Shopify Admin API client or secure session storage exists.
- No Shopify webhook verification exists.
- No required privacy/compliance webhooks exist.
- No Theme App Extension or storefront widget exists.
- No app proxy endpoint exists.
- No merchant-level billing/quota ledger exists.
- No Shopify product synchronization or product-media mapping exists.
- No storefront customer consent, retention, deletion, or abuse controls are implemented for Shopify traffic.

## Dirty Tree / Confidence Notes

`git status --short` produced no output before Phase 1 edits, so the working tree appeared clean. Confidence is high for source-verified facts listed above. Confidence is intentionally lower for production runtime configuration because `.env` files were not read and no live services were queried.

