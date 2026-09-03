# FitLook Backend Contracts Required For Remaining Phases

Date: 2026-08-05

## Cart

Required endpoint:

- `GET /api/cart`
- `POST /api/cart/items`
- `PATCH /api/cart/items/:itemId`
- `DELETE /api/cart/items/:itemId`

Authentication:

- Optional for guest carts if a guest cart token exists.
- Required for account-synced carts.

Request body for add:

```json
{
  "productId": "mongo-product-id",
  "variant": {
    "size": "M",
    "colour": "Black"
  },
  "quantity": 1
}
```

Response:

```json
{
  "cart": {
    "items": [],
    "subtotal": 0,
    "currency": "INR",
    "warnings": []
  }
}
```

## Checkout And Orders

Required endpoints:

- `POST /api/orders`
- `GET /api/orders/:id`
- `POST /api/orders/:id/payment`
- `GET /api/orders/:id/payment-status`

Must validate inventory, price, address, payment status, and duplicate callbacks server-side.

## Address Book

Required endpoints:

- `GET /api/account/addresses`
- `POST /api/account/addresses`
- `PATCH /api/account/addresses/:id`
- `DELETE /api/account/addresses/:id`

Required fields:

- full name
- phone
- alternate phone optional
- pincode
- house/flat
- street/area
- landmark optional
- city
- state
- address type
- default flag

## Seller Size Request

Required endpoint:

- `POST /api/products/:id/size-request`

Request:

```json
{
  "requiredSize": "XL",
  "bust": "optional",
  "waist": "optional",
  "hip": "optional",
  "height": "optional",
  "phone": "+919999999999",
  "message": "Need this before Friday",
  "consent": true
}
```

Response:

```json
{
  "requestId": "id",
  "status": "received"
}
```

## Reviews And Social Proof

Required endpoints:

- `GET /api/products/:id/reviews`
- `GET /api/reviews/featured-tryons`

Do not show fake reviews or fake aggregate ratings.

## AI Try-On Jobs

Current try-on endpoints are request/response. Production job UX needs:

- `POST /api/tryon-jobs`
- `GET /api/tryon-jobs/:id`
- `POST /api/tryon-jobs/:id/cancel`
- `POST /api/tryon-jobs/:id/retry`

Job states:

- queued
- preparing_photo
- fitting_outfit
- refining
- completed
- failed
- cancelled

The response should include recoverable error codes for unsupported image, multiple people, face not visible, timeout, provider failure, rate limit, insufficient credits, and server unavailable.
