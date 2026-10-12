/**
 * Group chat: history, sending, and the authorization that guards both.
 *
 * This is the only module that knows the shape of `group_messages`, and it holds
 * every rule the transport layers must not be trusted to enforce. The Socket.IO
 * layer in `realtime/socket.ts` calls **this** module for a send - so a message
 * that arrived over a WebSocket and one that arrived over HTTP are validated,
 * authorized and written by the same code, and neither route can be more
 * permissive than the other.
 *
 * Five properties worth stating up front, because the SQL below is written to
 * preserve them:
 *
 *   1. **Identity comes from the session.** No function accepts a sender id; the
 *      caller's id is always an argument supplied by `requireAuth` (HTTP) or by
 *      the token verified at socket connect.
 *   2. **An active membership is required, every time.** Reading history and
 *      sending a message both re-check `group_memberships` in the same request that
 *      touches the table. A pending, rejected, left or removed membership matches
 *      nothing, and a private group's chat is therefore as invisible as the group
 *      itself - a guessed group id is a 404, not a teaser.
 *   3. **Room membership is not authorization.** `realtime/hub.ts` can evict a
 *      member's sockets the moment access ends, but nothing depends on that having
 *      happened: this module re-reads the database on every send, so a socket that
 *      was left in a room still cannot write to it.
 *   4. **Nothing is deleted**, and an archived group refuses new messages while
 *      keeping its history readable to the members who were there.
 *   5. **A duplicate send is the same send.** `clientMessageId` plus the UNIQUE key
 *      on `(group_id, sender_id, client_message_id)` makes a retried or
 *      double-tapped message resolve to the row that already exists, so a flaky
 *      connection cannot post the same sentence twice.
 *
 * `groups` is a reserved word in MySQL 8, so that table is written as
 * `` `groups` `` in every statement here - see `migrations/0006_groups.sql`.
 */
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

import { pool, withTransaction } from '../db/pool';
import {
  MAX_MESSAGE_PAGE_SIZE,
  MESSAGE_MAX_LENGTH,
  MESSAGE_MIN_LENGTH,
  MESSAGE_PAGE_SIZE,
} from '../domain/chat';
import type { MembershipRole } from '../domain/groups';
import { toIso } from '../lib/dates';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/tokens';
import { broadcastGroupMessage } from '../realtime/hub';

// -----------------------------------------------------------------------------
// The public shape of a message
// -----------------------------------------------------------------------------

/**
 * One message as it travels to a *viewer*.
 *
 * The sender projection is deliberately minimal: an id, a display name and the
 * body. Nothing that identifies the sender beyond what the group's member list
 * already shows - no phone number, no email, no coordinate, no eligibility.
 * `isYou` is computed server-side from the caller's id so two members render the
 * same row differently without the client having to know its own id twice.
 */
export interface ChatMessage {
  id: string;
  groupId: string;
  senderId: string;
  senderName: string;
  body: string;
  /** ISO 8601 UTC; the client renders it in the device's timezone. */
  createdAt: string;
  isYou: boolean;
}

/**
 * The same message without `isYou`, which is what a broadcast can carry.
 *
 * One emit goes to every member of the room, so "is this mine?" is a question the
 * *client* answers from `senderId` and its own session - see
 * `src/features/chat/useGroupChat.ts`, which does exactly that. Keeping the two
 * shapes named separately is what stops a broadcast from labelling every message
 * as somebody else's.
 */
export type ChatMessageBroadcast = Omit<ChatMessage, 'isYou'>;

/**
 * One page of history, oldest first.
 *
 * `nextCursor` is the id of the *oldest* message in the page, and it is the
 * `before` value for the next request. A cursor rather than an offset because
 * messages arrive while a member is scrolling: an offset would re-serve rows
 * every time somebody typed, whereas an id pins the window to a row that cannot
 * move. Ids are immutable, so the same cursor always means the same place.
 */
export interface ChatMessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** What the chat screen is allowed to know about the room itself. */
export interface ChatAccess {
  groupId: string;
  groupName: string;
  role: MembershipRole;
  /** An archived group's history is readable; nothing new can be posted. */
  archived: boolean;
}

export interface ChatPageOptions {
  limit?: number;
  /** An immutable message id. The page returned is the one *older* than it. */
  before?: string | null;
}

// -----------------------------------------------------------------------------
// The projection every read is built from
// -----------------------------------------------------------------------------

interface MessageRow extends RowDataPacket {
  id: string;
  group_id: string;
  sender_id: string;
  body: string;
  created_at: Date;
  sender_name: string | null;
}

/**
 * The columns a message response needs.
 *
 * `sender_name` comes from `users`, not from a copy on the message: renaming an
 * account updates every line of history at once, which is what people expect from
 * a chat and what a denormalised column could not do. `COALESCE` because a user row
 * always has a display name in practice but a `NULL` should render as a member
 * rather than as a blank bubble.
 */
const MESSAGE_COLUMNS = `
  m.id,
  m.group_id,
  m.sender_id,
  m.body,
  m.created_at,
  COALESCE(u.display_name, 'Member') AS sender_name
`;

const MESSAGE_JOINS = `
  JOIN users u ON u.id = m.sender_id
`;

function mapMessage(row: MessageRow, callerId: string): ChatMessage {
  return {
    id: row.id,
    groupId: row.group_id,
    senderId: row.sender_id,
    senderName: row.sender_name ?? 'Member',
    body: row.body,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    isYou: row.sender_id === callerId,
  };
}

/** The same row without `isYou`, which is the only shape a broadcast can carry. */
function toBroadcast(message: ChatMessage): ChatMessageBroadcast {
  // Written field by field rather than by destructuring away `isYou`: an explicit
  // projection cannot quietly start broadcasting a field added to `ChatMessage`.
  return {
    id: message.id,
    groupId: message.groupId,
    senderId: message.senderId,
    senderName: message.senderName,
    body: message.body,
    createdAt: message.createdAt,
  };
}

/** Bounded paging, so one request cannot ask for a whole conversation. */
function clampPage(options: ChatPageOptions): { limit: number; before: string | null } {
  const requested = Math.trunc(options.limit ?? MESSAGE_PAGE_SIZE) || MESSAGE_PAGE_SIZE;
  return {
    limit: Math.min(Math.max(requested, 1), MAX_MESSAGE_PAGE_SIZE),
    before: options.before && options.before.length > 0 ? options.before : null,
  };
}

// -----------------------------------------------------------------------------
// Authorization
// -----------------------------------------------------------------------------

interface GroupAccessRow extends RowDataPacket {
  id: string;
  name: string;
  archived_at: Date | null;
  role: string | null;
}

/**
 * A group row plus the caller's own membership role, in one read.
 *
 * Neither half is optional: the group has to exist (or the answer is a plain 404,
 * exactly as an unknown id would be) and the caller has to be an *active* member.
 * A pending request, a declined one, a voluntary leave and a removal all arrive
 * here as `role === null`, so they are refused by the same line of code rather
 * than by four separate checks that could drift apart.
 */
async function readGroupAccess(
  connection: PoolConnection | undefined,
  groupId: string,
  callerId: string,
): Promise<GroupAccessRow> {
  const sql = `
    SELECT g.id, g.name, g.archived_at, m.role
      FROM \`groups\` g
      LEFT JOIN group_memberships m
        ON m.group_id = g.id
       AND m.user_id = ?
       AND m.status = 'active'
     WHERE g.id = ?
     LIMIT 1
  `;
  const runner = connection ?? pool;
  const [rows] = await runner.query<GroupAccessRow[]>(sql, [callerId, groupId]);

  const row = rows[0];
  if (!row) throw notFound('That group no longer exists.');
  return row;
}

/**
 * Requires an active membership, and returns the room's own facts.
 *
 * `action` only changes the sentence: reading the history and posting a message
 * are refused for the same reason, but a member is told which one they tried.
 */
function assertActiveMember(row: GroupAccessRow, action: 'read' | 'post' | 'join'): MembershipRole {
  const role = row.role as MembershipRole | null;
  if (role !== null) return role;

  throw forbidden(
    action === 'read'
      ? 'Only members of this group can read its chat. Ask to join, or leave this to its members.'
      : 'Only members of this group can post in its chat.',
  );
}

/** An archived group keeps its history and refuses anything new. */
function assertNotArchived(row: GroupAccessRow): void {
  if (row.archived_at === null) return;
  throw new AppError(
    'group_archived',
    409,
    'That group has been archived, so its chat is closed to new messages. The history is kept.',
  );
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/**
 * What the chat screen is allowed to know: the group's name, the caller's role and
 * whether the room is closed.
 *
 * Refuses a non-member outright rather than answering with less, so the mobile
 * screen can draw the "members only" state from a `forbidden` response instead of
 * from a button it decided not to show.
 */
export async function getChatAccess(callerId: string, groupId: string): Promise<ChatAccess> {
  const row = await readGroupAccess(undefined, groupId, callerId);
  const role = assertActiveMember(row, 'read');

  return { groupId: row.id, groupName: row.name, role, archived: row.archived_at !== null };
}

/**
 * One page of history, newest window first, returned in chronological order.
 *
 * The window is keyset-paginated on `(created_at, id)`: `ORDER BY created_at DESC,
 * id DESC` with an optional "older than this cursor" predicate, one row over the
 * limit so `hasMore` is a fact rather than an inference. `id` is the tiebreak
 * because two messages can share a millisecond - the column is `DATETIME(3)` - and
 * without it a page boundary could drop or repeat a message.
 *
 * A cursor that does not belong to this group is a `400`, not an empty page: it can
 * only come from a client bug or a hand-written request, and answering "nothing
 * older" would hide the former behind the latter.
 */
export async function listGroupMessages(
  callerId: string,
  groupId: string,
  options: ChatPageOptions = {},
): Promise<ChatMessagePage> {
  const page = clampPage(options);

  return withTransaction(async (connection) => {
    const access = await readGroupAccess(connection, groupId, callerId);
    assertActiveMember(access, 'read');

    let cursorSql = '';
    const cursorValues: unknown[] = [];

    if (page.before !== null) {
      const [cursorRows] = await connection.query<RowDataPacket[]>(
        'SELECT id, created_at FROM group_messages WHERE id = ? AND group_id = ? LIMIT 1',
        [page.before, groupId],
      );
      const cursor = cursorRows[0];
      if (!cursor) {
        throw badRequest('That chat page could not be found. Reload the conversation.', { field: 'before' });
      }

      cursorSql = ' AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))';
      cursorValues.push(cursor.created_at, cursor.created_at, cursor.id);
    }

    const [rows] = await connection.query<MessageRow[]>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM group_messages m
         ${MESSAGE_JOINS}
        WHERE m.group_id = ?${cursorSql}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?`,
      [groupId, ...cursorValues, page.limit + 1],
    );

    const hasMore = rows.length > page.limit;
    const window = hasMore ? rows.slice(0, page.limit) : rows;
    // Oldest first on the wire: a chat screen appends upward, and the client never
    // has to sort what the server already ordered.
    const messages = [...window].reverse().map((row) => mapMessage(row, callerId));
    const oldest = messages[0];

    return {
      messages,
      hasMore,
      nextCursor: hasMore && oldest !== undefined ? oldest.id : null,
    };
  });
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

/**
 * Trims and validates a body.
 *
 * The trim happens before the length check so a message of spaces is "empty"
 * rather than "one character", and the bound is reported as a *field* problem so
 * the mobile input can show it inline instead of as a banner.
 */
export function normalizeMessageBody(raw: unknown): string {
  const body = typeof raw === 'string' ? raw.trim() : '';

  if (body.length < MESSAGE_MIN_LENGTH) {
    throw badRequest('Write a message before sending it.', { field: 'body' });
  }
  if (body.length > MESSAGE_MAX_LENGTH) {
    throw badRequest(`Keep a message to ${MESSAGE_MAX_LENGTH} characters or fewer.`, { field: 'body' });
  }

  return body;
}

/** The stored row, read back with its sender's name. */
async function readMessage(
  connection: PoolConnection,
  messageId: string,
  callerId: string,
): Promise<ChatMessage> {
  const [rows] = await connection.query<MessageRow[]>(
    `SELECT ${MESSAGE_COLUMNS}
       FROM group_messages m
       ${MESSAGE_JOINS}
      WHERE m.id = ?
      LIMIT 1`,
    [messageId],
  );

  const row = rows[0];
  if (!row) throw notFound('That message could not be found.');
  return mapMessage(row, callerId);
}

/** MySQL's duplicate-key error number (`ER_DUP_ENTRY`). */
const ER_DUP_ENTRY = 1062;

function isDuplicate(caught: unknown): boolean {
  return (caught as { errno?: unknown } | null)?.errno === ER_DUP_ENTRY;
}

/**
 * Stores a message and tells the group's room about it.
 *
 * The order matters and is the point of the function:
 *
 *   1. **authorize** - the group row is locked and the caller's membership is read
 *      from `group_memberships` inside the same transaction as the insert, so a
 *      member removed a millisecond ago cannot slip a message in behind the
 *      removal;
 *   2. **persist** - the row is written; an archived group is refused before
 *      anything is written at all;
 *   3. **resolve the duplicate** - if the caller sent the same `clientMessageId`
 *      twice, the unique key refuses the second insert and the *existing* row is
 *      returned instead, which is what makes a double tap and a retry after a
 *      timeout both idempotent;
 *   4. **broadcast** - only after the commit, and only with the row the database
 *      accepted, so a listener can always fetch what it was told about.
 *
 * The caller's id is never taken from the request, and the returned projection is
 * built from the stored row rather than from the submitted text.
 */
export async function sendGroupMessage(
  callerId: string,
  groupId: string,
  rawBody: unknown,
  clientMessageId?: string | null,
): Promise<ChatMessage> {
  const body = normalizeMessageBody(rawBody);
  const dedupeKey = typeof clientMessageId === 'string' && clientMessageId.length > 0 ? clientMessageId : null;
  const messageId = newId();

  const message = await withTransaction(async (connection) => {
    // Locking the group row serialises an archive against a send, exactly as it
    // serialises a join against an archive in `groupService`.
    const [groupRows] = await connection.query<RowDataPacket[]>(
      'SELECT id FROM `groups` WHERE id = ? FOR UPDATE',
      [groupId],
    );
    if (!groupRows[0]) throw notFound('That group no longer exists.');

    const access = await readGroupAccess(connection, groupId, callerId);
    assertActiveMember(access, 'post');
    assertNotArchived(access);

    if (dedupeKey !== null) {
      const [existing] = await connection.query<RowDataPacket[]>(
        'SELECT id FROM group_messages WHERE group_id = ? AND sender_id = ? AND client_message_id = ? LIMIT 1',
        [groupId, callerId, dedupeKey],
      );
      const already = existing[0];
      if (already) return readMessage(connection, String(already.id), callerId);
    }

    try {
      await connection.query(
        `INSERT INTO group_messages (id, group_id, sender_id, body, client_message_id)
         VALUES (?, ?, ?, ?, ?)`,
        [messageId, groupId, callerId, body, dedupeKey],
      );
    } catch (caught) {
      // Two identical sends raced: the unique key decided, and the loser returns
      // the winner's row rather than a 500 the member could not act on.
      if (!isDuplicate(caught) || dedupeKey === null) throw caught;

      const [existing] = await connection.query<RowDataPacket[]>(
        'SELECT id FROM group_messages WHERE group_id = ? AND sender_id = ? AND client_message_id = ? LIMIT 1',
        [groupId, callerId, dedupeKey],
      );
      const already = existing[0];
      if (!already) throw caught;
      return readMessage(connection, String(already.id), callerId);
    }

    return readMessage(connection, messageId, callerId);
  });

  // After the commit, never before: a listener that receives this can fetch it.
  broadcastGroupMessage(groupId, toBroadcast(message));

  return message;
}




