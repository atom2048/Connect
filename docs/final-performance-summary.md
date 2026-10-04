# Final Performance Summary

> Historical performance summary. DM references describe the pre-retirement build and are retained only as migration context.

This document summarizes the Connect performance work through Phase 3-D. It is intentionally operational: use it to understand what is lighter now, what still falls back for legacy data, and what to verify before production use.

## What Was Reduced

### Firestore reads
- Feed loading uses cursor pagination instead of large fixed reads.
- Feed append rendering avoids rebuilding all existing post cards.
- Post author summaries, notification sender summaries, and comment author summaries are stored as optional fields for new data, with cached fallback for legacy data.
- Post viewer state for liked/bookmarked/reposted is fetched in page-level batches.
- Comment liked state and missing comment like counts are fetched in batches for visible comments.
- Notifications list is paged and notification badge subscription is limited to unread notifications.
- DM is retired; the active UI does not subscribe to conversation or message data.
- Profile repost/bookmark/reply restoration uses batched post ID lookup.

### Storage transfer
- New post, quote, and comment uploads save `Attachment` metadata where possible;
  DM uploads are retired.
- New image uploads generate a best-effort client preview and save `previewUrl` / `previewStoragePath`.
- Image display prefers `thumbnailUrl || previewUrl || url` on cards/lists/messages.
- Videos keep `preload="none"` and Phase 3-D delays list/card video `src` assignment in major render paths.
- PDF/zip/text style attachments stay as metadata links instead of inline body reads.

### DOM and rendering cost
- Feed appends only newly fetched posts.
- Feed DOM now prunes old rendered cards to lightweight placeholders after the soft limit.
- Images keep `loading="lazy"` and `decoding="async"`.
- Mobile-oriented CSS reductions from earlier phases remain in place.

## Storage Cleanup

Implemented cleanup uses only explicit stored paths:
- `Attachment.storagePath`
- `Attachment.previewStoragePath`
- Story `mediaStoragePath`
- Story `previewStoragePath`

Cleanup is best-effort. Storage deletion failures are logged as warnings and do not block the Firestore delete/update path.

Current cleanup coverage:
- Post delete for new `attachments` metadata.
- Comment delete for new `attachments` metadata.
- Post edit replacement for previous `attachments` metadata.
- Story delete for new story media metadata.

Not covered yet:
- Legacy URL-only files where no storage path is saved.
- Profile photo/cover replacement cleanup.
- DM message deletion cleanup, because message deletion is not fully modeled in the current UI flow.

## Legacy Data Compatibility

Legacy documents remain readable. If new optional fields are absent, the UI falls back to existing fields such as `imageURLs`, `videoURL`, `imageURL`, `fileURL`, `mediaUrl`, `photoURL`, and `coverURL`.

Do not infer Storage paths from download URLs. Existing URL-only data should be migrated only with a deliberate backfill/cleanup plan.

## Manual Verification Focus

Before production use, verify these with `CONNECT_PERF_DEBUG=1` and Firebase Console metrics:
- Feed initial load and load more read counts.
- Comment initial 30 and comment load-more behavior.
- Notification pagination and unread badge subscription.
- DM latest 50, older message loading, and read marking.
- Image-heavy feed Storage transfer after preview generation.
- Video-heavy feed Network tab: videos should not fetch body bytes until opened/played.
- Post/comment/story deletion with new metadata should not fail if Storage cleanup fails.

## Deferred High-Risk Work

Not implemented in Phase 3-D:
- Cloud Functions thumbnail generation.
- Firebase Extensions media processing.
- Server-side video compression.
- PWA/offline caching.
- Full virtual list.
- Firestore/storage rules loosening.
- Production backfill or deploy.

Recommended next step is a real browser measurement pass, then Cloud Functions or Extensions for consistent image/video thumbnails.
