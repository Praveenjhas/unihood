/**
 * The Socket.IO server: connection authentication, room authorization and message
 * delivery.
 *
 * Four rules shape this file, and each one is a deliberate refusal:
 *
 *   1. **The handshake carries the access token, and nothing else is trusted.**
 *      `auth.token` is verified with the *same* function HTTP uses
 *      (`resolveTokenCaller`), so a socket cannot exist on a token an endpoint would
 *      reject, and a user id sent by the client is never read at all. A refused
 *      handshake answers with an `unauthorized` / `session_expired` error and never
 *      opens a connection.
 *   2. **Joining a room is an authorization decision.** `group:join` looks the group
 *      up and checks the caller's membership through `chatService` - not through a
 *      client-supplied group id. Only after that does the socket join the room, so
 *      a private group's chat is not merely quiet for a non-member, it is absent.
 *   3. **Sending is authorized again, every time.** `message:send` calls the same
 *      `sendGroupMessage` the HTTP endpoint calls, which re-reads the membership and
 *      re-checks the session. Room membership short-cuts nothing: a socket that was
 *      somehow left in a room still cannot write to it.
 *   4. **An io instance is optional.** `attachRealtime` is called by `server.ts`
 *      only; every service works without it, and `realtime/hub.ts` treats "no
 *      server" as "nothing to broadcast" rather than an error.
 *   5. **A send pays for itself first.** `message:send` spends the member's message
 *      budget before it even reads the payload, from the *same* allowance the HTTP
 *      route spends (`middleware/messageLimit.ts`), so a client cannot buy more by
 *      switching transport. An exhausted budget is answered through this event's
 *      acknowledgement - never by dropping the connection.
 *
 * The client never has to *infer* success: every client -> server event carries an
 * acknowledgement callback, so the mobile screen can await a real answer (the
 * committed message, or the refusal) instead of watching for a broadcast.
 */
import type { Server as HttpServer } from 'node:http';

import { Server } from 'socket.io';

import { env } from '../config/env';
import { REALTIME_PATH, REALTIME_SESSION_SWEEP_MS, REALTIME_EVENTS, groupRoom } from '../domain/chat';
import { isAppError } from '../lib/errors';
import { messageBudgetError, spendMessageBudget } from '../middleware/messageLimit';
import { resolveTokenCaller, sessionIsAlive } from '../middleware/requireAuth';
import { getChatAccess, sendGroupMessage, type ChatMessage } from '../services/chatService';
import { registerRealtimeServer } from './hub';

/** What the client sends, and what it can expect back. Names mirror `REALTIME_EVENTS`. */
interface ClientToServerEvents {
  'group:join': (payload: unknown, acknowledge?: (response: SocketAck) => void) => void;
  'group:leave': (payload: unknown, acknowledge?: (response: SocketAck) => void) => void;
  'message:send': (payload: unknown, acknowledge?: (response: SocketAck) => void) => void;
}

interface ServerToClientEvents {
  'message:created': (message: ChatMessage) => void;
  'chat:refused': (refusal: SocketRefusal) => void;
}

interface SocketData {
  userId: string;
  sessionId: string;
}

/** The acknowledgement shape. `ok: false` always carries a stable API error code. */
export type SocketAck =
  | { ok: true; groupId?: string; access?: { role: string; archived: boolean }; message?: ChatMessage }
  /** `retryAfterSeconds` is set by the message budget, exactly as it is over HTTP. */
  | { ok: false; code: string; message: string; retryAfterSeconds?: number };

/** Emitted to a client that gave no acknowledgement callback. */
export interface SocketRefusal {
  code: string;
  message: string;
}

function asString(value: unknown, key: string): string {
  const raw = (value as Record<string, unknown> | null)?.[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Turns anything thrown by a service into the API's own error vocabulary. */
function toRefusal(caught: unknown): SocketRefusal {
  if (isAppError(caught)) return { code: caught.code, message: caught.message };
  return { code: 'internal_error', message: 'That did not work. Try again in a moment.' };
}

/**
 * Attaches the real-time server to an existing HTTP server.
 *
 * Sharing the HTTP listener (rather than opening a second port) is what makes this
 * deployable behind one URL and one certificate: `/realtime` is an upgrade on the
 * same host the REST API already answers on.
 */
export function attachRealtime(httpServer: HttpServer): Server {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    path: REALTIME_PATH,
    // Same origin policy as the REST API, from the same configuration.
    cors: { origin: corsOrigins(), credentials: false },
    // The client's own reconnect budget: a member who loses signal for a few
    // minutes finds the conversation again without reloading the app.
    pingTimeout: 20_000,
    pingInterval: 25_000,
  });

  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;

    if (typeof token !== 'string' || token.trim().length === 0) {
      next(Object.assign(new Error('unauthorized'), { data: { code: 'unauthorized' } }));
      return;
    }

    try {
      const claims = await resolveTokenCaller(token.trim());
      socket.data.userId = claims.userId;
      socket.data.sessionId = claims.sessionId;
      next();
    } catch (caught) {
      const refusal = toRefusal(caught);
      next(Object.assign(new Error(refusal.code), { data: refusal }));
    }
  });

  attachHandlers(io);
  startSessionSweep(io);
  registerRealtimeServer(io);

  return io;
}

function corsOrigins(): true | string[] {
  const allowed = env.http.corsAllowedOrigins;
  if (allowed.length === 0 || allowed.includes('*')) return true;
  return [...allowed];
}

/**
 * The three client -> server events.
 *
 * Each handler answers through the acknowledgement callback when the client sent
 * one, and otherwise emits `chat:refused`. Every path through them either joins a
 * room, leaves a room, or delegates the write to `chatService` - so there is no
 * code here that can decide, on its own, that something is allowed.
 */
function attachHandlers(io: Server): void {
  io.on('connection', (socket) => {
    const { userId, sessionId } = socket.data;

    const reply = (acknowledge: ((response: SocketAck) => void) | undefined, ack: SocketAck): void => {
      if (typeof acknowledge === 'function') acknowledge(ack);
      else if (!ack.ok) socket.emit(REALTIME_EVENTS.refused, { code: ack.code, message: ack.message });
    };

    /** Nothing below runs on a session that has since been revoked. */
    const requireLiveSession = async (): Promise<SocketAck | null> => {
      if (await sessionIsAlive(sessionId, userId)) return null;
      return { ok: false, code: 'session_expired', message: 'Your session has expired. Sign in again to continue.' };
    };

    /**
     * Answers a revoked session and then closes the connection.
     *
     * The order is deliberate: `disconnect` tears the transport down immediately, so
     * a refusal acknowledged *after* it would never reach the client. The refusal goes
     * out first, and the close follows a moment later - the socket does not get to
     * keep receiving, and the member still learns why.
     */
    const refuseDeadSession = (acknowledge: ((response: SocketAck) => void) | undefined, refusal: SocketAck): void => {
      reply(acknowledge, refusal);
      setTimeout(() => socket.disconnect(true), 250);
    };

    socket.on(REALTIME_EVENTS.join, (payload, acknowledge) => {
      void (async () => {
        const expired = await requireLiveSession();
        if (expired) {
          refuseDeadSession(acknowledge, expired);
          return;
        }

        const groupId = asString(payload, 'groupId');
        if (groupId.length === 0) {
          reply(acknowledge, { ok: false, code: 'validation_error', message: 'That room is not valid.' });
          return;
        }

        try {
          // The same read the HTTP history endpoint performs: an active membership
          // or nothing, and a nonexistent group is a plain "not found".
          const access = await getChatAccess(userId, groupId);

          // An archived group's room is closed: nothing can be posted to it, so
          // there is nothing to listen for. The history stays available over HTTP -
          // closing the live channel is not the same as hiding what was said.
          if (access.archived) {
            reply(acknowledge, {
              ok: false,
              code: 'group_archived',
              message: 'That group has been archived, so its chat is closed. Its history is still readable.',
            });
            return;
          }

          await socket.join(groupRoom(access.groupId));
          reply(acknowledge, {
            ok: true,
            groupId: access.groupId,
            access: { role: access.role, archived: access.archived },
          });
        } catch (caught) {
          reply(acknowledge, { ok: false, ...toRefusal(caught) });
        }
      })();
    });

    socket.on(REALTIME_EVENTS.leave, (payload, acknowledge) => {
      void (async () => {
        const groupId = asString(payload, 'groupId');
        if (groupId.length > 0) await socket.leave(groupRoom(groupId));
        reply(acknowledge, { ok: true, groupId });
      })();
    });

    socket.on(REALTIME_EVENTS.send, (payload, acknowledge) => {
      void (async () => {
        const expired = await requireLiveSession();
        if (expired) {
          refuseDeadSession(acknowledge, expired);
          return;
        }

        // The member's message budget, spent *before* the payload is even read: it
        // is the same allowance `POST /api/groups/:id/messages` spends, so a client
        // cannot buy more by switching transport, and it is the same place in the
        // sequence (identity, then budget, then validation and the write). A refusal
        // here answers this event and nothing else - the connection stays up, the
        // member keeps their room, and a legitimate burst of typing slows down
        // rather than being disconnected.
        const budget = spendMessageBudget(userId);
        if (!budget.allowed) {
          const refusal = messageBudgetError(budget.retryAfterSeconds);
          reply(acknowledge, {
            ok: false,
            code: refusal.code,
            message: refusal.message,
            retryAfterSeconds: budget.retryAfterSeconds,
          });
          return;
        }

        const groupId = asString(payload, 'groupId');
        const body = (payload as Record<string, unknown> | null)?.body;
        const clientMessageId = (payload as Record<string, unknown> | null)?.clientMessageId;

        if (groupId.length === 0) {
          reply(acknowledge, { ok: false, code: 'validation_error', message: 'That room is not valid.' });
          return;
        }

        try {
          // Shared with `POST /api/groups/:id/messages`: one write path, one set of
          // rules, and the broadcast happens inside the service after the commit.
          const message: ChatMessage = await sendGroupMessage(
            userId,
            groupId,
            body,
            typeof clientMessageId === 'string' ? clientMessageId : null,
          );
          reply(acknowledge, { ok: true, groupId, message });
        } catch (caught) {
          reply(acknowledge, { ok: false, ...toRefusal(caught) });
        }
      })();
    });
  });
}

/**
 * Disconnects sockets whose session has been revoked or expired.
 *
 * The per-event checks above already stop a dead session from *doing* anything; this
 * stops it from *hearing* anything. It is the real-time half of "sign out everywhere"
 * and of an account being disabled, and it never guesses: the check is the same
 * `refresh_sessions` lookup every HTTP request performs.
 */
function startSessionSweep(io: Server): void {
  const timer = setInterval(() => {
    void (async () => {
      for (const socket of io.sockets.sockets.values()) {
        const { userId, sessionId } = socket.data ?? {};
        if (typeof userId !== 'string' || typeof sessionId !== 'string') continue;

        try {
          if (!(await sessionIsAlive(sessionId, userId))) socket.disconnect(true);
        } catch {
          // A database blip must not disconnect every member; the next sweep tries
          // again, and every event already re-checks for itself.
        }
      }
    })();
  }, REALTIME_SESSION_SWEEP_MS);

  // Node must be able to exit while the API is idle: an interval keeps the event
  // loop alive on its own, which would break `SIGINT` shutdown in `server.ts`.
  timer.unref();
}

