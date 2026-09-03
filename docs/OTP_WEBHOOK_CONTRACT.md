# OTP Webhook Contract

Production OTP delivery uses the provider abstraction in `server/utils/otpDelivery.js`.
Authentication routes call only `deliverOtp(...)`; vendor-specific delivery lives in provider adapters.

## Production Environment

- `OTP_DELIVERY_PROVIDER=webhook`
- `OTP_DELIVERY_WEBHOOK_URL=https://your-provider.example/otp`
- `OTP_DELIVERY_WEBHOOK_TOKEN` optional bearer token
- `OTP_DELIVERY_TIMEOUT_MS=5000`
- `OTP_DELIVERY_RETRY_ATTEMPTS=1`
- `OTP_DELIVERY_RETRY_DELAY_MS=250`

`OTP_MOCK_STORE_PATH` is for automated local tests only and is rejected in production.

## Request

- Method: `POST`
- Endpoint: the exact `OTP_DELIVERY_WEBHOOK_URL`
- Headers:
  - `Content-Type: application/json`
  - `Authorization: Bearer <OTP_DELIVERY_WEBHOOK_TOKEN>` when configured
  - `Idempotency-Key: <otpSession>` when available
- Body:

```json
{
  "destinationPhone": "+919876543210",
  "code": "123456",
  "purpose": "signup",
  "expiresAt": "2026-08-20T11:30:00.000Z"
}
```

The request contains only delivery data. The OTP is never logged, returned to the browser, or placed in query strings.

## Response

Any HTTP `2xx` response is success. The response body is ignored.

## Timeout And Retry

Each attempt is bounded by `OTP_DELIVERY_TIMEOUT_MS`.
Retries are opt-in through `OTP_DELIVERY_RETRY_ATTEMPTS` and apply only to transient failures:

- network failure
- timeout
- `429`
- `5xx`

The provider does not retry non-transient responses such as `400`, `401`, or `403`.

## Error Handling

Authentication routes delete the server-side OTP challenge when delivery fails and return a generic safe error. Raw OTP values and webhook URLs/tokens are not exposed to the frontend.
