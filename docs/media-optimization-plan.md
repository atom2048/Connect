# Media Optimization Plan

> Historical plan. DM media paths are legacy data/reference only; new DM uploads are disabled by the retirement release.

## Current Flow

Shared upload helper:
- `src/db.ts` exposes `uploadFile(file, path, onProgress?)`.
- It writes the file to Firebase Storage with `uploadBytes` or `uploadBytesResumable` and returns only a download URL.
- The helper does not return the Storage path, content metadata, image dimensions, or media duration.

Attachment helpers:
- `src/attachments.ts` defines `Attachment`, file kind detection, size formatting, `createAttachmentRecord()`, and `readAttachmentMetadata()`.
- `createAttachmentRecord()` can store optional `thumbnailUrl`, `previewUrl`, `duration`, `width`, `height`, and `storagePath`.
- `readAttachmentMetadata()` can read image `width/height`, video `duration/width/height`, and audio `duration` from a local File before upload.

Posts:
- `src/pageModules/home.ts` uploads post images and videos to `posts/{uid}/...`.
- `createPost()` in `src/db.ts` stores legacy `imageURLs`, `imageAlts`, and `videoURL` fields.
- New post uploads do not currently store `Attachment[]`, `storagePath`, `width/height`, or `duration`.
- Quote post and edit flows also preserve legacy `imageURLs/videoURL` fields.

Comments:
- `src/pageModules/home.ts` and `src/pageModules/explore.ts` upload one comment attachment to `comments/{uid}/...`.
- Comment creation stores both legacy fields (`imageURL`, `videoURL`, `audioURL`, `fileURL`, `fileName`) and `attachments`.
- New comment attachments include `storagePath` and available `width/height/duration` metadata.

DM:
- Direct messages are retired. The active client has no DM upload or message
  writer; existing records remain preserved and are not read by the UI.

Profile media:
- Profile avatar and cover uploads in `src/pageModules/profile.ts` store `photoURL` and `coverURL` on the user profile.
- Profile media grid is derived from user posts.
- The grid prefers attachment image `thumbnailUrl || previewUrl || url` when a post has attachments, otherwise it falls back to legacy `imageURLs`.

Display:
- `src/components.ts` renders post images via `renderPostImages()` with attachment fallback when available.
- `src/components.ts` renders comments with `thumbnailUrl || previewUrl || url` for images, `previewUrl || url` for videos, and metadata/link display for files.
- `src/pageModules/communications.ts` renders DM image/video/file from legacy URL fields.
- Videos in list/detail message/post/comment UI use `preload="none"`.
- Images in feed/comment/DM/profile/explore UI mostly use `loading="lazy"` and `decoding="async"`.

Deletion:
- Post/comment/DM delete flows mostly remove Firestore docs or references.
- Storage object deletion is not consistently implemented because many records only have download URLs and no `storagePath`.

## Current Problems

Original URLs in lists:
- Legacy post `imageURLs` and DM `imageURL` point to original Storage objects.
- Until preview/thumbnail fields exist, image-heavy lists can still transfer large originals.

Video list risk:
- `preload="none"` prevents eager video body loading in normal browsers, but the element still contains the full `src`.
- Some WebView/browser behavior can still issue metadata/range requests or make URL inspection noisy.
- A safer Phase 3-C+ shape is thumbnail-only in lists, then set video `src` only after user action.

3GB attachment risk:
- Comments and DM support very large files in Storage rules.
- A 3GB video or archive should never be fetched by list display.
- Existing file links are safe as links, but video/audio controls must stay non-preloading.

Missing metadata:
- Posts and DM do not store `storagePath`, dimensions, duration, or `Attachment[]` today.
- Existing data has no thumbnail/preview fields and must keep working through legacy URL fallback.

Deletion and cleanup:
- Without `storagePath`, reliable Storage cleanup requires parsing download URLs or manual cleanup, both risky.
- Future processing and rollback are easier if every new upload stores the path used at upload time.

Rules and security:
- `storage.rules` currently allows public reads and authenticated writes within broad media/content-type limits.
- Phase 3-C should not loosen these rules.
- Thumbnail paths must be covered by current write/read rules or added with narrowly scoped rules.

Cost:
- Cloud Functions thumbnail/video work adds function invocation, CPU, memory, and Storage write costs.
- Firebase Extensions are faster to install but can create background processing costs and less custom control.
- Client-side previews reduce backend cost but use user CPU/memory and may be unreliable for very large files.

## Fallback Contract

All display code should follow this rule:
- Image list display: `thumbnailUrl || previewUrl || url`.
- Full image viewer/download: original `url`.
- Video list display: `thumbnailUrl || previewUrl` if present; otherwise current video element with `preload="none"` until thumbnails exist.
- Video playback: original `url`, ideally assigned only after user action in a later phase.
- Audio: show controls with `preload="none"` and duration when available.
- PDF/zip/text/file: show filename, type, size, and download/open link only.

Existing docs without new fields must remain visible using legacy fields:
- Posts: `imageURLs`, `imageURL`, `videoURL`.
- Comments: legacy media fields or `attachments`.
- DM records are retained for historical storage only and are outside the active
  media display path.
- Profiles: `photoURL`, `coverURL`.

## Options

### Cloud Functions

Use a Storage finalize trigger to generate image thumbnails and video poster thumbnails.

Benefits:
- Works for all clients and future uploads.
- Can write `thumbnailUrl`, `previewUrl`, dimensions, duration, and processing status consistently.
- Can support backfill later.

Risks:
- Requires Firebase Functions setup, deploy, runtime config, and operational monitoring.
- Video processing can be expensive and slow.
- Updating Firestore from Storage triggers needs a reliable mapping from `storagePath` to owning doc.

Good first scope:
- Image thumbnails only for new post/comment/DM attachments that already store `storagePath` and target doc info.
- Post/DM schema may need optional `attachments` before the trigger can reliably update doc fields.

### Firebase Extensions

Use official image resize extension for thumbnails.

Benefits:
- Faster than writing custom image thumbnail code.
- Mature path-based image processing.

Risks:
- Less control over Firestore doc updates and app-specific attachment arrays.
- Still requires extension install/config/deploy and cost monitoring.
- Video thumbnails/duration remain separate work.

Good use:
- Compare against Cloud Functions for simple image derivatives after measuring current Storage transfer.

### Client-side Preview Generation

Generate small WebP/JPEG preview before upload and upload it beside the original.

Benefits:
- No backend deploy for the first image optimization step.
- Can immediately set `previewUrl` for new uploads.
- Easy to roll back to original URL fallback.

Risks:
- Uses client CPU/memory, especially bad on mobile or huge images.
- Browser support and EXIF orientation need testing.
- Does not solve video thumbnails unless extracting a frame client-side, which is heavier.

Good first scope:
- Images only, capped by size/dimension, with graceful fallback to original-only upload.

## Recommended Implementation Order

1. Store upload metadata everywhere for new uploads:
   - Add optional `Attachment[]` or equivalent media metadata to new posts and DM messages.
   - Save `storagePath`, `width`, `height`, and `duration` where safely available.
   - Keep legacy `imageURLs/videoURL/imageURL/fileURL` fields for compatibility.

2. Decide image preview generation path based on measurement:
   - If backend deploy is acceptable, prefer Cloud Functions or Firebase Extension for consistent thumbnails.
   - If deploy should remain avoided, start with client-side image preview generation for small/medium images.

3. Enforce display fallback:
   - Audit feed, comment, DM, profile media, Explore, and image viewers.
   - List display uses `thumbnailUrl || previewUrl || url`.
   - Original URL remains available for full viewer/download.

4. Make video list display thumbnail-first:
   - Store `duration/width/height` on upload.
   - Generate or capture a poster thumbnail.
   - Render poster/button in lists and set video `src` only after user action or on detail view.

5. Backfill safely:
   - Dry-run first.
   - Only add optional fields.
   - Skip records that already have metadata.
   - Do not rewrite or delete existing original URLs.

6. Compare measurements:
   - Before/after Storage download bytes for image-heavy and video-heavy list flows.
   - Before/after Long Tasks and image decode cost on mobile width.

## Existing Data Migration Notes

- Existing posts do not have `storagePath`; do not attempt destructive cleanup.
- Existing download URLs can be displayed but are poor source-of-truth for Storage object identity.
- Backfill may infer paths from Firebase download URLs only if thoroughly tested against encoded paths and tokens.
- Prefer forward-only metadata for new uploads, then optional admin backfill with dry-run.

## Rollback

- Display fallback means removing `thumbnailUrl/previewUrl` usage should not be necessary; if generated previews fail, the app uses `url`.
- Keep original URLs and legacy fields during all Phase 3-C changes.
- For client-side preview generation, disable preview upload and continue uploading originals.
- For Cloud Functions/Extensions, disable trigger/extension and keep generated fields optional.

## Firestore and Storage Rules Notes

- Do not loosen public read/write rules in Phase 3-C.
- If new thumbnail paths are introduced, scope writes to authenticated owner paths or service account backend writes.
- Firestore rules must allow only expected optional metadata updates if client writes metadata after doc creation.
- Storage cleanup should be server-side or owner-scoped; do not let clients delete arbitrary paths.

## Phase 3-C Minimal Scope

Recommended first implementation:
1. Add optional `attachments` metadata to new post uploads while preserving
   legacy fields. DM upload work is retired and must not be reintroduced.
2. Save `storagePath`, image `width/height`, media `duration`, and video `width/height` where available.
3. Keep display fallback as `thumbnailUrl || previewUrl || url`.
4. Do not implement video compression yet.
5. Choose either client-side image preview generation or backend thumbnail generation after measuring current transfer.
6. Run typecheck/build/design lint and manual Storage transfer comparison.
## Phase 3-C Implementation Notes

Implemented in Phase 3-C:
- `uploadFile()` remains backward compatible and still returns a download URL string.
- `uploadAttachmentFile()` was added as the new metadata-preserving upload helper.
- New uploads through `uploadAttachmentFile()` save `url`, `storagePath`, `name`, `size`, `mimeType`, and best-effort `width`, `height`, and `duration`.
- Image uploads can generate a client-side WebP preview up to about 800px and upload it beside the original.
- Generated previews are saved as `previewUrl` and `previewStoragePath` when successful.
- Preview generation is best-effort: GIF/SVG/HEIC/HEIF and very large images are skipped, and failures fall back to original `url`.
- New post creation and quote post creation now save optional `attachments` while preserving legacy `imageURLs` and `videoURL`.
- New DM messages now save optional `attachments` while preserving legacy `imageURL`, `videoURL`, `fileURL`, and `fileName`.
- New comment uploads continue to save `attachments`, now through the shared upload helper.

Still intentionally not implemented:
- Post edit media replacement remains legacy URL based to avoid changing the edit workflow in the same phase.
- Profile photo and cover uploads remain URL based and should be handled separately.
- Storage cleanup is not automated yet. New attachments now have `storagePath` and optional `previewStoragePath`, which makes future cleanup safer.
- Existing download URLs are not parsed to infer paths.
- Cloud Functions, Firebase Extensions, server-side compression, and video thumbnail extraction remain future work.

Phase 3-D prerequisites:
- Verify Storage transfer reduction on image-heavy feeds, comments, DM, and profile media.
- Confirm new post/DM/comment docs contain optional `attachments` and legacy fields together.
- Decide whether Cloud Functions or Firebase Extensions should generate authoritative thumbnails for all clients.
## Phase 3-D Status

Phase 3-D adds final hardening before Cloud Functions or Firebase Extensions:
- Legacy upload paths for post edit, story upload, and profile photo/cover now save optional metadata where low risk.
- New metadata-backed post/comment/story deletions can clean up explicit Storage paths without guessing legacy URLs.
- List/card video rendering is moving toward delayed `src` assignment while keeping `preload="none"`.
- Feed DOM growth is capped with lightweight placeholders after a soft limit.

Remaining Phase 4 candidates:
- Cloud Functions or Firebase Extensions for reliable thumbnails.
- Server-side video thumbnail/metadata extraction.
- Profile media and story cleanup backfill for legacy data.
- Full virtual list after browser measurements prove it is needed.
