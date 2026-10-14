# Shopify Requirements

This document uses current Shopify documentation checked on 2026-10-13. Official references:

- Shopify recommends the React Router app template for most new apps: https://shopify.dev/docs/api/libraries-and-templates
- Shopify CLI app scaffold tutorial: https://shopify.dev/docs/apps/build/scaffold-app
- Shopify app structure and CLI config behavior: https://shopify.dev/docs/apps/build/cli-for-apps/app-structure
- Theme app extensions: https://shopify.dev/docs/apps/build/online-store/theme-app-extensions
- Theme app extension configuration: https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
- Privacy law compliance webhooks: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
- Shopify app subscription billing guidance: https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing

## Phase 2 Foundation Requirements

- Create a Shopify Partner/developer app for Lookmefy.
- Scaffold the official React Router app template into the existing `shopify-app/` directory without deleting Phase 1 docs.
- Configure embedded Admin authentication and Shopify sessions.
- Use least-privilege scopes. Initial expected scopes: product read access, theme extension/app proxy capability as needed, billing, and webhook registration. Final scopes must be confirmed during Phase 2.
- Store sessions server-side, not in browser local storage.
- Verify Shopify OAuth callback/HMAC handling through official library/template code.
- Register uninstall and privacy/compliance webhooks.

## Storefront Requirements

- Use a Theme App Extension so merchants can place a Try-On app block on product pages without editing theme code.
- Provide merchant settings for button text, placement guidance, branding, and whether try-on is enabled per product.
- Storefront JavaScript must never include provider keys, internal API tokens, or Shopify Admin API tokens.
- Customer uploads must include explicit consent text, image type/size validation, secure temporary storage, and retention rules.
- Storefront requests should be verified through Shopify app proxy signatures or a backend-generated storefront session/token.

## Billing Requirements

- Prefer Shopify App Pricing for a public app. Use Shopify Billing API only if final pricing cannot be represented in App Pricing.
- Do not reuse Razorpay, PhonePe, or Apple consumer payment logic.
- Maintain a merchant-scoped usage ledger with idempotency keys, failed-job refunds/voids, and reconciliation against Shopify subscription state.

## Privacy and Compliance Requirements

Shopify requires privacy law compliance webhooks for apps that collect personal data. Plan for:

- `customers/data_request`
- `customers/redact`
- `shop/redact`
- App uninstall cleanup

Customer try-on photos and generated results are personal/sensitive user content. The Shopify implementation needs:

- Retention policy, default TTL, and deletion jobs.
- Shop-level data deletion path.
- Customer data deletion lookup by shop/customer identifiers when available.
- Internal audit log of deletion requests without storing deleted image content.
- Clear merchant-facing and customer-facing privacy copy.

## Manual Setup Required From Owner

- Shopify Partner account access.
- Shopify development store.
- App registration name, app URL, redirect URLs, and test credentials generated in Shopify.
- Billing plan decisions and test billing mode confirmation.
- Public privacy policy/support URLs for app review.
- A decision on whether Lookmefy Shopify results are stored in the existing Bunny zone or a separate storage zone.
- A decision on data retention period for customer uploads and generated images.

