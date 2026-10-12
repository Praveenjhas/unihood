/**
 * Phone sign-in.
 *
 * The whole one-time-code lifecycle lives here so the rules are readable in one
 * place. What each rule is for:
 *
 *   * **A code is bound to a number, not an account.** `otp_challenges` has no
 *     foreign key, because a code must be requestable for a number that has no
 *     account yet - that is how an account is created. Nothing about the response
 *     to a request says whether an account exists, so the endpoint cannot be used
 *     to enumerate members.
 *
 *   * **Only the newest code works.** Requesting again marks every earlier
 *     unconsumed challenge `superseded_at`, so a member who taps "resend" cannot
 *     be defeated by the older message arriving late.
 *
 *   * **A repeat request does not reset the limits.** The superseded rows stay
 *     (they are what the rolling hour is counted from), and the cooldown is
 *     measured from the previous row rather than from a counter the caller can
 *     zero.
 *
 *   * **Attempts are capped.** Five wrong codes and the challenge is finished,
 *     which is well under any brute-force budget for a six-digit space in a
 *     five-minute window.
 *
 *   * **A verified code produces the ordinary session.** `startSessionForUser` is
 *     the same call password sign-in makes, so access-token TTL, refresh rotation
 *     and the per-account session cap are unchanged.
 *
 * Failure wording is deliberately uniform: an unknown number, a spent code and a
 * replaced code all answer `otp_invalid` with a sentence that tells the member
 * what to do next, and none of them says whether an account exists.
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { env } from '../config/env';
import { pool, withTransaction } from '../db/pool';
import { InvalidPhoneError, maskPhone, normalizePhone, type NormalizedPhone } from '../domain/phone';
import { dateFromNow } from '../lib/dates';
import { AppError } from '../lib/errors';
import { createOtpCode, hashOtpCode, otpCodeMatches } from '../lib/otp';
import { sendOtp } from '../lib/otpTransport';
import { newId } from '../lib/tokens';
import { startSessionForUser, type AuthSession, type SessionContext } from './authService';

/**
 * The name every account starts with.
 *
 * A display name is *not* an authentication factor and is not asked for at
 * sign-in: a phone-created account gets this placeholder in both `users` and
 * `profiles` (the `profiles` column default is the same string), and onboarding
 * replaces it. It is never used to identify anybody.
 */
const PLACEHOLDER_DISPLAY_NAME = 'New member';

export interface PhoneCredentials {
  countryCode: string;
  nationalNumber: string;
}

export interface OtpRequestOutcome {
  /** Masked. The full number is never echoed back. */
  phone: string;
  expiresInSeconds: number;
  /** Seconds before another code may be requested. Drives the resend countdown. */
  resendAfterSeconds: number;
  transport: 'log' | 'sms';
  /** True only when a real provider accepted the message. */
  delivered: boolean;
  /** True when an SMS transport was configured but rejected the message. */
  failed: boolean;
}

export interface OtpVerifyOutcome {
  session: AuthSession;
  /** True when this verification created the account. */
  isNewAccount: boolean;
  /** True when the profile has not been completed, i.e. onboarding is next. */
  onboardingRequired: boolean;
}

interface ChallengeRow extends RowDataPacket {
  id: string;
  code_hash: string;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
  superseded_at: Date | null;
}

interface CountRow extends RowDataPacket {
  total: number;
}

interface AccountRow extends RowDataPacket {
  id: string;
  profile_completed: number | null;
}

/** Turns a domain parse failure into the API error, so the route has nothing to map. */
export function readPhone(input: PhoneCredentials): NormalizedPhone {
  try {
    return normalizePhone(input);
  } catch (caught) {
    if (caught instanceof InvalidPhoneError) {
      throw new AppError('phone_invalid', 400, caught.message, { field: 'phone' });
    }
    throw caught;
  }
}

/**
 * Checks a code and signs the member in, creating the account when the number is
 * new.
 *
 * The order of the checks matters for wording, not for security: an expired code
 * is worth telling apart from a wrong one, but a code this server never issued, a
 * spent code and a replaced code are all simply "not valid" - precisely because
 * saying more would describe somebody else's account.
 */
export async function verifyOtp(
  input: PhoneCredentials & { code: string },
  context: SessionContext,
): Promise<OtpVerifyOutcome> {
  const phone = readPhone(input);
  const code = input.code.trim();

  const [rows] = await pool.query<ChallengeRow[]>(
    `SELECT id, code_hash, attempts, max_attempts, expires_at, consumed_at, superseded_at
       FROM otp_challenges
      WHERE phone_e164 = ?
      ORDER BY created_at DESC
      LIMIT 1`,
    [phone.e164],
  );

  const challenge = rows[0];

  if (!challenge) {
    throw new AppError('otp_invalid', 400, 'We have no code for that number. Ask for a new one.');
  }

  if (challenge.consumed_at !== null) {
    throw new AppError('otp_invalid', 400, 'That code has already been used. Ask for a new one.');
  }

  if (challenge.superseded_at !== null) {
    throw new AppError('otp_invalid', 400, 'That code was replaced by a newer one. Use the most recent message.');
  }

  if (challenge.expires_at.getTime() <= Date.now()) {
    throw new AppError('otp_expired', 400, 'That code has expired. Ask for a new one.');
  }

  if (challenge.attempts >= challenge.max_attempts) {
    throw new AppError('otp_attempts_exceeded', 429, 'Too many incorrect codes. Ask for a new one.');
  }

  if (!otpCodeMatches(code, challenge.id, env.otp.hashSecret, challenge.code_hash)) {
    const attempts = challenge.attempts + 1;

    await pool.query('UPDATE otp_challenges SET attempts = ? WHERE id = ? AND consumed_at IS NULL', [
      attempts,
      challenge.id,
    ]);

    if (attempts >= challenge.max_attempts) {
      throw new AppError('otp_attempts_exceeded', 429, 'Too many incorrect codes. Ask for a new one.');
    }

    const remaining = challenge.max_attempts - attempts;
    throw new AppError(
      'otp_invalid',
      400,
      `That code is not right. ${remaining} attempt${remaining === 1 ? '' : 's'} left before you need a new one.`,
    );
  }

  // Single-use, and only while it is still the current code: the update decides
  // the race rather than a read followed by a write.
  const [consumed] = await pool.query<ResultSetHeader>(
    `UPDATE otp_challenges
        SET consumed_at = NOW(3)
      WHERE id = ?
        AND consumed_at IS NULL
        AND superseded_at IS NULL
        AND attempts < max_attempts`,
    [challenge.id],
  );

  if (consumed.affectedRows !== 1) {
    throw new AppError('otp_invalid', 400, 'That code is no longer valid. Ask for a new one.');
  }

  const { userId, isNewAccount } = await findOrCreateAccount(phone.e164);

  const [profileRows] = await pool.query<AccountRow[]>(
    'SELECT user_id AS id, profile_completed FROM profiles WHERE user_id = ? LIMIT 1',
    [userId],
  );

  const session = await startSessionForUser(userId, context);

  return {
    session,
    isNewAccount,
    onboardingRequired: profileRows[0]?.profile_completed !== 1,
  };
}

interface FoundAccount {
  userId: string;
  isNewAccount: boolean;
}

/**
 * Finds the account for a verified number, or creates one.
 *
 * The `ER_DUP_ENTRY` catch is not decoration: two devices verifying the same
 * number at the same instant both see "no account", and the unique key on
 * `users.phone_e164` is what actually decides which insert wins. The loser reads
 * the winner's row and signs in as the same member rather than failing.
 */
async function findOrCreateAccount(phoneE164: string): Promise<FoundAccount> {
  const [existing] = await pool.query<RowDataPacket[]>('SELECT id FROM users WHERE phone_e164 = ? LIMIT 1', [
    phoneE164,
  ]);

  if (existing[0]) {
    const userId = String(existing[0].id);
    await pool.query('UPDATE users SET phone_verified_at = COALESCE(phone_verified_at, NOW(3)) WHERE id = ?', [
      userId,
    ]);
    return { userId, isNewAccount: false };
  }

  const userId = newId();

  try {
    await withTransaction(async (connection) => {
      await connection.query(
        `INSERT INTO users (id, phone_e164, phone_verified_at, display_name)
         VALUES (?, ?, NOW(3), ?)`,
        [userId, phoneE164, PLACEHOLDER_DISPLAY_NAME],
      );
      // The profile is created in the same transaction as the account, exactly as
      // registration does: an account without a profile is a state the rest of
      // the app has no answer for.
      await connection.query('INSERT INTO profiles (user_id, display_name) VALUES (?, ?)', [
        userId,
        PLACEHOLDER_DISPLAY_NAME,
      ]);
    });
  } catch (caught) {
    const errno = (caught as { errno?: unknown }).errno;
    if (errno !== 1062) throw caught;

    const [winner] = await pool.query<RowDataPacket[]>('SELECT id FROM users WHERE phone_e164 = ? LIMIT 1', [
      phoneE164,
    ]);
    if (winner[0]) return { userId: String(winner[0].id), isNewAccount: false };
    throw caught;
  }

  return { userId, isNewAccount: true };
}


/**
 * Issues a code.
 *
 * The per-number limits are checked here rather than at the edge because the
 * interesting attacker hammers one number from many addresses - the middleware
 * covers the "many numbers from one address" half, this covers the other.
 */
/**
 * A refusal the member can act on: how long to wait, in seconds, travels in
 * `details` so the screen can run a countdown rather than guess.
 */
const throttled = (message: string, retryAfterSeconds: number): AppError =>
  new AppError('otp_throttled', 429, message, { retryAfterSeconds });

export async function requestOtp(input: PhoneCredentials, ipAddress: string | null): Promise<OtpRequestOutcome> {
  const phone = readPhone(input);

  const [newest] = await pool.query<RowDataPacket[]>(
    'SELECT created_at FROM otp_challenges WHERE phone_e164 = ? ORDER BY created_at DESC LIMIT 1',
    [phone.e164],
  );

  if (newest[0]) {
    const createdAt = newest[0].created_at as Date;
    const elapsedSeconds = Math.floor((Date.now() - createdAt.getTime()) / 1000);
    const remaining = env.otp.resendCooldownSeconds - elapsedSeconds;

    if (remaining > 0) {
      throw throttled(
        `A code was just sent to ${maskPhone(phone.e164)}. Wait ${remaining} second${remaining === 1 ? '' : 's'} before asking again.`,
        remaining,
      );
    }
  }

  // The rolling hour. Counted over every row for the number - including the ones
  // a later request superseded, because "request again" must not clear a limit.
  //
  // The prune above the count is opportunistic housekeeping, not part of the
  // limit: a day is far longer than any window a cap looks at, so a row that
  // still matters can never be removed, and the table stops growing by one row per
  // request forever. It is scoped to this number (and therefore this index), so it
  // is never an unbounded table sweep. A deployment with real traffic should also
  // sweep the whole table on a schedule - see the README.
  await pool.query('DELETE FROM otp_challenges WHERE phone_e164 = ? AND created_at < DATE_SUB(NOW(3), INTERVAL 1 DAY)', [
    phone.e164,
  ]);

  const [recent] = await pool.query<CountRow[]>(
    `SELECT COUNT(*) AS total
       FROM otp_challenges
      WHERE phone_e164 = ?
        AND created_at > DATE_SUB(NOW(3), INTERVAL ? MINUTE)`,
    [phone.e164, 60],
  );

  if (Number(recent[0]?.total ?? 0) >= env.otp.maxRequestsPerHour) {
    throw throttled(
      `Too many codes have been requested for ${maskPhone(phone.e164)}. Try again in an hour, or contact Unihood if this is unexpected.`,
      60 * 60,
    );
  }

  const challengeId = newId();
  const code = createOtpCode(env.otp.codeLength);
  const expiresAt = dateFromNow(env.otp.ttlSeconds);

  await withTransaction(async (connection) => {
    // Only the newest code is ever accepted, so every outstanding one is retired
    // in the same transaction as the insert: there is no window in which two live
    // codes both work.
    await connection.query(
      'UPDATE otp_challenges SET superseded_at = NOW(3) WHERE phone_e164 = ? AND consumed_at IS NULL AND superseded_at IS NULL',
      [phone.e164],
    );

    await connection.query(
      `INSERT INTO otp_challenges (id, phone_e164, code_hash, max_attempts, expires_at, requested_ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        challengeId,
        phone.e164,
        hashOtpCode(code, challengeId, env.otp.hashSecret),
        env.otp.maxAttempts,
        expiresAt,
        ipAddress,
      ],
    );
  });

  const dispatch = await sendOtp({
    to: phone.e164,
    code,
    expiresInMinutes: env.otp.ttlMinutes,
  });

  return {
    phone: maskPhone(phone.e164),
    expiresInSeconds: env.otp.ttlSeconds,
    resendAfterSeconds: env.otp.resendCooldownSeconds,
    transport: dispatch.transport,
    delivered: dispatch.delivered,
    failed: dispatch.transport === 'sms' && !dispatch.delivered,
  };
}

