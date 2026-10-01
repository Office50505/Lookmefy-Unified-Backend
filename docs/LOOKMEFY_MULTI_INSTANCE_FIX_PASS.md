# Multi-instance backend fix pass — local handoff

No production migration, deployment, SSM change, or AWS change was performed.

## Shared media migration for the infrastructure owner

The production `/uploads` handler now reads Bunny storage directly by key after
authorizing the request. It does not read the receiving EC2's disk. New
persistent uploads require `STORAGE_PROVIDER=bunny` in production.

The migration script inventories these persisted upload references, including
file objects whose local `/uploads` URL exists without a `path`:

| Model | File fields | Additional local URL fields |
| --- | --- | --- |
| User | `avatarPhoto`, `bodyPhoto`, `bodyPhoto.original` | — |
| Product | `image` | — |
| TryOn | `image`, `transparentImage`, `video` | `imageProcessing.sourceImageUrl`, `imageProcessing.transparentImageUrl` |
| CustomTryOn | `garment`, `image`, `transparentImage` | `imageProcessing.sourceImageUrl`, `imageProcessing.transparentImageUrl` |
| ExternalTryOn | `image`, `transparentImage` | `imageProcessing.sourceImageUrl`, `imageProcessing.transparentImageUrl` |
| ClosetItem | `image` | — |
| ClosetOutfit | `garment`, `image`, `transparentImage` | `imageProcessing.sourceImageUrl`, `imageProcessing.transparentImageUrl` |

Run on the EC2 that still holds the existing upload files, using its approved
production environment and a database backup:

```sh
npm run storage:migrate:bunny
npm run storage:migrate:bunny:apply
```

The first command is a dry run. Review every missing-file warning and verify
the candidate count before applying. The apply command uploads to Bunny and
updates MongoDB references. Re-run the dry run afterward and confirm zero
candidates and zero missing files. Also inventory any historical upload URLs
outside the listed schema fields and absolute API-host URLs before routing
traffic to another EC2. Do not remove the original local files until media
retrieval from both EC2s and a rollback window have been verified. Restoring
the old application alone cannot undo migrated MongoDB references; retain the
database backup and Bunny objects for rollback.

## Private-media policy requiring owner decision

The current client contract returns direct Bunny CDN URLs for user profile,
closet, and generated media. Those URLs bypass the API's `/uploads` token
check. The mobile client currently renders direct URLs and does not attach a
private-media token to `/uploads` requests. **Treat user media as publicly
retrievable by anyone who has its CDN URL unless Bunny is independently
configured to enforce private access.** No Bunny setting was changed here.

Before production rollout, the product and infrastructure owners must confirm
that public-by-URL access is intended. If user media must be private, implement
signed CDN access or API proxy URLs plus mobile token support, then test old and
new clients. Do not infer privacy from the authenticated upload API.

## Readiness and worker policy

The ALB target group should check `/api/ready`. The response is `ok: true`
with `checks.mongo`, `checks.redis`, and `checks.queue` equal to `ready` when
the API can accept traffic. The SSM cutover and rollback scripts now parse that
contract. The `/api/health` endpoint is liveness only.

Worker heartbeat is deliberately separate from ALB readiness. PhonePe jobs
remain in BullMQ during a worker restart, and payment status requests can
reconcile payment state through the API. Profile and try-on jobs may be delayed,
but another backend EC2 cannot safely replace a missing worker merely by
receiving traffic. Monitor the worker process, queue age, and failed jobs
independently; alert and recover the worker promptly. A prolonged worker outage
is an operational incident, though it does not justify routing traffic to a
different API instance.

## Shared Redis and rollback

Production API and worker startup reject missing or loopback `REDIS_URL`, local
storage, and incomplete Bunny configuration.
Terraform no longer provides a loopback Redis default and requires a shared
endpoint in `backend_env`. Use the same URL and queue prefix on every API and
worker process. Do not store credentials in Git or Terraform examples.

The IP blocklist uses MongoDB as the authoritative security rule store on
every production request. This deliberately avoids a cache-based allow window
after a block or unblock. A failed database read returns 503. Local caching is
retained only for non-production use. Before rollout, confirm the additional
blocklist read load is acceptable; for rollback, revert the application version
without changing or deleting MongoDB block rules.

Automatic scanner violation counts use an atomic Redis counter in production,
so a threshold is shared across API instances. If Redis is unavailable, matching
scanner requests fail closed with 503; other requests remain governed by the
normal IP blocklist and route checks. Automatic block responses wait for the
MongoDB rule write. Before rollout, inspect historical duplicate IP rules;
the admin unblock path now deactivates every rule with the same value.

Payment fixes require no data migration. Rollback to the old code would restore
the non-final Razorpay fulfillment behavior and should only be considered with
payment traffic paused and a ledger reconciliation plan.

## Final process-local state audit

Production temporary sessions and AI conversations require Redis. BullMQ jobs
use shared Redis; PhonePe callbacks use a stable job ID and MongoDB payment
fulfillment is transactional. The production video path saves generated media
to Bunny before responding; the process-local background video save branch runs
only outside production. Product and recommendation caches, provider response
caches, and image data URI caches are performance caches that can differ between
instances without changing payment or media ownership. Local upload files used
by image processing and product ingestion are request or job scratch files.

The rate limiter still uses a per-process fallback when Redis fails. That is
part of the separately excluded Phase 4 work. It can weaken an abuse threshold
during a Redis outage even though readiness fails and scanner auto-blocking
fails closed. Review it before claiming all security controls are shared.
