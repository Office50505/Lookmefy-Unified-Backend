# Lookmefy AI Virtual Try-On for Shopify

This directory contains the isolated Shopify embedded Admin app for Lookmefy merchants.

The app uses Shopify's official React Router app template with:

- `@shopify/shopify-app-react-router`
- Shopify CLI
- Prisma session storage
- Local SQLite for development
- App-specific lifecycle and privacy webhooks
- Server-side Shopify Admin GraphQL product reads

The existing Lookmefy consumer app, mobile apps, AI generation, consumer credits, and consumer payments are intentionally untouched.

## Current Phase

Phase 3 implements the Shopify app foundation plus real product integration:

- Embedded Shopify Admin authentication
- Server-side session storage
- Installation state tracking
- Merchant dashboard with real authenticated shop data
- App uninstall and scope-update lifecycle webhooks
- Mandatory privacy webhook endpoint
- Real Shopify product catalog loading through authenticated server-side GraphQL
- Product search, status/type filters, cursor pagination, media/variant display, and details view
- Merchant-scoped product eligibility settings persisted in SQLite through Prisma
- Individual and bulk enable/disable controls for Lookmefy try-on eligibility

Not implemented yet:

- Phase 4 storefront try-on extension and customer uploads
- Phase 5 usage analytics
- Phase 6 merchant billing
- AI generation integration

## Local Setup

From a fresh checkout:

```sh
cd shopify-app
npm install
npm run setup
```

Current local note: Prisma SQLite migrations on macOS require the Phase 2B `RUST_LOG=info` workaround that is built into `npm run setup`. See `docs/PHASE-2-IMPLEMENTATION-REPORT.md` for the validation record.

Then start the Shopify development workflow:

```sh
npm run dev
```

Shopify CLI will provide a secure development tunnel, inject local environment variables, and open/install the app in the selected development store. Select only the Lookmefy organization and the Lookmefy Try-On Dev development store.

## Useful Commands

```sh
npm run dev
npm run build
npm run typecheck
npm run lint
npm test
npm run setup
```

Do not run `npm run deploy` until a production launch phase is approved.

## Configuration

The app is configured through `shopify.app.toml` and local environment variables. Do not commit `.env`, local SQLite databases, access tokens, tunnel URLs, or generated `.shopify/` metadata.

Phase 3 requests only the `read_products` Admin API scope. Write product scopes, customer scopes, order scopes, theme scopes, billing scopes, AI provider credentials, and production Lookmefy integrations remain disabled.

## Documentation

- `docs/PHASE-1-AUDIT.md`
- `docs/ARCHITECTURE.md`
- `docs/IMPLEMENTATION-ROADMAP.md`
- `docs/REUSABLE-COMPONENTS.md`
- `docs/SHOPIFY-REQUIREMENTS.md`
- `docs/PHASE-STATUS.md`
- `docs/PHASE-2-IMPLEMENTATION-REPORT.md`
- `docs/PHASE-3-IMPLEMENTATION-REPORT.md`

