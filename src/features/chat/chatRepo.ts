/**
 * Group chat over HTTP.
 *
 * History and sending both work here, with no socket involved - which is the whole
 * point: the real-time channel is an optimisation, so a member whose socket never
 * connects (a firewall, an old device, a backgrounded app) can still read and post.
 * `useGroupChat` prefers the socket and falls back to these functions.
 *
 * Two API outcomes are named rather than left as raw errors, because the chat screen
 * treats them as *states* instead of failures:
 *
 *   * a `403`/`404` (`forbidden` / `not_found`) means the member is not (or no
 *     longer) an active member of the group. `GroupChatUnavailableError` turns that
 *     into "members only" copy rather than a retry button.
 *   * `group_archived` means the room is closed but the history is readable:
 *     `isChatClosedError` distinguishes it from a transport failure.
 */
import { apiRequest } from '../../lib';
import { CHAT_PAGE_SIZE, type ChatMessage, type ChatMessagePage } from '../../types';

/** One message as it arrives on the wire. Every field is optional: it is untrusted. */
interface MessagePayload {
  id?: string;
  groupId?: string;
  senderId?: string;
  senderName?: string;
  body?: string;
  createdAt?: string;
  isYou?: boolean;
}

interface MessagePagePayload {
  page?: {
    messages?: MessagePayload[] | null;
    hasMore?: boolean;
    nextCursor?: string | null;
  };
}

/** The API refused because this member may not read or post in that room. */
export class GroupChatUnavailableError extends Error {
  constructor(message = 'Group chat is for active members of the group.') {
    super(message);
    this.name = 'GroupChatUnavailableError';
  }
}

function mapMessage(payload: MessagePayload): ChatMessage {
  return {
    id: String(payload.id ?? ''),
    groupId: String(payload.groupId ?? ''),
    senderId: String(payload.senderId ?? ''),
    senderName: String(payload.senderName ?? 'Member'),
    body: String(payload.body ?? ''),
    createdAt: String(payload.createdAt ?? ''),
    isYou: payload.isYou === true,
  };
}

/** True for the API codes that mean "not allowed", as opposed to "did not work". */
export function isChatAccessError(caught: unknown): boolean {
  const code = (caught as { code?: unknown } | null)?.code;
  return code === 'forbidden' || code === 'not_found';
}

/** True for the archived-group refusal, which is a state rather than a failure. */
export function isChatClosedError(caught: unknown): boolean {
  return (caught as { code?: unknown } | null)?.code === 'group_archived';
}

/**
 * One page of history, oldest first.
 *
 * `before` is the id of the oldest message already on screen. A cursor rather than
 * an offset, because messages arrive while a member scrolls.
 */
export async function fetchGroupMessages(
  groupId: string,
  options: { limit?: number; before?: string | null } = {},
): Promise<ChatMessagePage> {
  const limit = Math.min(Math.max(options.limit ?? CHAT_PAGE_SIZE, 1), 100);
  const query: Record<string, string | number> = { limit };
  if (options.before) query.before = options.before;

  try {
    const payload = await apiRequest<MessagePagePayload>(`/api/groups/${groupId}/messages`, { query });
    const page = payload?.page;

    return {
      messages: (page?.messages ?? []).map(mapMessage).filter((message) => message.id.length > 0),
      hasMore: page?.hasMore === true,
      nextCursor: page?.nextCursor ?? null,
    };
  } catch (caught) {
    if (isChatAccessError(caught)) throw new GroupChatUnavailableError();
    throw caught;
  }
}

/**
 * Posts one message and returns the row the server stored.
 *
 * The id is a *client* id used only so a retry cannot post the same sentence twice:
 * the server's unique index resolves a repeat to the row that already exists, and
 * either way the returned message carries the server's own id, body and timestamp.
 */
export async function postGroupMessage(
  groupId: string,
  body: string,
  clientMessageId: string,
): Promise<ChatMessage> {
  try {
    const payload = await apiRequest<{ message?: MessagePayload }>(`/api/groups/${groupId}/messages`, {
      method: 'POST',
      body: { body, clientMessageId },
    });

    if (!payload?.message) throw new Error('That message could not be sent. Try again.');
    return mapMessage(payload.message);
  } catch (caught) {
    if (isChatAccessError(caught) || isChatClosedError(caught)) throw caught;
    throw caught;
  }
}

/**
 * A UUID-shaped idempotency key.
 *
 * Not a secret and not an identifier anyone else sees: its only job is to be
 * different for every message the client *intends* to send and identical across
 * retries of that one message. `crypto.randomUUID` is used when the platform has it
 * and a `Math.random` fallback is used when it does not - the consequence of a
 * collision would be one lost message, and the shape the API validates is the same.
 */
export function newClientMessageId(): string {
  const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID();

  const hex = (length: number): string =>
    Array.from({ length }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)] ?? '0').join('');

  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}
