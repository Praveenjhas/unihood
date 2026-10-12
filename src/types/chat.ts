/**
 * The group-chat vocabulary and the API's message shapes.
 *
 * The limits and the page size mirror `backend/src/domain/chat.ts` so the composer
 * counts against the same bound the server enforces, and a message the UI allows is
 * a message the API accepts.
 *
 * Timestamps arrive as UTC ISO strings and are rendered with the `formatInstant*`
 * helpers in `src/lib/date`, exactly like events.
 */

/** The longest message the API stores. Mirrors the `CHECK` on `group_messages.body`. */
export const CHAT_MESSAGE_MAX_LENGTH = 1000;

/** Rows per history request; matches the server's page size. */
export const CHAT_PAGE_SIZE = 30;

/**
 * One message, as the API describes it to the member who asked for it.
 *
 * `isYou` is the server's own answer, computed from the session it authenticated -
 * the client never has to decide which bubbles are its own. A *broadcast* arrives
 * without that field (one emit goes to the whole room), so the client fills it in
 * from `senderId` and its own id; see `useGroupChat`.
 */
export interface ChatMessage {
  id: string;
  groupId: string;
  senderId: string;
  senderName: string;
  body: string;
  /** UTC ISO instant; render with the `formatInstant*` helpers. */
  createdAt: string;
  isYou: boolean;
}

/** A message as it arrives over the socket: the same shape, minus `isYou`. */
export type ChatMessageBroadcast = Omit<ChatMessage, 'isYou'>;

/**
 * One page of history, oldest first.
 *
 * `nextCursor` is the id of the oldest message in the page and is what `loadOlder`
 * sends back as `before`. A cursor rather than an offset because messages arrive
 * while the member is reading: an offset would re-serve rows every time somebody
 * typed.
 */
export interface ChatMessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * What the real-time channel is doing, as the screen needs to describe it.
 *
 *   `connecting` - the first attempt, or a reconnect, is in flight.
 *   `live`       - connected and joined to this group's room.
 *   `offline`    - not connected. History still works over HTTP, so the screen keeps
 *                  reading and offering Send (which falls back to the HTTP write).
 *   `blocked`    - the server refused: the session is gone, or the member may not
 *                  read this room. Retrying would be dishonest, so the screen says
 *                  so instead.
 */
export type ChatConnectionState = 'connecting' | 'live' | 'offline' | 'blocked';

/**
 * Merges a batch of messages into a thread, keeping it newest-last and deduplicated.
 *
 * This is the one place that decides what "already have it" means, and it is a pure
 * function on purpose: a message can arrive twice - once as the HTTP response to
 * Send and once as the socket broadcast to the whole room - and the member must see
 * it once. Ordering is by `createdAt` with the id as tiebreak, which is the same
 * order the server uses, so an inserted page never shuffles the thread.
 */
export function mergeChatMessages(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);

  return [...byId.values()].sort((left, right) => {
    if (left.createdAt === right.createdAt) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    return left.createdAt < right.createdAt ? -1 : 1;
  });
}

/** True when a body is worth sending, and short enough for the API to accept. */
export function chatBodyProblem(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return 'Write a message before sending it.';
  if (trimmed.length > CHAT_MESSAGE_MAX_LENGTH) {
    return `Keep a message to ${CHAT_MESSAGE_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}
