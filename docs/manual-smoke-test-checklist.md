# Manual Smoke Test Checklist

> Historical checklist. DM rows are retained as reference for legacy-data investigation only; they are not current acceptance criteria. Use `SMOKE_TEST_CHECKLIST.md` for the retirement/search release.

Use this checklist before Phase 3 changes. Run it once at desktop width and once at mobile width. When possible, enable performance logs with `localStorage.setItem('CONNECT_PERF_DEBUG', '1')` and reload.

## Auth

### Login
- Expected: Existing user can log in and lands on the main feed.
- Check on failure: `src/auth.ts`, `src/main.ts`, Firebase Auth console errors.

### Logout
- Expected: User session clears and protected pages redirect to login.
- Check on failure: auth state listener in `src/main.ts`, local state cleanup.

### Sign up
- Expected: New user profile is created with optional search fields.
- Check on failure: `createUserProfile()` in `src/db.ts`, Firebase Auth errors, Firestore `users` doc.

## Profile

### Profile display
- Expected: Existing profile data renders even when optional summary/search fields are missing.
- Check on failure: `src/pageModules/profile.ts`, `getUserProfile()`, profile fallback logs.

### Profile edit
- Expected: Display name, username, avatar/cover data save and re-render.
- Check on failure: `updateUserProfile()`, search fields `usernameLower`, `displayNameLower`, `searchKeywords`.

## Posting and Feed

### Create text post
- Expected: Post appears in feed without full page reload.
- Check on failure: `createPost()`, `renderFeedPosts()`, Firestore `posts` doc.

### Image post
- Expected: Image uploads, displays lazily, and existing image posts still render.
- Check on failure: `src/attachments.ts`, Storage rules, image URL fields.

### Video post
- Expected: Video appears with `preload="none"` and does not download full media on list view.
- Check on failure: `renderPostCard()`, Storage transfer in Firebase Console.

### Attachment post
- Expected: File name/type metadata displays and download link works.
- Check on failure: attachment record creation, Storage URL, legacy fallback fields.

### Initial feed
- Expected: First fetch is limited, and `[ConnectPerf] getFeedPosts` shows 20 posts or fewer.
- Check on failure: `getFeedPosts()`, cursor paging, Firestore reads.

### Load more feed
- Expected: Only additional post DOM is appended; existing cards do not reset.
- Check on failure: `renderAdditionalFeedPosts()`, `renderedPostIds`, scroll behavior.

## Post Actions

### Like
- Expected: Like toggles immediately and count updates.
- Check on failure: `toggleLike()`, viewer state cache, button dataset.

### Bookmark
- Expected: Bookmark toggles and saved/bookmark profile page shows the post.
- Check on failure: `toggleBookmark()`, `getUserBookmarks()`, `getPostsByIds()`.

### Repost
- Expected: Repost toggles and profile reposts restore posts via batched lookup.
- Check on failure: `toggleRepost()`, `getRepostedPostIds()`, `getPostsByIds()`.

## Comments

### Show comments
- Expected: Comments render with author fallback and like state; no per-comment profile read loop.
- Check on failure: `getCommentsPage()`, `enrichCommentRecords()`, `getCommentViewerStates()`.

### Add comment
- Expected: New comment appears with author summary and post comment count increments.
- Check on failure: `addComment()`, Firestore `comments` doc, `commentsCount`.

### Comment like
- Expected: Comment like toggles and `likesCount` updates when possible.
- Check on failure: `toggleCommentLike()`, `comments/{commentId}.likesCount`, fallback like query.

## Notifications

### Notification badge
- Expected: Badge listens only to unread notifications and remains responsive.
- Check on failure: notification listener in `src/main.ts`, unread query.

### Notification list
- Expected: First page shows about 30 notifications and sender summaries/fallback render.
- Check on failure: `getNotificationsPage()`, sender fallback count, Firestore index.

### Load more notifications
- Expected: Additional notifications append without duplicating existing items.
- Check on failure: notification cursor state in `src/pageModules/explore.ts`.

## DM (retired)

- Expected: No conversation list, composer, message action, or DM media upload is
  exposed. Old `#/dm` bookmarks show the explicit retirement page without reading
  conversation data.
- Check on failure: unexpected DM link/button, notification, or Firestore read.

## Discovery and Relationships

### Search
- Expected: Queries under two characters do not run; existing users can still be found through fallback.
- Check on failure: `searchUsers()`, search fields, fallback limit.

### Friends list
- Expected: Friends render without repeated profile reads for the same IDs.
- Check on failure: `getUserFriends()`, `getUserProfilesByIds()`.

### Followers / following
- Expected: Lists load and profile navigation works.
- Check on failure: follow/friendship queries and profile fallback.

## Mobile Width

### Mobile layout
- Expected: Feed, bottom nav, modals, comments, notifications, and DM scroll smoothly without overlap.
- Check on failure: `src/style.css`, fixed headers/nav, heavy shadows/filters.

## Performance Logs

### `CONNECT_PERF_DEBUG=1`
- Expected: Logs show counts, query estimates, fallback counts, and ms only.
- Check on failure: `perfDebug()`, `docs/performance-checklist.md`.

## Phase 3-A Manual Checks

### Comment pagination
- Expected: Comment modal/detail first render shows about 30 comments, with a `さらにコメントを読み込む` button only when more comments exist.
- Check on failure: `getCommentsPage()`, comment cursor state in `src/pageModules/home.ts` and `src/pageModules/explore.ts`.

### Comment load more
- Expected: Loading more appends the next page without duplicate comments, and comment like/delete/reply still works.
- Check on failure: `refreshDetailComments()`, `renderLoadedComments()`, `setupCommentLikeButtons()`, `setupCommentDeleteButtons()`.

### Comment submit/delete/reply
- Expected: New comments appear immediately, deleted comments do not break the list, and reply UI is not triggered twice.
- Check on failure: reply button binding in `home.ts` / `explore.ts`, `addComment()`, `deleteComment()`.

### Media fallback and transfer
- Expected: Images prefer `thumbnailUrl / previewUrl / url`, use `loading="lazy"` and `decoding="async"`; videos keep `preload="none"`.
- Check on failure: `renderPostImages()`, `renderComment()`, DM message rendering, profile media grid.

### Non-image attachments
- Expected: PDF/zip/text/audio entries do not fetch the file body just by appearing in a list; links and controls still work.
- Check on failure: attachment rendering in `src/components.ts` and DM rendering in `src/pageModules/communications.ts`.

### Storage usage
- Expected: Firebase Storage download bytes do not spike from simply opening feed/profile/comments/Explore/DM lists.
- Check on failure: Firebase Console Storage usage, video preload attributes, missing thumbnail/preview metadata.
## Phase 3-B Browser Measurement Pass

Before measuring:
- Expected: Browser console enables `CONNECT_PERF_DEBUG` with `localStorage.setItem('CONNECT_PERF_DEBUG', '1')`, then reloads.
- Check on failure: localStorage Application panel, `perfDebug()` in `src/db.ts`.

Network cold run:
- Expected: With DevTools Network `Disable cache` checked, record JS/CSS transfer, image transfer, media requests, Fetch/XHR, and Firestore calls.
- Check on failure: oversized chunks in Vite build output, unexpected media downloads, repeated Firestore queries.

Network normal-cache run:
- Expected: With cache enabled, repeated navigation should reuse cached JS/CSS and avoid unnecessary media refetches.
- Check on failure: cache headers, Storage URL churn, image/video elements being recreated too often.

Firebase Console Firestore reads:
- Expected: Firestore reads increase roughly with visible/page-sized docs for feed, comments, notifications, DM, search, and profile restore flows.
- Check on failure: `[ConnectPerf]` query counts, page functions in `src/db.ts`.

Firebase Console Storage transfer:
- Expected: Image-heavy lists transfer image bytes lazily; video-heavy lists do not fetch full videos until playback.
- Check on failure: media rendering in `src/components.ts`, `src/pageModules/communications.ts`, and `src/pageModules/profile.ts`.

Chrome Performance recording:
- Expected: Feed scroll, comment load-more, DM load-older, and profile media scroll do not show persistent Long Tasks.
- Check on failure: DOM size, image decode tasks, repeated full-list `innerHTML`, CSS paint cost.

Mobile width:
- Expected: Repeat feed, comments, notifications, DM, search, and profile media at 390x844 and 430x932.
- Check on failure: fixed header/bottom nav overlap, large media layout shifts, scroll jank.

Mobile/WebView project:
- Expected: If using `mobile`, run the same feed/comments/DM/search/profile-media checks in the mobile shell after web build validation.
- Check on failure: WebView cache/media preload differences, native project dependency state.

Minimum values to write down:
- JS/CSS transfer on first load.
- Initial feed post count and load-more post count.
- Author fallback count and viewer-state chunk count.
- Initial and load-more comment fetched docs.
- Notification fetched docs.
- Initial DM docs and older-DM docs.
- Search query count and fetched docs.
- Storage download bytes for image list and video list flows.
- Screens with visible jank or Long Tasks.
## Phase 3-C Attachment Upload Checks

### New post image metadata
- Expected: New image posts render normally, keep legacy `imageURLs`, and save optional `attachments` with `storagePath`; `previewUrl` appears when preview generation succeeds.
- Check on failure: `uploadAttachmentFile()`, `createImagePreviewFile()`, `createPost()`, post composer upload flow.

### New post video metadata
- Expected: New video posts render with `preload="none"`, keep `videoURL`, and save an attachment with best-effort `duration/width/height`.
- Check on failure: browser metadata support, `readAttachmentMetadata()`, post composer video upload.

### DM attachment metadata (retired)
- Expected: No DM media send or reload path exists. Existing records remain
  preserved and outside the active UI.
- Check on failure: any DM upload control, writer, or visible message route.

### Comment attachment compatibility
- Expected: Comment attachments still send, render, page, like, reply, and delete as before; new image comments may include `previewUrl`.
- Check on failure: comment upload flows in `home.ts` and `explore.ts`, `renderComment()`.

### Preview fallback
- Expected: If preview generation fails or is skipped, original `url` is used and the upload still succeeds.
- Check on failure: image type/size guards in `createImagePreviewFile()`.

### Cleanup boundary
- Expected: No automatic Storage deletion is attempted for old URL-only data. New docs contain paths for a future cleanup phase.
- Check on failure: delete flows and Storage Console object state.
## Phase 3-D Final Smoke Items

### Post Edit Media Metadata
- Expected: Editing a post with replacement images/videos keeps the post visible, updates legacy fields, and stores `attachments` metadata for new files.
- Check on failure: `openEditPostModal()`, `uploadAttachmentFile()`, `updatePost()`.

### Story Upload Metadata and Cleanup
- Expected: New image/video stories still display; delete marks the story deleted and attempts cleanup only for stored paths.
- Check on failure: `createStory()`, `deleteStory()`, story composer upload path.

### Profile Photo/Cover Metadata
- Expected: Updating profile photo or cover keeps `photoURL` / `coverURL` working and stores optional metadata for new uploads.
- Check on failure: profile edit modal, `uploadAttachmentFile()`, `updateUserProfile()`.

### Video List Loading
- Expected: Feed/comment/DM/profile media list videos show a play affordance or tile without downloading video body bytes before interaction.
- Check on failure: `renderPostCard()`, `renderComment()`, DM message render, profile media grid.

### Feed DOM Soft Limit
- Expected: After long scrolling, old feed cards become lightweight placeholders with an Open link, and newer cards remain interactive.
- Check on failure: `appendFeedPosts()`, `pruneFeedDom()`, event binding on newly appended cards.

### Storage Cleanup Safety
- Expected: New metadata-backed post/comment/story deletes do not fail if a Storage object is already missing. Legacy URL-only media is not guessed or deleted.
- Check on failure: `deleteAttachmentFiles()`, `deletePost()`, `deleteComment()`, `deleteStory()`.
