# Lookmefy Shopify App Development

This directory contains the isolated Shopify app. Keep Shopify work inside
`shopify-app/` unless the user explicitly approves a cross-platform change.

- Use the official Shopify CLI and React Router app framework.
- Preserve Phase 1 and Phase 2 documentation under `docs/`.
- Do not connect to production Lookmefy MongoDB, Redis, payments, AI providers,
  or workers during local Shopify app work.
- Do not add storefront try-on, product sync, AI generation, or billing before
  their approved phases.
- Do not commit `.env`, `.shopify/*`, local SQLite databases, tunnels, tokens,
  or generated session artifacts.
