/**
 * Closing an account.
 *
 * Account deletion is the one operation that walks every table the product owns, so
 * it lives in its own service rather than inside `profileService` or `authService`:
 * what it has to get right is the *order* and the refusals, not a single row.
 *
 * Four rules decide the shape of it:
 *
 *   1. **The password is re-verified.** A live session proves which account is
 *      asking; it does not prove that the person holding the phone is the account's
 *      owner. Unlike `/login` there is nothing to hide from a timing difference -
 *      the caller is authenticated as this very account - so the comparison is a
 *      plain constant-time one.
 *   2. **A group with other active members blocks deletion.** `groups.created_by`
 *      is `ON DELETE CASCADE`, so deleting the account would silently delete a group
 *      that other people are still in. The refusal names the groups, and the member
 *      either hands each one on or removes its members first - never the other way
 *      round, because the account is the thing being deleted.
 *   3. **A group nobody else is in is archived before it goes.** The account's own
 *      row is what the foreign key removes rows through, so an owned group with no
 *      other active members cannot survive the delete; archiving it first is the
 *      record of *why* it went, and any member who arrives later sees an archived
 *      group rather than a missing one.
 *   4. **Nothing is left half-deleted.** Children are removed explicitly, in one
 *      transaction, and the account row goes last, so a failure at any point rolls
 *      the whole thing back to a state where the account still exists and still
 *      works. What the transaction *cannot* cover is the filesystem - there is no
 *      file store in this phase (see the note below), and when image sharing adds
 *      one the cleanup belongs here as a step after the commit, retried by whoever
 *      notices, because a database row and a file can never be removed atomically.
 *
 * Sessions need no separate revocation step: `refresh_sessions` rows belong to the
 * account and go with it, and `requireAuth` refuses any access token whose session
 * row is gone - so every device is signed out by the same delete that removes the
 * account. That is also why the app returns to the welcome screen rather than
 * showing an error: the next request answers `session_expired`.
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { pool, withTransaction } from '../db/pool';
import { AppError } from '../lib/errors';
import { verifyPassword } from '../lib/password';

/** What a completed deletion actually removed, for the response and the log. */
export interface AccountDeletionSummary {
  /** Owned groups with nobody else left in them, archived before they went. */
  archivedGroups: number;
  /** Events the account had created that were still scheduled, now cancelled. */
  cancelledEvents: number;
  /** Chat messages the account had sent, which go with it. */
  removedMessages: number;
}

interface AccountRow extends RowDataPacket {
  id: string;
  /** `null` for a phone-only account, which has no password to verify. */
  password_hash: string | null;
}

/**
 * Closes the caller's account and everything that belongs to it.
 *
 * The order below is the point: verify the password, refuse while the account still
 * owns a group with other active members, record what has to be recorded (archive,
 * cancel), then delete children before the account row itself - all inside one
 * transaction, so a failure anywhere leaves the account exactly as it was.
 */
export async function deleteMyAccount(userId: string, password: string): Promise<AccountDeletionSummary> {
  const [accountRows] = await pool.query<AccountRow[]>('SELECT id, password_hash FROM users WHERE id = ? LIMIT 1', [
    userId,
  ]);
  const account = accountRows[0];
  if (!account) {
    throw new AppError('unauthorized', 401, 'Your account could not be found. Sign in again.');
  }

  if (account.password_hash === null) {
    // A phone-only account has no password to prove anything with, and this is an
    // endpoint that must be hard to reach by accident: its owner asks whoever runs
    // Unihood to close it.
    throw new AppError(
      'password_not_set',
      409,
      'That account has no password on it, so this screen cannot confirm who is asking. Ask whoever runs Unihood to close it.',
    );
  }

  if (!(await verifyPassword(password, account.password_hash))) {
    throw new AppError('invalid_credentials', 401, 'That password does not match this account.');
  }

  // A group with other **active** members blocks deletion: `groups.created_by` is
  // ON DELETE CASCADE, so going ahead would silently delete a group other people are
  // still in. A pending or rejected request is not a member yet, and a `left` or
  // `removed` row is history rather than a person in the group.
  const [blockingRows] = await pool.query<({ name: string } & RowDataPacket)[]>(
    `SELECT g.name
       FROM \`groups\` g
       JOIN group_memberships m ON m.group_id = g.id
      WHERE g.created_by = ?
        AND g.archived_at IS NULL
        AND m.status = 'active'
        AND m.user_id <> ?
      GROUP BY g.id, g.name
      ORDER BY g.name`,
    [userId, userId],
  );

  if (blockingRows.length > 0) {
    const names = blockingRows.map((row) => row.name);
    throw new AppError(
      'ownership_transfer_required',
      409,
      names.length === 1
        ? `You still own ${names[0]}, which has other members. Hand the group on, or remove its members, before closing your account.`
        : `You still own ${names.length} groups with other members: ${names.join(', ')}. Hand them on, or remove their members, before closing your account.`,
    );
  }

  return withTransaction(async (connection) => {
    // An owned group with nobody else active in it cannot outlive the account, so it
    // is archived first: that is the record of why it went, and a member who arrives
    // later sees an archived group rather than a missing one.
    const [archived] = await connection.query<ResultSetHeader>(
      `UPDATE \`groups\` g
          SET g.archived_at = NOW(3)
        WHERE g.created_by = ?
          AND g.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM group_memberships m
             WHERE m.group_id = g.id
               AND m.status = 'active'
               AND m.user_id <> ?
          )`,
      [userId, userId],
    );

    // A scheduled event is cancelled before its row follows the account: the creator
    // column is ON DELETE CASCADE, so no event can survive its organiser, and a
    // cancelled event is the honest thing for anyone who had RSVP'd.
    const [cancelled] = await connection.query<ResultSetHeader>(
      "UPDATE events SET status = 'cancelled', cancelled_at = NOW(3) WHERE created_by = ? AND status = 'scheduled'",
      [userId],
    );

    // Children first, then the account. Every one of these cascades anyway; removing
    // them explicitly is what makes the sequence readable, and the counts reportable.
    const [messages] = await connection.query<ResultSetHeader>('DELETE FROM group_messages WHERE sender_id = ?', [
      userId,
    ]);
    await connection.query('DELETE FROM event_rsvps WHERE user_id = ?', [userId]);
    await connection.query('DELETE FROM group_memberships WHERE user_id = ?', [userId]);
    await connection.query('DELETE FROM events WHERE created_by = ?', [userId]);

    const [deleted] = await connection.query<ResultSetHeader>('DELETE FROM users WHERE id = ?', [userId]);
    if (deleted.affectedRows === 0) {
      // Something else removed the account between the check above and here; the end
      // state is the one that was asked for, but there is nothing to report.
      throw new AppError('unauthorized', 401, 'Your account could not be found. Sign in again.');
    }

    return {
      archivedGroups: archived.affectedRows,
      cancelledEvents: cancelled.affectedRows,
      removedMessages: messages.affectedRows,
    };
  });
}
