# Lookmefy Endpoint Smoke Report

Generated: 2026-09-04T05:29:18.965Z
Base URL: http://localhost:5050
Endpoints requested: 140

## Result

- Check pass rate: 1
- HTTP failure rate: 0
- Failed endpoint checks: 0

## Endpoint Results

| Endpoint | Family | Expected | Seen statuses | Requests | Avg latency | p95 latency | Check pass rate |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| GET /api/health | core | 200 | 200 (1) | 1 | 0.75 ms | 0.75 ms | 1 |
| GET /api/health/live | core | 200 | 200 (1) | 1 | 0.16 ms | 0.16 ms | 1 |
| GET /api/health/ready | core | 200/503 | 503 (1) | 1 | 1002.94 ms | 1002.94 ms | 1 |
| GET /api/admin/metrics | admin | 401 | 401 (1) | 1 | 0.77 ms | 0.77 ms | 1 |
| GET /api/metrics/prometheus | core | 401/404 | 401 (1) | 1 | 1.11 ms | 1.11 ms | 1 |
| POST /api/auth/otp/send | auth | 400/429 | 429 (1) | 1 | 0.98 ms | 0.98 ms | 1 |
| POST /api/auth/otp/verify | auth | 400/429 | 400 (1) | 1 | 0.71 ms | 0.71 ms | 1 |
| POST /api/auth/signup/request-otp | auth | 400/429 | 429 (1) | 1 | 0.68 ms | 0.68 ms | 1 |
| GET /api/auth/test-otp | auth | 400/404 | 404 (1) | 1 | 1.1 ms | 1.1 ms | 1 |
| POST /api/auth/signup/verify-otp | auth | 400/429 | 400 (1) | 1 | 0.57 ms | 0.57 ms | 1 |
| POST /api/auth/signup/cancel-otp | auth | 200/400/404/429 | 200 (1) | 1 | 0.45 ms | 0.45 ms | 1 |
| POST /api/auth/signup/complete | auth | 400/401 | 401 (1) | 1 | 27.09 ms | 27.09 ms | 1 |
| POST /api/auth/signup | auth | 400/401 | 400 (1) | 1 | 25.8 ms | 25.8 ms | 1 |
| GET /api/auth/username-suggestions | auth | 200 | 200 (1) | 1 | 100.79 ms | 100.79 ms | 1 |
| POST /api/auth/login | auth | 400/401 | 400 (1) | 1 | 1.62 ms | 1.62 ms | 1 |
| POST /api/auth/login/request-otp | auth | 400/429 | 429 (1) | 1 | 1.81 ms | 1.81 ms | 1 |
| POST /api/auth/login/verify-otp | auth | 400/429 | 429 (1) | 1 | 0.93 ms | 0.93 ms | 1 |
| POST /api/auth/session/heartbeat | auth | 401 | 401 (1) | 1 | 0.75 ms | 0.75 ms | 1 |
| POST /api/auth/logout | auth | 401 | 401 (1) | 1 | 0.67 ms | 0.67 ms | 1 |
| POST /api/auth/login/cancel-otp | auth | 200/400/404/429 | 200 (1) | 1 | 0.95 ms | 0.95 ms | 1 |
| POST /api/auth/password-reset/request-otp | auth | 400/429 | 429 (1) | 1 | 1.15 ms | 1.15 ms | 1 |
| POST /api/auth/password-reset/verify-otp | auth | 400/429 | 429 (1) | 1 | 1.14 ms | 1.14 ms | 1 |
| POST /api/auth/password-reset/cancel-otp | auth | 200/400/404/429 | 200 (1) | 1 | 0.98 ms | 0.98 ms | 1 |
| POST /api/auth/password-reset | auth | 400/429 | 429 (1) | 1 | 1.55 ms | 1.55 ms | 1 |
| POST /api/auth/password/reset | auth | 400/401/429 | 401 (1) | 1 | 0.74 ms | 0.74 ms | 1 |
| POST /api/auth/admin-request-access | auth | 400 | 400 (1) | 1 | 0.66 ms | 0.66 ms | 1 |
| POST /api/auth/admin-login | auth | 400/401 | 400 (1) | 1 | 1.06 ms | 1.06 ms | 1 |
| GET /api/auth/admin-session | auth | 401 | 401 (1) | 1 | 0.65 ms | 0.65 ms | 1 |
| GET /api/auth/admin/users | auth-admin | 401 | 401 (1) | 1 | 0.6 ms | 0.6 ms | 1 |
| GET /api/auth/admin/search | auth-admin | 401 | 401 (1) | 1 | 0.61 ms | 0.61 ms | 1 |
| GET /api/auth/admin/users/000000000000000000000000/insights | auth-admin | 401 | 401 (1) | 1 | 0.46 ms | 0.46 ms | 1 |
| GET /api/auth/admin/users/000000000000000000000000/media | auth-admin | 401 | 401 (1) | 1 | 0.49 ms | 0.49 ms | 1 |
| GET /api/auth/admin/storage | auth-admin | 401 | 401 (1) | 1 | 0.32 ms | 0.32 ms | 1 |
| GET /api/auth/admin/storage/reconciliation | auth-admin | 401 | 401 (1) | 1 | 0.37 ms | 0.37 ms | 1 |
| DELETE /api/auth/admin/storage/orphans | auth-admin | 401 | 401 (1) | 1 | 0.41 ms | 0.41 ms | 1 |
| GET /api/auth/admin/operations | auth-admin | 401 | 401 (1) | 1 | 0.58 ms | 0.58 ms | 1 |
| GET /api/auth/admin/orders | auth-admin | 401 | 401 (1) | 1 | 0.42 ms | 0.42 ms | 1 |
| GET /api/auth/admin/audit-log | auth-admin | 401 | 401 (1) | 1 | 0.31 ms | 0.31 ms | 1 |
| PATCH /api/auth/admin/users/000000000000000000000000/tokens | auth-admin | 401 | 401 (1) | 1 | 0.48 ms | 0.48 ms | 1 |
| PATCH /api/auth/admin/users/000000000000000000000000/status | auth-admin | 401 | 401 (1) | 1 | 0.42 ms | 0.42 ms | 1 |
| DELETE /api/auth/admin/users/000000000000000000000000 | auth-admin | 401 | 401 (1) | 1 | 0.27 ms | 0.27 ms | 1 |
| GET /api/auth/me | auth-user | 401 | 401 (1) | 1 | 0.27 ms | 0.27 ms | 1 |
| GET /api/auth/media-token | auth-user | 401 | 401 (1) | 1 | 0.31 ms | 0.31 ms | 1 |
| GET /api/auth/media/avatar/000000000000000000000000 | auth-media | 401 | 401 (1) | 1 | 0.71 ms | 0.71 ms | 1 |
| PATCH /api/auth/profile | auth-user | 401 | 401 (1) | 1 | 0.36 ms | 0.36 ms | 1 |
| PATCH /api/auth/avatar-crop | auth-user | 401 | 401 (1) | 1 | 0.3 ms | 0.3 ms | 1 |
| DELETE /api/auth/me | auth-user | 401 | 401 (1) | 1 | 0.27 ms | 0.27 ms | 1 |
| PATCH /api/auth/onboarding | auth-user | 401 | 401 (1) | 1 | 0.32 ms | 0.32 ms | 1 |
| GET /api/auth/wishlist | auth-user | 401 | 401 (1) | 1 | 0.34 ms | 0.34 ms | 1 |
| POST /api/auth/wishlist/sync | auth-user | 401 | 401 (1) | 1 | 0.35 ms | 0.35 ms | 1 |
| PUT /api/auth/wishlist/000000000000000000000000 | auth-user | 401 | 401 (1) | 1 | 0.32 ms | 0.32 ms | 1 |
| DELETE /api/auth/wishlist/000000000000000000000000 | auth-user | 401 | 401 (1) | 1 | 0.29 ms | 0.29 ms | 1 |
| PATCH /api/auth/dev-mode | auth-user | 401 | 401 (1) | 1 | 0.33 ms | 0.33 ms | 1 |
| POST /api/auth/body-photo | auth-user | 401 | 401 (1) | 1 | 0.33 ms | 0.33 ms | 1 |
| POST /api/auth/body-photo/generate-full-body | auth-user | 401 | 401 (1) | 1 | 0.83 ms | 0.83 ms | 1 |
| GET /api/products | products | 200 | 200 (1) | 1 | 0.69 ms | 0.69 ms | 1 |
| GET /api/products/admin/catalog | products-admin | 401 | 401 (1) | 1 | 0.41 ms | 0.41 ms | 1 |
| POST /api/products/amazon-search | products-user | 401 | 401 (1) | 1 | 0.29 ms | 0.29 ms | 1 |
| POST /api/products/smart-import | products-admin | 401 | 401 (1) | 1 | 0.56 ms | 0.56 ms | 1 |
| POST /api/products/recategorize | products-admin | 401 | 401 (1) | 1 | 0.34 ms | 0.34 ms | 1 |
| GET /api/products/000000000000000000000000 | products | 404 | 404 (1) | 1 | 36.39 ms | 36.39 ms | 1 |
| POST /api/products/preview-link | products-admin | 401 | 401 (1) | 1 | 0.34 ms | 0.34 ms | 1 |
| POST /api/products | products-admin | 401 | 401 (1) | 1 | 0.51 ms | 0.51 ms | 1 |
| PATCH /api/products/admin/inventory | products-admin | 401 | 401 (1) | 1 | 0.42 ms | 0.42 ms | 1 |
| PATCH /api/products/000000000000000000000000 | products-admin | 401 | 401 (1) | 1 | 0.35 ms | 0.35 ms | 1 |
| PATCH /api/products/000000000000000000000000/garment-placement | products-admin | 401 | 401 (1) | 1 | 0.33 ms | 0.33 ms | 1 |
| PATCH /api/products/000000000000000000000000/tryon-model | products-admin | 401 | 401 (1) | 1 | 0.3 ms | 0.3 ms | 1 |
| DELETE /api/products | products-admin | 401 | 401 (1) | 1 | 0.25 ms | 0.25 ms | 1 |
| DELETE /api/products/000000000000000000000000/permanent | products-admin | 401 | 401 (1) | 1 | 0.25 ms | 0.25 ms | 1 |
| DELETE /api/products/000000000000000000000000 | products-admin | 401 | 401 (1) | 1 | 0.27 ms | 0.27 ms | 1 |
| POST /api/recommendations/events | recommendations-user | 401 | 401 (1) | 1 | 0.32 ms | 0.32 ms | 1 |
| POST /api/recommendations/events/batch | recommendations-user | 401 | 401 (1) | 1 | 0.41 ms | 0.41 ms | 1 |
| GET /api/recommendations/recent-searches | recommendations-user | 401 | 401 (1) | 1 | 0.27 ms | 0.27 ms | 1 |
| POST /api/recommendations/studio-chat | recommendations-user | 401 | 401 (1) | 1 | 0.33 ms | 0.33 ms | 1 |
| POST /api/recommendations/stylist-chat | recommendations-user | 401 | 401 (1) | 1 | 0.29 ms | 0.29 ms | 1 |
| GET /api/recommendations/admin/stats | recommendations-admin | 401 | 401 (1) | 1 | 0.29 ms | 0.29 ms | 1 |
| GET /api/recommendations/for-you | recommendations-user | 401 | 401 (1) | 1 | 0.25 ms | 0.25 ms | 1 |
| GET /api/recommendations/similar/000000000000000000000000 | recommendations | 404 | 404 (1) | 1 | 24.89 ms | 24.89 ms | 1 |
| GET /api/closet/media/item/000000000000000000000000 | closet-media | 401 | 401 (1) | 1 | 0.49 ms | 0.49 ms | 1 |
| GET /api/closet | closet-user | 401 | 401 (1) | 1 | 0.38 ms | 0.38 ms | 1 |
| POST /api/closet/items/analyze | closet-user | 401 | 401 (1) | 1 | 0.32 ms | 0.32 ms | 1 |
| POST /api/closet/items | closet-user | 401 | 401 (1) | 1 | 0.32 ms | 0.32 ms | 1 |
| PATCH /api/closet/items/000000000000000000000000 | closet-user | 401 | 401 (1) | 1 | 0.28 ms | 0.28 ms | 1 |
| DELETE /api/closet/items/000000000000000000000000 | closet-user | 401 | 401 (1) | 1 | 0.26 ms | 0.26 ms | 1 |
| POST /api/closet/suggest | closet-user | 401 | 401 (1) | 1 | 0.34 ms | 0.34 ms | 1 |
| POST /api/closet/chat | closet-user | 401 | 401 (1) | 1 | 0.24 ms | 0.24 ms | 1 |
| POST /api/closet/outfits/generate | closet-user | 401 | 401 (1) | 1 | 0.31 ms | 0.31 ms | 1 |
| PATCH /api/closet/outfits/000000000000000000000000 | closet-user | 401 | 401 (1) | 1 | 0.68 ms | 0.68 ms | 1 |
| GET /api/tryons | tryons-user | 401 | 401 (1) | 1 | 1.07 ms | 1.07 ms | 1 |
| GET /api/tryons/history | tryons-user | 401 | 401 (1) | 1 | 0.2 ms | 0.2 ms | 1 |
| GET /api/tryons/credit-history | tryons-user | 401 | 401 (1) | 1 | 0.26 ms | 0.26 ms | 1 |
| GET /api/tryons/custom/latest | tryons-user | 401 | 401 (1) | 1 | 0.28 ms | 0.28 ms | 1 |
| GET /api/tryons/image/product/000000000000000000000000 | tryons-media | 401 | 401 (1) | 1 | 0.41 ms | 0.41 ms | 1 |
| GET /api/tryons/video/product/000000000000000000000000 | tryons-media | 401 | 401 (1) | 1 | 0.46 ms | 0.46 ms | 1 |
| GET /api/tryons/garment/custom/000000000000000000000000 | tryons-media | 401 | 401 (1) | 1 | 0.39 ms | 0.39 ms | 1 |
| GET /api/tryons/000000000000000000000000/video/media | tryons-media | 401 | 401 (1) | 1 | 0.25 ms | 0.25 ms | 1 |
| POST /api/tryons/custom | tryons-user | 401 | 401 (1) | 1 | 0.29 ms | 0.29 ms | 1 |
| POST /api/tryons/external | tryons-user | 401 | 401 (1) | 1 | 0.34 ms | 0.34 ms | 1 |
| POST /api/tryons/000000000000000000000000/video | tryons-user | 401 | 401 (1) | 1 | 0.32 ms | 0.32 ms | 1 |
| POST /api/tryons/000000000000000000000000 | tryons-user | 401 | 401 (1) | 1 | 0.28 ms | 0.28 ms | 1 |
| GET /api/jobs/000000000000000000000000 | jobs-user | 401 | 401 (1) | 1 | 0.2 ms | 0.2 ms | 1 |
| GET /api/jobs/tryon/000000000000000000000000 | jobs-user | 401 | 401 (1) | 1 | 0.21 ms | 0.21 ms | 1 |
| POST /api/images/subject-isolation | images-user | 401 | 401 (1) | 1 | 0.28 ms | 0.28 ms | 1 |
| GET /api/payments/plans | payments | 200 | 200 (1) | 1 | 0.25 ms | 0.25 ms | 1 |
| GET /api/payments/credits/history | payments-user | 401 | 401 (1) | 1 | 0.17 ms | 0.17 ms | 1 |
| GET /api/payments/apple/config | payments-user | 401 | 401 (1) | 1 | 0.28 ms | 0.28 ms | 1 |
| POST /api/payments/apple/transactions | payments-user | 401 | 401 (1) | 1 | 0.21 ms | 0.21 ms | 1 |
| POST /api/payments/apple/restore | payments-user | 401 | 401 (1) | 1 | 0.23 ms | 0.23 ms | 1 |
| GET /api/payments/apple/status | payments-user | 401 | 401 (1) | 1 | 0.19 ms | 0.19 ms | 1 |
| POST /api/payments/apple/notifications | payments-public | 400 | 400 (1) | 1 | 0.24 ms | 0.24 ms | 1 |
| POST /api/payments/checkout | payments-user | 401 | 401 (1) | 1 | 0.21 ms | 0.21 ms | 1 |
| POST /api/payments/phonepe/top-up | payments-user | 401 | 401 (1) | 1 | 0.22 ms | 0.22 ms | 1 |
| POST /api/payments/phonepe/subscription | payments-user | 401 | 401 (1) | 1 | 0.21 ms | 0.21 ms | 1 |
| POST /api/payments/razorpay/verify | payments-user | 401 | 401 (1) | 1 | 0.23 ms | 0.23 ms | 1 |
| GET /api/payments/orders/load-test/status | payments-user | 401 | 401 (1) | 1 | 0.27 ms | 0.27 ms | 1 |
| GET /api/payments/subscriptions/current/status | payments-user | 401 | 401 (1) | 1 | 0.25 ms | 0.25 ms | 1 |
| POST /api/payments/subscriptions/current/cancel | payments-user | 401 | 401 (1) | 1 | 0.32 ms | 0.32 ms | 1 |
| POST /api/payments/phonepe/callback | payments-public | 401/503 | 503 (1) | 1 | 0.38 ms | 0.38 ms | 1 |
| GET /api/storefront/config | storefront | 200 | 200 (1) | 1 | 31.92 ms | 31.92 ms | 1 |
| GET /api/orders/pincode/110001 | orders-public | 200/400 | 200 (1) | 1 | 0.58 ms | 0.58 ms | 1 |
| POST /api/orders | orders-user | 401 | 401 (1) | 1 | 0.54 ms | 0.54 ms | 1 |
| GET /api/orders/000000000000000000000000 | orders-user | 401 | 401 (1) | 1 | 0.28 ms | 0.28 ms | 1 |
| POST /api/orders/000000000000000000000000/payment | orders-user | 401 | 401 (1) | 1 | 0.32 ms | 0.32 ms | 1 |
| POST /api/orders/000000000000000000000000/demo-success | orders-user | 401 | 401 (1) | 1 | 0.29 ms | 0.29 ms | 1 |
| GET /api/orders/000000000000000000000000/payment-status | orders-user | 401 | 401 (1) | 1 | 0.3 ms | 0.3 ms | 1 |
| POST /api/orders/phonepe/callback | orders-public | 401/503 | 503 (1) | 1 | 0.51 ms | 0.51 ms | 1 |
| GET /api/orders/admin/list | orders-admin | 401 | 401 (1) | 1 | 0.24 ms | 0.24 ms | 1 |
| PATCH /api/orders/admin/000000000000000000000000/status | orders-admin | 401 | 401 (1) | 1 | 0.31 ms | 0.31 ms | 1 |
| GET /api/admin/roles | admin | 401 | 401 (1) | 1 | 0.7 ms | 0.7 ms | 1 |
| PATCH /api/admin/roles/000000000000000000000000 | admin | 401 | 401 (1) | 1 | 1.43 ms | 1.43 ms | 1 |
| POST /api/admin/roles/000000000000000000000000/revoke-sessions | admin | 401 | 401 (1) | 1 | 1.12 ms | 1.12 ms | 1 |
| GET /api/admin/storefront-settings | admin | 401 | 401 (1) | 1 | 1.02 ms | 1.02 ms | 1 |
| PATCH /api/admin/storefront-settings/demo-mode | admin | 401 | 401 (1) | 1 | 1.01 ms | 1.01 ms | 1 |
| GET /api/admin/system/summary | admin | 401 | 401 (1) | 1 | 1.38 ms | 1.38 ms | 1 |
| GET /api/admin/system/incidents | admin | 401 | 401 (1) | 1 | 0.77 ms | 0.77 ms | 1 |
| PATCH /api/admin/system/incidents/000000000000000000000000 | admin | 401 | 401 (1) | 1 | 0.7 ms | 0.7 ms | 1 |
| GET /api/admin/system/generations | admin | 401 | 401 (1) | 1 | 0.66 ms | 0.66 ms | 1 |
| GET /api/admin/system/mobile/ios | admin | 401 | 401 (1) | 1 | 0.76 ms | 0.76 ms | 1 |
| GET /api/admin/costs/summary | admin | 401 | 401 (1) | 1 | 1 ms | 1 ms | 1 |
| GET /api/admin/costs/pruna | admin | 401 | 401 (1) | 1 | 0.64 ms | 0.64 ms | 1 |

## Slowest Endpoints

| Endpoint | Family | Seen statuses | p95 latency | p99 latency |
| --- | --- | --- | ---: | ---: |
| GET /api/health | core | 200 (1) | 0.75 ms | 0.75 ms |
| GET /api/health/live | core | 200 (1) | 0.16 ms | 0.16 ms |
| GET /api/health/ready | core | 503 (1) | 1002.94 ms | 1002.94 ms |
| GET /api/admin/metrics | admin | 401 (1) | 0.77 ms | 0.77 ms |
| GET /api/metrics/prometheus | core | 401 (1) | 1.11 ms | 1.11 ms |
| POST /api/auth/otp/send | auth | 429 (1) | 0.98 ms | 0.98 ms |
| POST /api/auth/otp/verify | auth | 400 (1) | 0.71 ms | 0.71 ms |
| POST /api/auth/signup/request-otp | auth | 429 (1) | 0.68 ms | 0.68 ms |
| GET /api/auth/test-otp | auth | 404 (1) | 1.1 ms | 1.1 ms |
| POST /api/auth/signup/verify-otp | auth | 400 (1) | 0.57 ms | 0.57 ms |

## Notes

- This smoke intentionally avoids authenticated success paths unless separate tokens are supplied in a future extension.
- Protected routes are considered covered when their auth/admin guard returns the expected `401`.
- Public mutation callbacks use empty payloads and accept the configured guard response only.
