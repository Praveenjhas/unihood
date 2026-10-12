/**
 * Group chat — the repository, the real-time transport, the hook and the UI.
 *
 * The screen in `app/group/chat/[id].tsx` composes the three: it fetches the group
 * (for its name and archived state), holds `useGroupChat`, and renders `ChatThread`
 * in the body with `ChatComposer` in the pinned footer.
 */
export { ChatComposer, ChatThread, type ChatComposerProps, type ChatThreadProps } from './ChatThread';
export {
  GroupChatUnavailableError,
  fetchGroupMessages,
  isChatAccessError,
  isChatClosedError,
  newClientMessageId,
  postGroupMessage,
} from './chatRepo';
export { ChatSocketUnavailableError, openChatSocket, type ChatSocketHandle, type ChatSocketHandlers } from './chatSocket';
export { useGroupChat, type ChatThreadStatus, type GroupChatValue } from './useGroupChat';
