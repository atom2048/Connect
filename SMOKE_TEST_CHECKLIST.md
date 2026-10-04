# Connect Smoke Test Checklist

Current browser smoke checks for the retirement/search release. Run locally or in Preview; Production and real-device checks must be reported separately.

| Area | Operation | Expected result |
| --- | --- | --- |
| Login screen | Open the app while signed out. | Login/register/reset options are visible and the page renders without console-blocking errors. |
| Login | Sign in with a known test account. | You land in the authenticated app and user-specific navigation/state appears. |
| Logout | Use the logout action. | Session ends and the app returns to the signed-out flow. |
| Home | Navigate to Home. | Story shelf, composer area, feed tabs, and feed container render. |
| Feed | Switch recommended/friends feed tabs and scroll/load more if available. | Posts render, tab selection updates, and no duplicate/broken cards appear. |
| Create post | Submit a text post. | The post is created, appears in the feed or detail view, and no error toast appears. |
| Save post draft | Enter post content, leave/close where draft save is offered. | Draft save confirmation/toast appears and draft can be reopened. |
| Delete draft | Open drafts and delete a saved draft. | Draft is removed and no stale draft remains in the list. |
| Post comment | Open a post and submit a comment. | Comment appears under the post with the correct author/time. |
| Comment like | Like and unlike a comment. | Like state and count update consistently. |
| Quote post | Use quote/repost flow with text. | Quote post is created and links back to the original post. |
| Repost undo | Open the repost menu, repost, then open it again and choose undo. | The menu offers repost/undo and the action is applied at most once per click. |
| Story shelf | View Home stories. | Own/add story chip and available story avatars render. |
| Story viewer | Open a story and navigate next/previous/close. | Story media/text/poll controls render and closing returns to Home. |
| Image viewer | Open an attached post image and navigate/close. | Lightbox opens at the selected image and closes cleanly. |
| Mention notification | Mention another user in a post/comment. | Mentioned user receives the expected notification. |
| Profile view | Open own and another user's profile. | Profile header, tabs, and posts render for the selected user. |
| Profile edit | Edit own profile fields/avatar where available. | Saved profile updates persist after refresh/navigation. |
| Bookmark | Bookmark and unbookmark a post; open bookmarks. | Bookmark state changes and bookmarked post appears/disappears as expected. |
| Search | Search news/users/public posts from the Explore/news surface. | Categories render independently, result navigation works, and empty/error states are distinct. |
| Notifications | Open notifications and mark/read items. | Notification list renders and read state updates. |
| Post detail | Open a post detail route directly and from feed. | Post, comments, and action buttons render for the correct post. |
| Hashtag link | Open a hashtag from post text. | It opens the post search view with an encoded exact-hashtag query; no trend page is opened. |
| Friends / QR | Open friends page and QR friend flow. | Friend lists/requests render and QR actions do not error. |
| Legacy DM route | Open `#/dm`, `#/dm/new`, and an old `#/dm/{id}` bookmark. | An explicit DM retirement page stays on the requested route; no silent redirect and no conversation/message/attachment read is attempted. |
| DM shutdown | Use an old client or direct API/SDK write path in a controlled test. | DM creation/sending/attachment writes fail with the expected disabled/permission response and do not create new data. |
