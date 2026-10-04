# Connect Performance Checklist

> Historical checklist. DM performance rows describe the pre-retirement product and must not be used to re-enable DM UI, producers, or writes.

This checklist is for development verification. Normal users should not see these logs.

## Enable and Disable

Enable in the browser console, then reload:

```js
localStorage.setItem('CONNECT_PERF_DEBUG', '1')
```

Disable:

```js
localStorage.removeItem('CONNECT_PERF_DEBUG')
```

Logs appear as collapsed console groups named `[ConnectPerf] ...`. Keep logs limited to counts, query/chunk estimates, fallback counts, and elapsed milliseconds. Do not log message bodies, comment text, email addresses, or private content.

## Browser Measurement Setup

Run each flow twice:
- Cold-ish run: Chrome DevTools Network tab, check `Disable cache`, hard reload, then measure initial load and first screen.
- Normal run: uncheck `Disable cache`, reload normally, then measure repeated navigation and scrolling.

Recommended DevTools panels:
- Network: filter by `JS`, `CSS`, `Img`, `Media`, `Fetch/XHR`, and `firestore.googleapis.com`.
- Performance: record feed scroll, comment modal open/load-more, DM open/load-older, and profile media scroll.
- Rendering: optionally enable FPS meter and paint flashing for mobile-width scroll checks.
- Application: confirm localStorage contains `CONNECT_PERF_DEBUG=1` only during verification.

Mobile-width check:
- Use Chrome DevTools device toolbar around 390x844 and 430x932.
- Test with normal network first, then optional Slow 4G only for relative comparisons.
- Watch for scroll jank, sticky header/bottom nav overlap, and long image decode tasks.

WebView/mobile project check:
- If using the `mobile` app, verify the same feed, comments, DM, search, and profile-media flows after web changes.
- Compare WebView behavior with desktop Chrome because media preload and cache behavior can differ.

## Firebase Console Measurements

Firestore reads:
- Open Firebase Console > Firestore Database > Usage.
- Record document reads before and after each flow.
- Use a small fixed test account and avoid background tabs to reduce noise.
- Treat SDK perf logs as estimates; Firebase Console is the billing-oriented reference.

Storage transfer:
- Open Firebase Console > Storage > Usage.
- Record download bytes before and after feed/profile/comments/Explore/DM media list flows.
- Compare image-heavy lists, video-heavy lists, and file-only lists separately.
- A list view that only shows video cards should not download full video bodies.

## Minimum Numbers to Record

Initial load:
- Total JS transfer and gzip size from Network.
- Total CSS transfer and gzip size.
- Initial route and time until feed/content is interactive.

Feed:
- `getFeedPosts` result count on initial load.
- `getFeedPosts` result count on load more.
- Post enrich fallback author count.
- Viewer state chunk/query count.
- Storage transfer while scrolling image posts.
- Whether video list items request media bytes before play.

Comments:
- `getCommentsPage` initial fetched docs, expected about 30 plus lookahead.
- `getCommentsPage` load-more fetched docs.
- `enrichCommentRecords` author fallback count.
- `getCommentViewerStates` chunk count and like-count fallback count.

Notifications:
- `getNotificationsPage` fetched docs, expected about 30 plus lookahead.
- Notification sender fallback count.

DM (retired):
- Confirm no conversation/message listener or Storage transfer is triggered by
  the active UI. Existing records are not read.

Search:
- `searchUsers` query count.
- User docs fetched per search.
- Whether short queries are skipped.

Mobile rendering:
- Screens that show Long Task entries during scroll.
- Approximate FPS/visible jank on feed, comments, DM, profile media.
- Any layout shift around media cards.

## Feed

Initial feed:
- Check `getFeedPosts`, post enrich, author fallback, and viewer state logs.
- First page should stay at 20 posts or fewer.
- Investigate if author fallback is greater than the visible post count.

Load more:
- Check that logs correspond to only the newly loaded page.
- Investigate if query counts keep increasing on the same screen without user action.

## Notifications

Notification list:
- Check `getNotificationsPage`.
- First page should be around 30 notifications.
- Investigate if sender fallback is close to every notification after sender summaries are available.

Notification badge:
- Confirm it stays unread-only and limited.

## DM (retired)

- Open an old `#/dm` bookmark and confirm the explicit retirement page renders
  without conversation/message reads or a redirect into another feature.

## Search

Search users:
- Check `searchUsers`.
- Queries shorter than two characters should not run.
- Investigate if one search causes a large user scan after search fields are backfilled.

## Profile

Reposts, bookmarks, saved posts, replies:
- Check `getPostsByIds`.
- Post restoration should use chunked ID lookup, not one `getPostById` per item.
- Investigate if requested IDs are much larger than visible results.

Profile media:
- Check image grid Network requests.
- If attachment previews exist, the grid should request preview/thumbnail URLs first.
- Legacy `imageURLs` posts still request original URLs until thumbnails/previews are generated.

## Comments

Open a post with comments:
- Check `getCommentsPage`, `enrichCommentRecords`, and `getCommentViewerStates`.
- Initial display should fetch about 30 comments, not the whole thread.
- `さらにコメントを読み込む` should fetch only the next page and should not duplicate existing comments.
- Author fallback should be based on unique missing authors, not comment count.
- Comments with `likesCount` should not need fallback like-count aggregation; old comments without it may still fallback.

## Media

Images:
- Check that rendered images use `loading="lazy"` and `decoding="async"` in feed, comments, DM, profile media, and Explore where applicable.
- Check fallback order where attachment metadata exists: `thumbnailUrl || previewUrl || url`.
- Legacy post images still use original `imageURLs`; this is expected until Phase 3-C creates previews.

Videos:
- Confirm list/detail cards use `preload="none"`.
- Confirm Network Media requests do not fetch full video bodies during list scrolling.
- Playback should fetch only after user interaction or browser controls request it.

Files/audio:
- PDF/zip/text list display should show link/name/size only.
- Audio controls should stay `preload="none"`.

## Firebase Console

Firestore:
- Watch document reads while loading feed, notifications, DM, search, profiles, and comments.
- Investigate if reads keep increasing while the page is idle.

Storage:
- Watch download bytes when scrolling feed, opening comments, profile media, Explore, and DM.
- Feed/list video display should not download full videos before user interaction because videos should use `preload="none"`.
- Investigate if Storage transfer grows heavily from list display alone.

## Temporary Warning Thresholds

These are investigation triggers, not strict production limits:
- Feed 20 posts with author fallback over 20: check author summaries/fallback cache.
- Query count growing in proportion to already-rendered items on the same screen: check duplicate enrich or redraw.
- 30 comments with author fallback much higher than unique authors: check comment author batching.
- Comment like query count equal to comment count: check `getCommentViewerStates` chunking.
- Opening comments on a busy post fetches far more than 30 docs before pressing load more: check `getCommentsPage` usage.
- DM initial display fetching far more than 50 messages: check message subscription limit.
- Storage transfer increasing heavily from video list display only: check `preload` and preview behavior.
- Storage transfer increasing heavily from image lists despite thumbnails/previews existing: check attachment fallback order.
- One search causing large user reads: check search fields and fallback path.
## Phase 3-C Attachment Metadata Checks

New upload verification:
- Create a new image post and inspect the Firestore `posts` doc. It should keep `imageURLs` and also include optional `attachments` with `url`, `storagePath`, `size`, `mimeType`, and best-effort `width/height`.
- If preview generation succeeds, the image attachment should include `previewUrl` and `previewStoragePath`.
- Create a new video post. It should keep `videoURL` and include an attachment with `storagePath`, `duration`, `width`, and `height` when the browser can read metadata.
- Send a DM image/file/video. The message should keep legacy URL fields and also include optional `attachments`.
- Add a comment attachment and confirm the shared attachment upload path still stores metadata.

Transfer verification:
- In an image-heavy feed, compare Storage download bytes before and after new uploads with previews.
- List/card image requests should prefer `thumbnailUrl || previewUrl || url`.
- Existing media without `previewUrl` will still use original `url`; this is expected until backfill or server thumbnails exist.
- Video list items should still use `preload="none"` and should not return to `preload="metadata"`.

Cleanup status:
- New attachments have `storagePath` and image previews may have `previewStoragePath`.
- Deletion cleanup is not automated in Phase 3-C; do not infer Storage paths from old download URLs.
## Phase 3-D Final Hardening Checks

- Confirm post edit uploads save new `attachments` metadata while keeping legacy `imageURLs` / `videoURL` fallback.
- Confirm story uploads save `mediaStoragePath`, `previewStoragePath`, and best-effort width/height/duration metadata.
- Confirm profile photo and cover uploads keep `photoURL` / `coverURL` and also save optional storage/preview/size metadata for new uploads.
- Confirm deleting a post with new `attachments` removes Firestore data even if Storage cleanup logs a warning.
- Confirm deleting a comment with new `attachments` removes Firestore data even if Storage cleanup logs a warning.
- Confirm deleting a story with new media metadata marks the story deleted and attempts Storage cleanup.
- Confirm legacy URL-only media still displays and is not guessed for cleanup.
- Confirm post, comment, DM, and profile media list videos render with `data-src` where applicable and do not fetch body bytes until user action or detail view.
- Confirm long feed scrolling replaces very old rendered cards with lightweight placeholders instead of growing indefinitely.
- Confirm `thumbnailUrl || previewUrl || url` is still the image display priority on cards/lists/messages.

### Firebase Console Metrics

During verification, compare Firestore reads and Storage transfer for:
- first feed load,
- feed load more,
- opening a comment-heavy post,
- opening an image-heavy feed,
- opening a video-heavy feed,
- deleting a newly uploaded post/comment/story with metadata.

No Firebase deploy is required for Phase 3-D unless indexes or rules are changed separately.
