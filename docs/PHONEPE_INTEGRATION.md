# PhonePe Integration

This repository uses PhonePe PG Standard Checkout v2 endpoints directly:

- Auth token: `/v1/oauth/token`
- Checkout: `/checkout/v2/pay`
- Status: `/checkout/v2/order/{merchantOrderId}/status`
- Callback validation follows the PhonePe PG v2 SDK contract: `sha256(username:password)` must match the callback authorization header.

## Environment Variables

- `PHONEPE_ENV`: `sandbox`, `preprod`, or `production`
- `PHONEPE_CLIENT_ID`: OAuth client id from PhonePe
- `PHONEPE_CLIENT_SECRET`: OAuth client secret from PhonePe
- `PHONEPE_CLIENT_VERSION`: OAuth client version from PhonePe
- `PHONEPE_CALLBACK_USERNAME`: dashboard-configured callback username
- `PHONEPE_CALLBACK_PASSWORD`: dashboard-configured callback password
- `PHONEPE_REDIRECT_URL`: optional HTTPS user redirect URL; defaults to `CLIENT_ORIGIN/tokens`
- `PHONEPE_BASE_URL`: optional PG URL override
- `PHONEPE_AUTH_URL`: optional OAuth URL override
- `PHONEPE_MERCHANT_ID`: optional reference only in the current v2 checkout implementation

Do not configure legacy salt-key/salt-index credentials for this code path unless the integration is intentionally migrated to the older API.

## Payment Rules

The browser sends only the selected `planId` and an opaque idempotency key.
The backend calculates all financial fields from `shared/pricing.js`:

- due-today amount
- recurring amount
- billing frequency
- token grant
- mandate description

The redirect URL is navigation only. Payment success is granted only after backend status reconciliation with PhonePe.

## Callback Safety

Callbacks are rejected unless the authorization header matches the configured callback username/password hash.
Accepted callbacks are still not trusted as payment proof; they only trigger backend reconciliation through PhonePe order status.

Duplicate callbacks and repeated status refreshes are idempotent because credits are granted only through `TokenOrder.creditedAt === null`.
Duplicate browser submissions are idempotent when the same `Idempotency-Key` is reused.

## External Verification

Local tests mock the callback/signature/status behavior. Real sandbox verification still requires PhonePe credentials and dashboard callback configuration.
