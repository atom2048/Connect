# Connect notification pipeline

The production sender is the GCP Firebase Functions `processPushDeliveryTask` worker. Vercel hosts the web app and authenticated compatibility APIs; it must not call `web-push` after the sender cutover.

## Runtime

```text
Client action / authenticated API
  -> Firestore notifications
  -> Firestore trigger (retry enabled)
  -> Cloud Tasks
  -> Firebase Functions 2nd gen
  -> pushDeliveries/{logicalDeliveryId}
  -> Web Push provider
  -> public/sw.js
  -> OS notification and deep link
```

`push-delivery` handles two explicit task kinds: `expand` creates subscription-level delivery records and `send` calls the provider. Cloud Tasks owns retry/backoff, while Firestore stores leases, generations, and terminal outcomes for idempotency and reconciliation.

The 10-minute Firebase Scheduler function only repairs orphaned logical records; it does not execute delivery inline.

## Required runtime configuration

Functions must receive these values through the deployment environment/Secret Manager. Secret values must never be logged:

- `GCLOUD_PROJECT` / `FIREBASE_PROJECT_ID`
- `FIREBASE_FUNCTIONS_REGION` (default `asia-northeast1`)
- `CLOUD_TASKS_LOCATION`
- `PUSH_DELIVERY_QUEUE`
- `FUNCTIONS_BASE_URL`
- `WORKER_SERVICE_ACCOUNT` (required Firebase Functions string parameter; Cloud Tasks OIDC identity)
- `PUSH_SENDER_MODE` (`gcp` in production; `disabled` is the emergency stop)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in Secret Manager

`WORKER_SERVICE_ACCOUNT` must be set in `functions/.env.<projectId>` for the Firebase CLI deployment and must identify the enabled OIDC service account with Cloud Run Invoker permission. The VAPID pair must be the existing Production pair and must match the Vercel `VITE_VAPID_PUBLIC_KEY` fingerprint. Never generate a replacement key during deployment.

The active browser app stores subscriptions through the authenticated Vercel `/api/push-subscriptions` API into Firestore. Firestore notification creation is the only push pipeline entry point: the `enqueueNotification` trigger creates deterministic Cloud Tasks, and `processPushDeliveryTask` is the only production Web Push sender. Cloudflare Worker `/api/push/*` and its D1 `push_subscriptions` table are a retired compatibility path; do not enroll devices or dispatch pushes through it.

## Infrastructure release gate

Apply `infra/notification-pipeline.json` to the target GCP project and verify each queue's retry, deadline, rate, and concurrency settings. Apply the TTL policies in `infra/firestore-retention.json`; TTL deletion is asynchronous and is not used for correctness. Deploy Firestore rules/indexes and Functions from the same commit.

The Functions deployment must expose authenticated worker endpoints. The task service account needs only queue task creation and invocation permissions required for its role; the runtime service account needs only Firestore, Secret Manager VAPID read, and Web Push runtime access. Run authenticated canaries for expand/send and reconciliation before enabling `PUSH_SENDER_MODE=gcp`.

Preview and Production must use separate Firebase projects, Auth, Firestore, Functions, queues, scheduler, secrets, and test accounts. If the existing Vercel environments share `connect-b5e82`, do not claim environment isolation: provision a staging project or restrict tests to dedicated accounts and recipients in the Production project.

## Rollout

1. Provision queues, service accounts, Secret Manager references, Functions, Scheduler, indexes, and TTL policies.
2. Deploy Functions and triggers with `retry: true`; confirm trigger metadata and OIDC canaries.
3. Deploy Vercel APIs and the client.
4. Observe Phase A: new build telemetry, legacy direct writes, trigger failures, duplicate sender logs, and reconciliation repairs.
5. Only after the Phase B criteria are met, deploy the restrictive rules that deny client lifecycle/event/notification creation and immutable-field updates.

Rollback is a sender-mode change, not simultaneous activation: stop or set the GCP sender to `disabled`, confirm its queue is not sending, then use a previously deployed legacy release if one is intentionally restored. Never run legacy and GCP provider senders together.

## Freshness and privacy

Every notification has server-generated `pushExpiresAt`, `deliveryDeadline`, schema/pipeline versions, and a policy TTL. The delivery worker rechecks freshness, ownership, generation, Push preference, and disabled/block state immediately before sending. Payloads are generated server-side and contain no message body or private content; `notificationId` is the best-effort Service Worker tag.

## Observability

Use `correlationId` to follow operation -> task -> notification -> delivery. Structured client/API/Function/Service Worker logs carry `notificationType`, `recipientId`, `subscriptionStatus`, `pushResponseStatus`, and a normalized `failureReason`; they never include endpoints, VAPID material, or subscription keys. Provider 2xx means only `providerAccepted` for one subscription; Service Worker receipt, OS display, and click remain separate verification boundaries. A provider 404/410 immediately disables the delivery, removes endpoint/key material from the subscription document, and leaves only a short-lived tombstone so the signed-in browser can replace the local subscription without another permission prompt. Track `skippedExpired`, `skippedDisabled`, stale subscriptions, expansion incompletes, expired leases, reconciliation repairs, queue backlog age, and new dead letters.
