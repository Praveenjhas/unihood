/**
 * The real-time transport, wrapped in one small object.
 *
 * Socket.IO is used because the API is already a Node HTTP server and Socket.IO
 * attaches to it (see `backend/src/realtime/socket.ts`) without a second port, a
 * second certificate or a second authorisation model: the handshake carries the
 * same access token every REST call carries, and the server verifies it with the
 * same code path.
 *
 * What this module owns:
 *
 *   * **the token, per attempt.** `auth` is a function, so every (re)connection
 *     resolves a *fresh* token and renews it first when it is close to expiry. A
 *     member whose access token expired while the app was backgrounded reconnects
 *     silently instead of being signed out by the socket.
 *   * **the room join.** Joining happens on every `connect` and is *asked for*, not
 *     assumed: the server checks membership and answers through an acknowledgement,
 *     so "joined" is never inferred from "connected".
 *   * **a single send path.** `send` resolves with the committed message, or rejects
 *     with the refusal, so the screen never has to watch for its own echo.
 *
 * It deliberately knows nothing about React: `useGroupChat` holds the state.
 */
import { io, type Socket } from 'socket.io-client';

import { env, isBackendConfigured, readSession, renewSession } from '../../lib';
import type { ChatConnectionState, ChatMessage, ChatMessageBroadcast } from '../../types';

/** Mirrors `REALTIME_PATH` in `backend/src/domain/chat.ts`. */
const REALTIME_PATH = '/realtime';

/** Mirrors `REALTIME_EVENTS` in `backend/src/domain/chat.ts`. */
const EVENTS = {
  join: 'group:join',
  leave: 'group:leave',
  send: 'message:send',
  created: 'message:created',
  refused: 'chat:refused',
} as const;

/** Renew an access token this long before it expires, rather than mid-room. */
const RENEW_SKEW_MS = 60_000;

/** What the join acknowledgement carries. */
interface JoinAck {
  ok?: boolean;
  code?: string;
  message?: string;
}

/** What the send acknowledgement carries. */
interface SendAck {
  ok?: boolean;
  code?: string;
  message?: string | unknown;
  groupId?: string;
}

export interface ChatSocketHandlers {
  onState: (state: ChatConnectionState) => void;
  /** A message the server has already committed and broadcast. */
  onMessage: (message: ChatMessageBroadcast) => void;
  /** A refusal the server sent without an acknowledgement to answer. */
  onRefusal: (code: string, message: string) => void;
}

export interface ChatSocketHandle {
  /** Asks the server to add this socket to a group's room. */
  join: (groupId: string) => void;
  /** Sends through the socket. Rejects when the socket is not joined/connected. */
  send: (groupId: string, body: string, clientMessageId: string) => Promise<ChatMessage>;
  /** Leaves the room and closes the connection. */
  close: () => void;
}

/** Error thrown when the socket cannot be used, so the caller can fall back to HTTP. */
export class ChatSocketUnavailableError extends Error {
  constructor(message = 'The chat connection is not ready.') {
    super(message);
    this.name = 'ChatSocketUnavailableError';
  }
}

/** True for codes that mean "this member may not be here" rather than "retry". */
function isAccessCode(code: string | undefined): boolean {
  return code === 'forbidden' || code === 'not_found' || code === 'group_archived';
}

/**
 * The token for one connection attempt.
 *
 * An empty string is returned rather than throwing when there is no session: the
 * handshake will fail, `connect_error` will fire, and the hook's own session state
 * is what decides whether the member is signed out. Renewal failures are swallowed
 * for the same reason - the socket simply tries again with what it has.
 */
async function resolveToken(): Promise<string> {
  try {
    const session = await readSession();
    if (!session) return '';

    const expiresAt = Date.parse(session.accessTokenExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() < RENEW_SKEW_MS) {
      const renewed = await renewSession();
      return renewed?.accessToken ?? session.accessToken;
    }

    return session.accessToken;
  } catch {
    return '';
  }
}

function mapBroadcast(payload: unknown): ChatMessageBroadcast | null {
  const source = payload as Partial<ChatMessageBroadcast> | null;
  if (!source || typeof source.id !== 'string' || source.id.length === 0) return null;

  return {
    id: source.id,
    groupId: String(source.groupId ?? ''),
    senderId: String(source.senderId ?? ''),
    senderName: String(source.senderName ?? 'Member'),
    body: String(source.body ?? ''),
    createdAt: String(source.createdAt ?? new Date().toISOString()),
  };
}

function toMessage(payload: unknown, isYou: boolean): ChatMessage | null {
  const broadcast = mapBroadcast(payload);
  return broadcast === null ? null : { ...broadcast, isYou };
}

/**
 * Opens the connection.
 *
 * Returns `null` when the app has no API base URL: there is nothing to connect to,
 * and history/sending over HTTP are unavailable in that configuration too, so the
 * screen is showing its setup state anyway.
 */
export function openChatSocket(handlers: ChatSocketHandlers): ChatSocketHandle | null {
  if (!isBackendConfigured || env.apiBaseUrl.length === 0) return null;

  const socket: Socket = io(env.apiBaseUrl, {
    path: REALTIME_PATH,
    // WebSocket first, with polling as the fallback for a network that blocks the
    // upgrade. Both are the same Socket.IO server, so both are authenticated.
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4_000,
    timeout: 8_000,
    // A function, so each attempt resolves a fresh token (see `resolveToken`).
    auth: (callback: (data: Record<string, unknown>) => void) => {
      void resolveToken().then((token) => callback({ token }));
    },
  });

  let groupId: string | null = null;
  let isJoined = false;

  const joinRoom = (): void => {
    if (groupId === null) return;

    socket.emit(EVENTS.join, { groupId }, (ack: JoinAck) => {
      if (ack?.ok === true) {
        isJoined = true;
        handlers.onState('live');
        return;
      }

      isJoined = false;
      if (isAccessCode(ack?.code)) {
        handlers.onState('blocked');
        socket.disconnect();
        return;
      }
      handlers.onState('offline');
    });
  };

  socket.on('connect', () => {
    handlers.onState('connecting');
    // Every connect asks again: reconnection is a new authorization, not a
    // continuation of the previous one.
    joinRoom();
  });

  socket.on('disconnect', () => {
    isJoined = false;
    handlers.onState('offline');
  });

  socket.on('connect_error', (error: Error) => {
    const code = (error as { data?: { code?: string } }).data?.code;

    if (code === 'unauthorized' || code === 'session_expired') {
      // One renewal attempt. If the session cannot be renewed it is gone (signed
      // out elsewhere, or the account was disabled), and retrying forever would be
      // both pointless and impolite - so the socket stops and the screen says so.
      void renewSession(true)
        .then((session) => {
          if (!session) {
            socket.disconnect();
            handlers.onState('blocked');
          }
        })
        .catch(() => handlers.onState('offline'));
      return;
    }

    handlers.onState('offline');
  });

  socket.on(EVENTS.created, (payload: unknown) => {
    const message = mapBroadcast(payload);
    if (message !== null) handlers.onMessage(message);
  });

  socket.on(EVENTS.refused, (payload: unknown) => {
    const refusal = payload as { code?: string; message?: string } | null;
    handlers.onRefusal(String(refusal?.code ?? 'internal_error'), String(refusal?.message ?? 'That did not work.'));
  });

  return {
    /**
     * Switches the socket to a group's room.
     *
     * Called on mount and whenever the screen's group changes. Leaving the previous
     * room matters: one connection is reused for every group a member opens, and a
     * socket left in an old room would keep receiving its messages.
     */
    join: (nextGroupId: string) => {
      if (groupId === nextGroupId) {
        if (socket.connected && !isJoined) joinRoom();
        return;
      }

      if (groupId !== null) socket.emit(EVENTS.leave, { groupId });
      groupId = nextGroupId;
      isJoined = false;

      if (socket.connected) joinRoom();
    },

    send: (targetGroupId: string, body: string, clientMessageId: string) =>
      new Promise<ChatMessage>((resolve, reject) => {
        // Not connected, or not joined to this room: refuse immediately so the
        // caller falls back to the HTTP write instead of hanging on an ack that
        // will never come.
        if (!socket.connected || !isJoined) {
          reject(new ChatSocketUnavailableError());
          return;
        }

        socket.emit(EVENTS.send, { groupId: targetGroupId, body, clientMessageId }, (ack: SendAck) => {
          if (ack?.ok === true) {
            const message = toMessage(ack.message, true);
            if (message === null) {
              reject(new Error('The server confirmed a message it did not describe.'));
              return;
            }
            // The ack carries the *committed* row, so resolving here is the moment
            // the message is known to be stored - not the moment it was typed.
            resolve(message);
            return;
          }

          if (isAccessCode(ack?.code)) {
            isJoined = false;
            handlers.onState('blocked');
          }

          const error = new Error(
            typeof ack?.message === 'string' ? ack.message : 'That message could not be sent.',
          );
          (error as Error & { code?: string }).code = ack?.code ?? 'internal_error';
          reject(error);
        });
      }),

    close: () => {
      if (groupId !== null) socket.emit(EVENTS.leave, { groupId });
      socket.removeAllListeners();
      socket.disconnect();
      groupId = null;
      isJoined = false;
    },
  };
}


