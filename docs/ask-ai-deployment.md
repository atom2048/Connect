# Connect Ask AI production baseline

This document records the fixed production baseline. It is an operational
reference, not a request to redeploy or to spend another model quota.

## Current deployment

- Worker: `connect-social-standalone`
- Worker URL: `https://connect-social-standalone.quest-live.workers.dev`
- Deployment/version ID: `b49dd4d4-aa71-4576-aafe-865cf5d16949`
- Frontend: `https://sns-app-ashen.vercel.app`
- D1: `connect-social` (`f6c1e716-15a8-4c71-80ed-19fab967aa44`)
- R2: `connect-social-media`

## Production flags

The standalone configuration is guarded by `npm run ai:production:check`:

```text
AI_UI_ENABLED=true
AI_GENERATION_ENABLED=true
AI_TEXT_READY=true
AI_VISION_READY=true
AI_ADMIN_ONLY=false
AI_ROLLOUT_PERCENT=100
AI_ENVIRONMENT=production
```

The guard runs before a future standalone deploy and fails if these public
invariants drift.

## Request path and authorization

1. The existing Connect card opens the dialog in `src/askAi.ts`.
2. The client calls `/api/posts/{postId}/ask-ai`; the Vercel rewrite reaches
   the standalone Cloudflare Worker, not a legacy Vercel AI implementation.
3. `worker/ai/handler.ts` applies Firebase/anonymous identity, rollout,
   request-size, risk, quota, rate-limit, ACL, consent, and readiness checks.
4. `worker/ai/context.ts` builds the D1 manifest. The existing viewer ACL is
   the authorization boundary for PUBLIC, FRIENDS/LIMITED, and PRIVATE posts.
   PUBLIC content is available unless the author explicitly opted out. For
   FRIENDS/LIMITED/PRIVATE content, the author must also enable the per-post
   consent in the post editor; a missing consent row is default-off and an
   explicit `DISABLED` value always denies the relevant modality. LIMITED and
   PRIVATE content is never selected without the existing viewer ACL. The
   consent copy tells authors that enabled post content may be sent to
   OpenRouter for a viewer's question.
5. `worker/ai/executor.ts` performs one bounded generation through the
   coordinator/control plane and stores redacted routing evidence. Each model
   attempt is also retained for seven days in
   `ai_generation_attempt_audit` with model/provider, outcome, safe error code,
   status, fallback eligibility, retry flag, and duration only; prompt bodies,
   image data, and PII are never stored.

## OpenRouter and safety

- `worker/ai/openrouter.ts` calls
  `https://openrouter.ai/api/v1/chat/completions` server-side.
- The only production key is the Worker Secret `OPENROUTER_API_KEY`; it is not
  in client code, Git, logs, or error payloads. BYOK is disabled.
- Reviewed endpoint snapshots require explicit zero pricing, acceptable
  privacy/retention, and an exact provider endpoint. Unknown or non-zero cost
  fails closed. Current routing evidence is the free
  `dots-studio/dots-3-note-preview:free` endpoint through `AtlasCloud`, with
  `byok=false`, `attempt=1`, and reported cost zero.
- `AI_ALERT_WEBHOOK_URL` is optional. If absent, the Worker uses a redacted
  log-only fallback.
- Anonymous and authenticated traffic retain edge/persistent rate limits,
  daily limits, burst/concurrency limits, bounded request/question size, and
  image count/size/type limits.
- A provider 429 opens a provider-scoped cooldown and the runtime moves to the
  next already-approved endpoint in the finite chain. The predeploy check has
  its own single-run chain-stop policy. Transport, timeout, 5xx, malformed,
  and empty responses use bounded classified fallback behavior. Infinite retry
  is prohibited.

## Production test-path protection

Production excludes only reserved historical synthetic fixture IDs/markers.
No mock response, debug control, synthetic UI, or admin smoke bypass is on the
production Ask AI request path. Explicit opt-out and LIMITED/PRIVATE ACL checks
remain fail-closed.

## Regression matrix for future changes

Do not rerun tests or deploy while this baseline is unchanged. If an Ask AI
code, policy, route, or configuration file changes, re-establish:

| Area | Required evidence |
| --- | --- |
| Anonymous Text/Vision | Real production public-post UI responses |
| Authenticated Text/Vision | Real production public-post UI responses |
| PUBLIC permission | Worker/context contract allows public content, including a missing legacy preference row |
| Explicit opt-out | Current-policy `DISABLED` remains denied |
| LIMITED/PRIVATE | Existing viewer ACL remains enforced; per-post author consent is required and missing consent is denied |
| Profile coverage | Public profile + up to 80 public posts + up to 80 public replies; profile context is capped at 8,000 estimated tokens and images at four |
| Fallback diagnosis | `ai_generation_attempt_audit` and `ai_openrouter_timing` expose each bounded attempt and timing without content |
| Secret protection | No key/token in tracked files, client output, logs, or errors |
| Production flags | `npm run ai:production:check` passes with the values above |
| Contract/build checks | `npm test`, `npm run typecheck`, and `npm run lint` pass |

Do not add a synthetic production control, change the OpenRouter Secret name,
or lower the public rollout flags as a workaround. If a regression is found,
make the smallest fix and deploy only after the production guard passes.

## Known non-blocking residual

Profile Ask AI can vary between roughly 17 and 44 seconds in production when
the free external provider is slow or the bounded `finish_reason:length`
retry is used. This is an accepted baseline residual for this closeout. No
streaming, hedging, paid provider, or model-composition change is part of this
closeout.
