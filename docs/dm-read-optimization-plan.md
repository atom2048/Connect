# DM Read Optimization Plan

> Archived historical document. DM is retired; the read/write optimization described here is no longer an active implementation target. See `docs/retirement-search-runbook.md` for the current compatibility and shutdown contract.

## Current Behavior

`markMessagesAsRead()` reads the latest 50 messages in the conversation, skips messages sent by the current user, skips messages where `readBy` already contains the current user, and batch-updates only the remaining visible unread messages. It also updates `conversations/{conversationId}.lastReadBy` as a lightweight conversation-level hint.

## Current Constraints

- Message read state is stored as a `readBy` array on each message.
- Firestore cannot efficiently query for "array does not contain current user".
- Old unread messages outside the latest 50 are not guaranteed to be marked read by the current implementation.
- Updating every historical message would recreate the previous read/write cost problem.

## Limits of `readBy` Arrays

`readBy` is simple and backward-compatible, but it becomes expensive when conversations grow. It also makes per-user unread queries awkward because Firestore supports `array-contains`, but not an efficient inverse query for users missing from the array.

## What Is Needed for Efficient Unread Marking

A per-user conversation state is needed so the app can mark a conversation read without scanning all messages. The state should be queryable by user and conversation, and should summarize unread state without touching every message document.

## Option A: `conversationParticipants/{uid}` State

Add a subcollection or map-like participant state per conversation, for example:

- `conversations/{conversationId}/participants/{uid}`
- `lastReadAt`
- `lastReadMessageId`
- `unreadCount`
- `updatedAt`

Reads become small because the app loads the participant state for the current user. Marking read updates one participant doc instead of many message docs.

## Option B: Conversation-Level `unreadCount` Map

Store unread counts on the conversation document, for example:

- `unreadCounts.{uid}`
- `lastReadAtByUser.{uid}`

This is fast to read with the conversation list, but large groups can make the conversation document grow and produce write contention.

## Migration Notes

- Keep existing `readBy` fallback until all clients understand the new state.
- Initialize participant state lazily when a conversation is opened.
- Do not backfill all old messages in one operation.
- For existing conversations, derive initial `lastReadAt` from current `lastReadBy` or from the first open after deployment.
- Use batched writes or transactions only where count consistency matters.

## Phase 3 Implementation Steps

1. Add optional participant read-state type and read helpers.
2. On message send, increment unread state for other participants.
3. On conversation open, update only the current user's participant read state.
4. Keep `readBy` updates for the latest visible messages as a temporary compatibility path.
5. Add perf logs for participant-state reads and unread count updates.
6. After compatibility is proven, reduce or remove message-level read updates for read receipts where acceptable.
