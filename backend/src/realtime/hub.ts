/**
 * The real-time hub.
 *
 * One job: hold a reference to the Socket.IO server so that ordinary service code
 * can say "this member may no longer read this group's chat" or "this message is
 * committed - tell the room", without importing the socket layer (and therefore
 * without a cycle between services and transports).
 *
 * Two properties are deliberate:
 *
 *   * **Every function here is safe when no real-time server is attached.** The
 *     HTTP API must work exactly as well without sockets - and it has to, because
 *     the smoke suite, `tsx` scripts and any future worker all import the services
 *     without ever creating a socket server. A null check is the whole reason this
 *     module exists as a separate, dependency-free leaf.
 *   * **Eviction is membership-driven, not client-driven.** `evictUserFromGroup`
 *     removes a member's sockets from a group's room when *the server* decides
 *     their access ended (a leave, a removal, an archive), so a client that keeps
 *     its socket open and simply never re-joins still stops receiving messages.
 *     Room membership is never treated as authorization on its own: every send is
 *     re-checked against the database (see `chatService`), so even a socket that
 *     was somehow left in a room cannot write to it.
 */
import type { Server } from 'socket.io';

import { REALTIME_EVENTS, groupRoom } from '../domain/chat';

/** The attached server, or `null` when this process runs HTTP only. */
let server: Server | null = null;

export function registerRealtimeServer(instance: Server | null): void {
  server = instance;
}

/** True when a real-time server is attached - reported by the health endpoint. */
export function isRealtimeAttached(): boolean {
  return server !== null;
}

/**
 * Publishes a committed message to everyone currently in the group's room.
 *
 * Called *after* the insert has committed, and only with the row the database
 * accepted, so a listener never sees a message it cannot then fetch over HTTP.
 * The sender is in the room too, which is what lets one code path serve every
 * connected member - the client recognises its own echo by sender id and by the
 * message id it already has, so nothing is duplicated on screen.
 */
export function broadcastGroupMessage(groupId: string, message: unknown): void {
  server?.to(groupRoom(groupId)).emit(REALTIME_EVENTS.created, message);
}

/**
 * Removes one member's sockets from one group's room.
 *
 * Returns the number of sockets that were removed, which is what makes this
 * testable from the smoke suite through a real HTTP-driven revocation.
 */
export function evictUserFromGroup(groupId: string, userId: string): number {
  if (!server) return 0;

  const room = groupRoom(groupId);
  let removed = 0;

  for (const socket of server.sockets.sockets.values()) {
    if (socket.data?.userId !== userId) continue;
    if (!socket.rooms.has(room)) continue;
    socket.leave(room);
    removed += 1;
  }

  return removed;
}

/**
 * Empties a group's room.
 *
 * Used when the room itself closes - the group was archived - so no connected
 * member keeps waiting for messages that can no longer be written. Members still
 * read the history over HTTP: closing the room is about the *live* channel, not
 * about hiding what was said.
 */
export function evictGroupRoom(groupId: string): number {
  if (!server) return 0;

  const room = groupRoom(groupId);
  const members = server.sockets.adapter.rooms.get(room);
  if (!members) return 0;

  let removed = 0;
  for (const socketId of [...members]) {
    const socket = server.sockets.sockets.get(socketId);
    if (!socket) continue;
    socket.leave(room);
    removed += 1;
  }

  return removed;
}

/**
 * Removes a member's sockets from every chat room.
 *
 * Used when access is lost wholesale - the account was disabled, or signed out
 * everywhere - so no socket outlives the session that authorised it.
 */
export function evictUserFromEveryGroup(userId: string): number {
  if (!server) return 0;

  let removed = 0;
  for (const socket of server.sockets.sockets.values()) {
    if (socket.data?.userId !== userId) continue;
    for (const room of [...socket.rooms]) {
      if (room === socket.id) continue;
      socket.leave(room);
      removed += 1;
    }
  }

  return removed;
}
