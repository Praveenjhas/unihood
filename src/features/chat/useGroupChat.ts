/**
 * The chat screen's state machine.
 *
 * One hook owns the thread, its pagination, the composer's state and the real-time
 * connection, so the screen above it stays declarative. Four rules are worth stating
 * because they are what make the experience honest:
 *
 *   1. **Nothing appears until the server says so.** A message is added to the thread
 *      only from the response to Send (the committed row) or from a broadcast - never
 *      optimistically. A failed send leaves the thread untouched and reports why; the
 *      text stays in the composer so nothing is retyped.
 *   2. **A message is shown once.** The sender receives both the acknowledgement and
 *      the room broadcast, so every insertion goes through `mergeChatMessages`, which
 *      is keyed by the server's message id.
 *   3. **Sending does not depend on the socket.** The socket is tried first and the
 *      HTTP endpoint is the fallback, so a member on a network that blocks WebSockets
 *      can still talk. Both paths hit the same server-side service.
 *   4. **A reconnect re-reads.** Rejoining the room is not enough - messages sent while
 *      the connection was down are not replayed by the server, so regaining the room
 *      fetches the newest page again and merges it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { describeError, toError } from '../../lib';
import { chatBodyProblem, mergeChatMessages, type ChatConnectionState, type ChatMessage } from '../../types';
import {
  GroupChatUnavailableError,
  fetchGroupMessages,
  isChatAccessError,
  newClientMessageId,
  postGroupMessage,
} from './chatRepo';
import { ChatSocketUnavailableError, openChatSocket, type ChatSocketHandle } from './chatSocket';

export type ChatThreadStatus = 'loading' | 'ready' | 'error' | 'blocked';

export interface GroupChatValue {
  messages: ChatMessage[];
  status: ChatThreadStatus;
  /** Set when the first page failed to load (and the thread is empty). */
  error: Error | null;
  hasMore: boolean;
  isLoadingOlder: boolean;
  /** Set when loading an older page failed, so the thread keeps what it has. */
  olderError: string | null;
  isSending: boolean;
  /** Set when the last send was refused, or when the text was not sendable. */
  sendError: string | null;
  connection: ChatConnectionState;
  /** Sends a message. Resolves true only when the server confirmed it. */
  send: (body: string) => Promise<boolean>;
  loadOlder: () => Promise<void>;
  retry: () => void;
}

export function useGroupChat(
  groupId: string,
  viewerId: string | null,
  options: { enabled?: boolean } = {},
): GroupChatValue {
  const { enabled = true } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatThreadStatus>('loading');
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ChatConnectionState>('connecting');
  const [attempt, setAttempt] = useState(0);

  const socketRef = useRef<ChatSocketHandle | null>(null);
  /** The viewer, readable inside socket callbacks without rebuilding the socket. */
  const viewerRef = useRef<string | null>(viewerId);
  /** Whether the thread has anything in it - used to seed pagination on recovery. */
  const hasContentRef = useRef(false);
  /** Whether the last socket state was `live`, so a *reconnect* can be told apart. */
  const wasLiveRef = useRef(false);

  /**
   * Identity of the room being read: the group, and whether the viewer may be in it.
   *
   * Changing it discards the previous thread *during render* - React's documented
   * pattern for adjusting state when an input changes - because an effect would let
   * one frame of the old room's messages reach the screen, which on a chat screen
   * means showing the wrong conversation.
   */
  const identity = `${groupId}|${enabled ? 'open' : 'closed'}`;
  const [currentIdentity, setCurrentIdentity] = useState(identity);

  if (currentIdentity !== identity) {
    setCurrentIdentity(identity);
    setMessages([]);
    setStatus('loading');
    setError(null);
    setHasMore(false);
    setNextCursor(null);
    setSendError(null);
    setOlderError(null);
    setConnection('connecting');
  }

  // The viewer id is read from socket callbacks only, never during render.
  useEffect(() => {
    viewerRef.current = viewerId;
  }, [viewerId]);

  // ---- the first page ------------------------------------------------------
  useEffect(() => {
    // A new room starts with an empty pagination flag, whatever the last one held.
    hasContentRef.current = false;

    // Nothing is fetched until the caller says the viewer may be here: a screen still
    // waiting on the group keeps its thread in `loading` rather than flashing a
    // "members only" state before it knows whether the viewer is a member.
    if (!enabled) return undefined;

    let active = true;

    void fetchGroupMessages(groupId)
      .then((page) => {
        if (!active) return;
        setMessages(page.messages);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
        hasContentRef.current = page.messages.length > 0;
        setStatus('ready');
      })
      .catch((caught) => {
        if (!active) return;
        setError(toError(caught));
        setStatus(caught instanceof GroupChatUnavailableError ? 'blocked' : 'error');
      });

    return () => {
      active = false;
    };
  }, [groupId, attempt, enabled]);

  /**
   * Re-reads the newest page and merges it.
   *
   * Used after regaining the room. It never *replaces* the thread: messages that
   * arrived while the connection was down are added, and everything already on screen
   * stays where it is.
   */
  const refreshNewest = useCallback(async (): Promise<void> => {
    try {
      const page = await fetchGroupMessages(groupId);
      if (!hasContentRef.current) {
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
      }
      if (page.messages.length > 0) hasContentRef.current = true;
      setMessages((current) => mergeChatMessages(current, page.messages));
      setStatus((current) => (current === 'blocked' ? current : 'ready'));
    } catch (caught) {
      // Best effort by design: a failed recovery fetch must not blank a thread that is
      // already on screen. The next reconnect tries again.
      if (caught instanceof GroupChatUnavailableError) setStatus('blocked');
    }
  }, [groupId]);

  // ---- the real-time channel ----------------------------------------------
  useEffect(() => {
    if (!enabled) return undefined;

    wasLiveRef.current = false;

    const handle = openChatSocket({
      onState: (next) => {
        // Only a *transition* back to live triggers the catch-up fetch; the initial
        // load already fetched the newest page.
        const recovered = next === 'live' && !wasLiveRef.current;
        wasLiveRef.current = next === 'live';
        setConnection(next);
        if (recovered) void refreshNewest();
      },
      onMessage: (message) => {
        // `isYou` is absent on a broadcast: one emit serves the whole room, so the
        // reader decides. The server's own answer still wins where it exists.
        const withViewer = { ...message, isYou: message.senderId === viewerRef.current };
        hasContentRef.current = true;
        setMessages((current) => mergeChatMessages(current, [withViewer]));
        setStatus((current) => (current === 'blocked' ? current : 'ready'));
      },
      onRefusal: (code, message) => {
        if (code === 'forbidden' || code === 'not_found') {
          setStatus('blocked');
          return;
        }
        setSendError(message);
      },
    });

    socketRef.current = handle;
    handle?.join(groupId);

    return () => {
      socketRef.current = null;
      handle?.close();
    };
  }, [groupId, refreshNewest, enabled]);

  /**
   * Loads the page before the oldest message on screen.
   *
   * Only the *new* rows are merged: the thread is a single ordered list, so an older
   * page lands above what is already there without anything jumping.
   */
  const loadOlder = useCallback(async (): Promise<void> => {
    if (nextCursor === null || isLoadingOlder) return;

    setIsLoadingOlder(true);
    setOlderError(null);

    try {
      const page = await fetchGroupMessages(groupId, { before: nextCursor });
      setMessages((current) => mergeChatMessages(current, page.messages));
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (caught instanceof GroupChatUnavailableError) setStatus('blocked');
      else setOlderError(describeError(caught));
    } finally {
      setIsLoadingOlder(false);
    }
  }, [groupId, isLoadingOlder, nextCursor]);

  /**
   * Sends one message.
   *
   * The socket is preferred and the HTTP endpoint is the fallback, and both are given
   * the *same* client-generated id - so if a socket send half-succeeded before the
   * connection dropped and the retry goes over HTTP, the server still resolves the two
   * attempts to one row.
   *
   * Resolving `true` means "the database has it": the caller clears the composer then
   * and only then.
   */
  const send = useCallback(
    async (rawBody: string): Promise<boolean> => {
      const problem = chatBodyProblem(rawBody);
      if (problem !== null) {
        setSendError(problem);
        return false;
      }

      const body = rawBody.trim();
      const clientMessageId = newClientMessageId();
      setIsSending(true);
      setSendError(null);

      try {
        const handle = socketRef.current;

        let message: ChatMessage;
        if (handle !== null && connection === 'live') {
          try {
            message = await handle.send(groupId, body, clientMessageId);
          } catch (caught) {
            // The socket was up when we checked and down when we sent. That is not a
            // failure the member should see: the HTTP write is the same operation.
            if (caught instanceof ChatSocketUnavailableError) {
              message = await postGroupMessage(groupId, body, clientMessageId);
            } else {
              throw caught;
            }
          }
        } else {
          message = await postGroupMessage(groupId, body, clientMessageId);
        }

        hasContentRef.current = true;
        setMessages((current) => mergeChatMessages(current, [message]));
        setStatus((current) => (current === 'blocked' ? current : 'ready'));
        return true;
      } catch (caught) {
        if (isChatAccessError(caught)) setStatus('blocked');
        setSendError(describeError(caught));
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [connection, groupId],
  );

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return {
    messages,
    status,
    error,
    hasMore,
    isLoadingOlder,
    olderError,
    isSending,
    sendError,
    connection,
    send,
    loadOlder,
    retry,
  };
}

