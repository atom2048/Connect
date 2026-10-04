// Compatibility barrel for page render functions.
// Implementations are split by screen area under ./pageModules/.
export { renderLoginPage, renderForgotPasswordPage, renderResetPasswordPage } from './pageModules/auth.ts';
export { renderFeedPage } from './pageModules/home.ts';
export {
  renderProfilePage,
  renderBookmarksPage,
  renderDraftsPage,
  renderSettingsPage,
  renderUserMentionRedirectPage,
} from './pageModules/profile.ts';
export { renderFriendsPage } from './pageModules/friends.ts';
export {
  renderExplorePage,
  renderNotificationsPage,
  renderPostDetailPage,
  renderFollowersPage,
  renderFollowingPage,
  renderFriendsListPage,
} from './pageModules/explore.ts';
