# Connect Web Push / reliability / performance

## Runtime and architecture

- Vite 5.4 + vanilla TypeScript SPA (not Next.js or React)
- Firebase Authentication, Firestore and Storage
- Vercel static deployment plus Node API functions in `api/`
- Hash routes such as `/#/post/:id`, `/#/profile/:uid` and `/#/explore?query=...`
- Direct-message (DM) is retired. Old `/#/dm...` bookmarks show an explicit
  retirement page; no active link, notification, or push payload routes into DM
  data.

## Web Push deployment

The browser registers `/sw.js` at app startup without requesting permission; a PushSubscription is created and saved only after the notification settings button is pressed. Permission is requested only from that user action. On iOS/iPadOS the UI requires standalone Home Screen mode and shows the Home Screen installation guide.

Set the browser's public key in the Vercel build environment and keep server credentials in their owning runtime:

- `VITE_VAPID_PUBLIC_KEY`
- `FIREBASE_PROJECT_ID`
- either `FIREBASE_SERVICE_ACCOUNT_JSON`, or both `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`

The production sender is Firebase Functions. Store `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` in that Firebase project’s Secret Manager. Set the required `WORKER_SERVICE_ACCOUNT` string parameter through `functions/.env.<projectId>` when deploying. Compare only a public-key fingerprint against Vercel; never print or commit secret values.

Cloudflare Worker `/api/push/*` and D1 `push_subscriptions` are legacy compatibility surfaces and are not called by the active client. Keep subscription registration and delivery on Vercel API -> Firestore -> Cloud Tasks -> Firebase Functions; do not use the D1 table as a second subscription source.

Firestore uses these new server-owned collections; no destructive backfill is required:

- `pushSubscriptions/{sha256(endpoint)}` — one document per user/device/browser endpoint
- `pushDispatches/{notificationId}` — idempotent dispatch state

Deploy the updated `firestore.rules` before enabling Push in production. Client access to both collections is denied; authenticated API functions derive the user from the Firebase ID token.

## Performance reproduction

Reports are outside the repository under `C:\Users\akihi\.codex\sns-app\connect-debug-20260812`.

```powershell
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
$env:CHROME_PATH='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npx --yes lighthouse@12.8.2 http://127.0.0.1:4173/ --only-categories=performance --output=json
```

Both reports use Lighthouse mobile simulation (412x823, 4x CPU, simulated slow network). The dominant baseline costs were multi-megabyte original avatar images, the 977 KB app icon, eager feature modules, an external font request, and sequential feed-signal reads.

## Device smoke test

1. Configure the VAPID and Firebase Admin variables on a non-production Vercel deployment.
2. Sign in, open Settings, and press the Push ON button. Do not test by calling `Notification.requestPermission()` from the console.
3. Register one iPhone Home Screen installation, one Android browser/PWA and one desktop browser; Settings should show three registered devices.
4. From a separate test user, like/comment/reply, like a comment, and send a friend request. Confirm the in-app notification and Push open the post or profile route. Legacy notifications must be suppressed.
5. Turn Push off on one device and confirm only that endpoint is disabled and its endpoint/key material is deleted. A provider 404/410 also clears endpoint/key material and can be replaced after the user has already granted permission.

Push payloads contain the actor/action summary and deep-link metadata, but not comment, DM, or story-reply text. Legacy DM/story-reply records remain decodable for compatibility but are not displayed, counted, or sent by the active pipeline.
