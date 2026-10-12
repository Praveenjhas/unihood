/**
 * The chat vocabulary, the room naming and the transport constants.
 *
 * The single source of truth for what a group message may be, in the same spirit
 * as `domain/groups.ts` and `domain/events.ts`: the database renders the
 * length bound as a `CHECK` (migration `0011`), the zod schemas at the edge are
 * built from these numbers, `services/chatService.ts` is written against them,
 * and the socket layer in `realtime/socket.ts` reuses the literal room name and
 * event names below rather than spelling them again.
 *
 * This module holds no SQL and no I/O, so the rules can be reasoned about on their
 * own - and so the mobile app can be checked against the same numbers.
 */

/** The longest message the API stores. Mirrors the `CHECK` on `group_messages.body`. */
export const MESSAGE_MAX_LENGTH = 1000;

/**
 * The smallest message that is not empty *after trimming*.
 *
 * A body of spaces is rejected by the service rather than stored as a message
 * nobody can read, which is why the bound is `>= 1` on the trimmed value and not
 * on the raw one.
 */
export const MESSAGE_MIN_LENGTH = 1;

/** One page of history. Smaller than a directory page: a chat screen loads often. */
export const MESSAGE_PAGE_SIZE = 30;
export const MAX_MESSAGE_PAGE_SIZE = 100;

/**
 * The path the Socket.IO server listens on.
 *
 * A dedicated path rather than `/` so the real-time upgrade can never be confused
 * with a REST route, and so a reverse proxy can be told about exactly one prefix.
 * Must match what the mobile client connects with (`src/features/chat/chatSocket.ts`).
 */
export const REALTIME_PATH = '/realtime';

/**
 * The socket event names, in one place.
 *
 * Namespaced with a colon on purpose: a bare `join` or `error` collides with
 * Socket.IO's own reserved events, and `error` in particular is emitted by the
 * library itself. These are the *only* events the chat speaks, so a client cannot
 * ask the server for anything the HTTP API does not also allow.
 */
export const REALTIME_EVENTS = {
  /** Client -> server: "add me to this group's chat, if I may". */
  join: 'group:join',
  /** Client -> server: "remove me from this group's chat". */
  leave: 'group:leave',
  /** Client -> server: "persist this message and tell the group". */
  send: 'message:send',
  /** Server -> room: "this message is committed; here it is, with its id". */
  created: 'message:created',
  /** Server -> one client: a refusal, carrying the API's own error code. */
  refused: 'chat:refused',
} as const;

/**
 * The room name for a group.
 *
 * One room per group, and the group id is the whole name - so a socket can be in
 * several group rooms at once without any bookkeeping, and "remove this user from
 * this group's room" is a single `leave` call (see `realtime/hub.ts`).
 */
export function groupRoom(groupId: string): string {
  return `group:${groupId}`;
}

/**
 * How often connected sockets are re-checked against their session.
 *
 * A socket is authorised once, at connect, against the same session row an HTTP
 * request uses. That is enough for every request *made by* the socket, because each
 * one is re-checked (see `realtime/socket.ts`), but an idle socket in a group room
 * would otherwise keep receiving messages after a sign-out elsewhere. This sweep
 * closes that window: every connected socket whose session has been revoked or
 * expired is disconnected with `session_expired`, and the client's own reconnect
 * path then either re-authenticates with a fresh token or signs the member out.
 *
 * A minute is deliberately unhurried: the sweep is one indexed lookup per socket,
 * and the case it covers is "the member is not using the app".
 */
export const REALTIME_SESSION_SWEEP_MS = 60_000;
