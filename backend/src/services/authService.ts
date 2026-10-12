/**
 * Authentication.
 *
 * The whole account lifecycle lives here so that the rules are in one file:
 * registration with email confirmation, sign-in, refresh with rotation, sign-out
 * and password recovery. The credential the app asks for today is a **phone number
 * and a password** (`registerWithPhone`, `loginWithPhone`); the email paths and
 * the one-time-code path in `otpService` stay for the accounts an earlier version
 * created, and nothing about sessions knows which of the three was presented.
 *
 * Three decisions are worth reading before the code:
 *
 *   1. **Passwords are scrypt hashes** (`lib/password.ts`). Verification is
 *      constant-time and a malformed stored hash fails the login instead of
 *      throwing.
 *
 *   2. **Refresh tokens rotate, and re-use is treated as a compromise.** Every
 *      refresh revokes the presented session and issues a new one. Presenting an
 *      already-revoked token is not a stale client - it is either a replay or a
 *      stolen token - so *every* session for that account is revoked and the
 *      member signs in again. That is the only way a rotation scheme actually
 *      protects anyone.
 *
 *   3. **Sign-in does not reveal whether a number or an address is registered.**
 *      A missing account still runs one scrypt comparison against a fixed dummy
 *      hash, so the response time is the same, and the error is identical to a
 *      wrong password. A phone-only account is the one case that answers
 *      differently (`password_not_set`), because a member whose account has no
 *      password has to be told how to get in - and it runs the same comparison
 *      first so the timing still says nothing.
 *
 * Registration is the one deliberate exception: it has to say "that number is
 * taken", which is why the mobile client phrases it as "sign in instead".
 */
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { env } from '../config/env';
import { pool, withTransaction } from '../db/pool';
import { isE164 } from '../domain/phone';
import { signAccessToken } from '../lib/accessToken';
import { dateFromNow } from '../lib/dates';
import { passwordResetEmail, verificationEmail } from '../lib/emailTemplates';
import { AppError, badRequest, conflict, sessionExpired } from '../lib/errors';
import { sendMail } from '../lib/mailer';
import { assertPasswordAcceptable, hashPassword, needsRehash, verifyPassword } from '../lib/password';
import { createOpaqueToken, hashToken, newId } from '../lib/tokens';

export interface AuthenticatedUser {
  id: string;
  /**
   * `null` for an account created through phone sign-in: a member who only ever
   * gave a phone number has no address, and inventing one would be a lie the rest
   * of the system would then have to keep.
   */
  email: string | null;
  /** Storage-shape E.164. Only ever returned on the member's *own* account. */
  phone: string | null;
  displayName: string;
  emailVerified: boolean;
  phoneVerified: boolean;
}

export interface SessionContext {
  userAgent: string | null;
  ipAddress: string | null;
}

export interface EmailDispatch {
  transport: 'smtp' | 'log';
  /** True only when a real mail server accepted the message. */
  delivered: boolean;
  /**
   * The one-time link, present only when `MAIL_TRANSPORT=log` **and**
   * `EXPOSE_DEV_TOKENS` is on (never in production). It exists so a local client
   * can finish a flow that no mailbox can, and the API is explicit about it
   * rather than reporting a delivery that did not happen.
   */
  devLink: string | null;
}

export interface AuthSession {
  user: AuthenticatedUser;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  expiresInSeconds: number;
}

export interface RegisterResult {
  user: AuthenticatedUser;
  emailVerificationRequired: boolean;
  email: EmailDispatch;
}

export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

/**
 * The account columns a session response is built from.
 *
 * Split out from `UserRow` so `refreshSession` can rebuild an
 * `AuthenticatedUser` from a join without pretending to have a row it did not
 * select (the password hash is deliberately absent from `SESSION_LOOKUP`).
 */
interface AuthenticatedUserRow {
  id: string;
  email: string | null;
  phone_e164: string | null;
  display_name: string;
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
}

interface UserRow extends RowDataPacket, AuthenticatedUserRow {
  /** `null` since migration 0008: a phone-only account has no password. */
  password_hash: string | null;
  disabled_at: Date | null;
}

const USER_COLUMNS =
  'id, email, phone_e164, password_hash, display_name, email_verified_at, phone_verified_at, disabled_at';

function toAuthenticatedUser(row: AuthenticatedUserRow): AuthenticatedUser {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone_e164,
    displayName: row.display_name,
    emailVerified: row.email_verified_at !== null,
    phoneVerified: row.phone_verified_at !== null,
  };
}

async function findUserByEmail(email: string): Promise<UserRow | null> {
  const [rows] = await pool.query<UserRow[]>(`SELECT ${USER_COLUMNS} FROM users WHERE email = ? LIMIT 1`, [email]);
  return rows[0] ?? null;
}

/**
 * The account for a phone number, in storage shape.
 *
 * `phone_e164` is unique (migration 0008), so this is an indexed equality test on
 * a value the caller never gets to influence - the route normalises it first.
 */
async function findUserByPhone(phoneE164: string): Promise<UserRow | null> {
  const [rows] = await pool.query<UserRow[]>(`SELECT ${USER_COLUMNS} FROM users WHERE phone_e164 = ? LIMIT 1`, [
    phoneE164,
  ]);
  return rows[0] ?? null;
}

/**
 * A hash of a password nobody has, compared against when the address is unknown
 * so that "no such account" and "wrong password" take the same time.
 */
let dummyHashPromise: Promise<string> | null = null;
async function dummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('unihood-placeholder-that-is-never-a-real-password');
  }
  return dummyHashPromise;
}

const PUBLIC_API = env.api.publicUrl;

function verificationLink(token: string): string {
  return `${PUBLIC_API}/auth/verify-email?token=${encodeURIComponent(token)}`;
}

function resetLink(token: string): string {
  return `${PUBLIC_API}/auth/reset-password?token=${encodeURIComponent(token)}`;
}


// -----------------------------------------------------------------------------
// Email dispatch
// -----------------------------------------------------------------------------

async function dispatchVerificationEmail(
  userId: string,
  email: string,
  displayName: string,
  redirectTo: string | null,
): Promise<EmailDispatch> {
  const token = createOpaqueToken();

  await pool.query(
    `INSERT INTO email_verification_tokens (id, user_id, token_hash, redirect_to, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [newId(), userId, hashToken(token), redirectTo, dateFromNow(env.tokens.emailVerificationTtlSeconds)],
  );

  const link = verificationLink(token);
  const result = await sendMail({ to: email, ...verificationEmail(displayName, link) });

  return {
    transport: result.transport,
    delivered: result.delivered,
    devLink: env.exposeDevTokens && result.transport === 'log' && !result.delivered ? link : null,
  };
}

async function dispatchPasswordResetEmail(
  userId: string,
  email: string,
  displayName: string,
  redirectTo: string | null,
): Promise<EmailDispatch> {
  const token = createOpaqueToken();

  await pool.query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, redirect_to, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [newId(), userId, hashToken(token), redirectTo, dateFromNow(env.tokens.passwordResetTtlSeconds)],
  );

  const link = resetLink(token);
  const result = await sendMail({ to: email, ...passwordResetEmail(displayName, link) });

  return {
    transport: result.transport,
    delivered: result.delivered,
    devLink: env.exposeDevTokens && result.transport === 'log' && !result.delivered ? link : null,
  };
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  redirectTo: string | null;
}

/**
 * Creates an account, or re-sends the confirmation for one that was never
 * confirmed.
 *
 * The second branch matters: a member who signed up and lost the email would
 * otherwise be stuck forever, because the address is already taken and the
 * account can never be signed into.
 */
export async function register(input: RegisterInput): Promise<RegisterResult> {
  const email = normalizeEmail(input.email);
  const displayName = input.displayName.trim();

  assertPasswordAcceptable(input.password, { email, displayName });

  const existing = await findUserByEmail(email);

  if (existing) {
    if (existing.email_verified_at !== null) {
      throw conflict('email_taken', 'An account already uses that email. Sign in instead.');
    }

    // Found *by* address, so the address exists; the guard is only here because
    // the column became nullable in 0008. An account can only be reached this way
    // when it already has an address, which is exactly the case `dispatch` needs.
    if (existing.email !== null) {
      const resent = await dispatchVerificationEmail(existing.id, existing.email, existing.display_name, input.redirectTo);
      return { user: toAuthenticatedUser(existing), emailVerificationRequired: true, email: resent };
    }
  }

  const userId = newId();
  const passwordHash = await hashPassword(input.password);

  // The account and its profile row are created together: an account without a
  // profile is a state the rest of the app has no answer for.
  await withTransaction(async (connection) => {
    await connection.query('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)', [
      userId,
      email,
      passwordHash,
      displayName,
    ]);
    await connection.query('INSERT INTO profiles (user_id, display_name) VALUES (?, ?)', [userId, displayName]);
  });

  const dispatch = await dispatchVerificationEmail(userId, email, displayName, input.redirectTo);

  return {
    user: { id: userId, email, phone: null, displayName, emailVerified: false, phoneVerified: false },
    emailVerificationRequired: true,
    email: dispatch,
  };
}

// -----------------------------------------------------------------------------
// Phone number + password
//
// The credential the app asks for today: a name, a phone number and a password,
// verified against the scrypt hash exactly as an email account's is. It is an
// *addition* to the routes rather than a replacement for anything - the email
// paths above and the one-time-code path in `otpService` are untouched, so every
// account created by an earlier version still signs in the way it always did.
//
// Two rules are worth reading before the code:
//
//   1. **A number is claimed once, and is never taken over.** Registration refuses
//      a number that *any* account already has, including a phone-only account
//      whose `password_hash` is NULL. Nothing on this path proves the caller holds
//      the number, so letting it set a password on a number that already has an
//      account would be an account takeover; a one-time code - which does prove
//      possession - stays the way in for those accounts.
//
//   2. **Registering does not mark the number verified.** No code was checked, so
//      `phone_verified_at` stays NULL. The column keeps meaning "proved by a
//      code", and nothing here pretends otherwise.
// -----------------------------------------------------------------------------

/** A new account's credential. The number arrives already normalised. */
export interface PhoneRegistration {
  /**
   * E.164 (`+919876543210`). The route normalises with `readPhone`, and this
   * service checks the shape again rather than trusting its caller.
   */
  phoneE164: string;
  password: string;
  displayName: string;
}

export interface PhoneRegisterResult {
  session: AuthSession;
  /**
   * Always true: the `profiles` row was created by this call, and a new row is
   * never `profile_completed`. The root guard is what acts on it.
   */
  onboardingRequired: boolean;
}

/**
 * Creates an account from a phone number and a password, and signs it in.
 *
 * The member has just chosen the password, so asking them to type it again on a
 * sign-in screen would be theatre; the session is the same one `loginWithPhone`
 * returns, including the per-account session cap.
 */
export async function registerWithPhone(
  input: PhoneRegistration,
  context: SessionContext,
): Promise<PhoneRegisterResult> {
  if (!isE164(input.phoneE164)) {
    throw badRequest('That phone number does not look right.', { field: 'phone' });
  }

  const displayName = input.displayName.trim();
  assertPasswordAcceptable(input.password, { phone: input.phoneE164, displayName });

  // The application-level check is what produces the good message in the ordinary
  // case; the unique key on `phone_e164` is what actually decides a race, and
  // `translateDatabaseError` turns the loser's `ER_DUP_ENTRY` into this same
  // refusal rather than a 500.
  if (await findUserByPhone(input.phoneE164)) {
    throw conflict('phone_taken', 'That number already has an account. Sign in instead, or use a different number.');
  }

  const userId = newId();
  const passwordHash = await hashPassword(input.password);

  // The account and its profile row are created together, exactly as both other
  // registration paths do: an account without a profile is a state the rest of the
  // app has no answer for. `phone_verified_at` is deliberately absent - see rule 2.
  await withTransaction(async (connection) => {
    await connection.query('INSERT INTO users (id, phone_e164, password_hash, display_name) VALUES (?, ?, ?, ?)', [
      userId,
      input.phoneE164,
      passwordHash,
      displayName,
    ]);
    await connection.query('INSERT INTO profiles (user_id, display_name) VALUES (?, ?)', [userId, displayName]);
  });

  const session = await startSessionForUser(userId, context);

  return { session, onboardingRequired: true };
}

/** The credential an existing account signs in with. */
export interface PhoneCredentials {
  /** E.164 (`+919876543210`), normalised by the route. */
  phoneE164: string;
  password: string;
}

/**
 * Signs a member in with a phone number and a password.
 *
 * Three answers, each one deliberate:
 *
 *   * an unknown number runs one scrypt comparison against the dummy hash and
 *     fails with the *same* code and sentence as a wrong password, so the endpoint
 *     cannot be used to find out which numbers are registered;
 *   * a number whose account has no password (created by a one-time code) runs the
 *     same comparison and then answers `password_not_set`, because "that number
 *     signs in with a code" is something the member has to be told - and the timing
 *     gives nothing away, since the work is identical;
 *   * a disabled account is named only after the password has matched.
 *
 * There is no "confirm the number first" gate, unlike the email path: registering
 * with a password checks no code, so gating on `phone_verified_at` would lock out
 * every account this endpoint creates. The number is an identifier here, and the
 * password is the secret.
 */
export async function loginWithPhone(input: PhoneCredentials, context: SessionContext): Promise<AuthSession> {
  if (!isE164(input.phoneE164)) {
    throw badRequest('That phone number does not look right.', { field: 'phone' });
  }

  const user = await findUserByPhone(input.phoneE164);

  if (!user) {
    await verifyPassword(input.password, await dummyPasswordHash());
    throw new AppError('invalid_credentials', 401, 'That phone number and password do not match an account.');
  }

  // The column is nullable since 0008, so a phone-only account reaches this
  // branch. No password is ever assigned to it here.
  if (user.password_hash === null) {
    await verifyPassword(input.password, await dummyPasswordHash());
    throw new AppError(
      'password_not_set',
      409,
      'That account has no password on it yet. Ask whoever runs Unihood to set one, then sign in with it.',
    );
  }

  if (!(await verifyPassword(input.password, user.password_hash))) {
    throw new AppError('invalid_credentials', 401, 'That phone number and password do not match an account.');
  }

  if (user.disabled_at !== null) {
    throw new AppError('account_disabled', 403, 'This account has been switched off. Contact whoever runs Unihood.');
  }

  // Opportunistic upgrade: raise an old hash to the current cost on a correct
  // password, which is the only moment the plaintext is available.
  if (needsRehash(user.password_hash)) {
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(input.password), user.id]);
  }

  return startSessionForUser(user.id, context);
}

interface VerificationTokenRow extends RowDataPacket {
  id: string;
  user_id: string;
  expires_at: Date;
  consumed_at: Date | null;
  redirect_to: string | null;
  email: string;
  display_name: string;
}

export interface EmailVerificationOutcome {
  email: string;
  displayName: string;
  redirectTo: string | null;
}

/**
 * Confirms an address from a link in an email.
 *
 * The token is consumed by an `UPDATE ... WHERE consumed_at IS NULL` rather than
 * a read-then-write, so two simultaneous clicks cannot both succeed: the loser
 * sees `affectedRows = 0` and is told the link was already used.
 */
export async function verifyEmail(token: string): Promise<EmailVerificationOutcome> {
  const [rows] = await pool.query<VerificationTokenRow[]>(
    `SELECT t.id, t.user_id, t.expires_at, t.consumed_at, t.redirect_to, u.email, u.display_name
       FROM email_verification_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?
      LIMIT 1`,
    [hashToken(token)],
  );

  const row = rows[0];
  if (!row) throw new AppError('invalid_token', 400, 'That confirmation link is not valid. Ask for a new one.');
  if (row.consumed_at !== null) {
    throw new AppError('invalid_token', 400, 'That confirmation link has already been used.');
  }
  if (row.expires_at.getTime() <= Date.now()) {
    throw new AppError('token_expired', 400, 'That confirmation link has expired. Ask for a new one.');
  }

  await withTransaction(async (connection) => {
    const [result] = await connection.query<ResultSetHeader>(
      'UPDATE email_verification_tokens SET consumed_at = NOW(3) WHERE id = ? AND consumed_at IS NULL',
      [row.id],
    );
    if (result.affectedRows === 0) {
      throw new AppError('invalid_token', 400, 'That confirmation link has already been used.');
    }

    // COALESCE keeps a second, older link from resetting a timestamp that is
    // already set.
    await connection.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW(3)) WHERE id = ?', [
      row.user_id,
    ]);
  });

  return { email: row.email, displayName: row.display_name, redirectTo: row.redirect_to };
}

/**
 * Issues a fresh confirmation link.
 *
 * Returns `null` rather than an error when the address is unknown or already
 * confirmed: the route answers 202 either way, so this endpoint cannot be used
 * to find out which addresses are registered.
 */
export async function resendVerification(email: string, redirectTo: string | null): Promise<EmailDispatch | null> {
  const user = await findUserByEmail(normalizeEmail(email));
  // The `email === null` case cannot happen for a row found by address; the guard
  // exists because the column is nullable since 0008 and TypeScript is right to
  // insist on it.
  if (!user || user.email === null || user.email_verified_at !== null) return null;

  return dispatchVerificationEmail(user.id, user.email, user.display_name, redirectTo);
}

// -----------------------------------------------------------------------------
// Sign-in and sessions
// -----------------------------------------------------------------------------

/**
 * Signs a member in.
 *
 * The unknown-address branch still performs one scrypt comparison (against a
 * fixed dummy hash) so that response time does not reveal whether the address is
 * registered, and it fails with the *same* error as a wrong password.
 *
 * The "not verified yet" branch is different on purpose: a member who mistyped
 * their password should be told that, and a member who simply has not opened the
 * confirmation email needs the message that tells them what to do.
 */
export async function login(email: string, password: string, context: SessionContext): Promise<AuthSession> {
  const user = await findUserByEmail(normalizeEmail(email));

  if (!user) {
    await verifyPassword(password, await dummyPasswordHash());
    throw new AppError('invalid_credentials', 401, 'That email and password do not match an account.');
  }

  // An account created through phone sign-in has no password hash at all
  // (migration 0008 makes the column nullable). Running the same dummy
  // comparison keeps the response time identical to a wrong password, and the
  // answer is deliberately the same too: this endpoint must not become an oracle
  // for "that address exists, but it signs in with a phone".
  const passwordMatches =
    user.password_hash !== null && (await verifyPassword(password, user.password_hash));

  if (!passwordMatches) {
    throw new AppError('invalid_credentials', 401, 'That email and password do not match an account.');
  }

  // A row that can only have been reached with a password hash set, so this is a
  // narrow to `string` rather than a second lookup.
  const passwordHash = user.password_hash as string;

  if (user.email_verified_at === null) {
    throw new AppError('email_not_verified', 403, 'Confirm your email address first - the link we sent is still waiting.');
  }

  if (user.disabled_at !== null) {
    throw new AppError('account_disabled', 403, 'This account has been switched off. Contact whoever runs Unihood.');
  }

  // Opportunistic upgrade: raise an old hash to the current cost on a correct
  // password, which is the only moment the plaintext is available.
  if (needsRehash(passwordHash)) {
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), user.id]);
  }

  const session = await createSession(user, context);
  await pool.query('UPDATE users SET last_login_at = NOW(3) WHERE id = ?', [user.id]);
  return session;
}

/**
 * Opens a session for an account that has already proved who it is.
 *
 * Phone sign-in shares this with password sign-in, so a verified code and a
 * correct password produce the *same* session: same access-token TTL, same
 * rotating refresh session, same per-account session cap. Nothing in the session
 * machinery knows which of the two credentials was presented.
 *
 * `unauthorized` when the account has gone (deleted between the code check and
 * here), and `account_disabled` when an administrator has switched it off - the
 * device that holds the phone number is told, and no session is created.
 */
export async function startSessionForUser(userId: string, context: SessionContext): Promise<AuthSession> {
  const [rows] = await pool.query<UserRow[]>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`, [userId]);
  const user = rows[0];

  if (!user) {
    throw new AppError('unauthorized', 401, 'Your account could not be found. Sign in again.');
  }

  if (user.disabled_at !== null) {
    throw new AppError('account_disabled', 403, 'This account has been switched off. Contact whoever runs Unihood.');
  }

  const session = await createSession(user, context);
  await pool.query('UPDATE users SET last_login_at = NOW(3) WHERE id = ?', [user.id]);
  return session;
}

/**
 * Opens a refresh session and signs the matching access token.
 *
 * The number of live sessions per account is capped. The oldest are revoked
 * rather than the new sign-in refused, so signing in on another device never
 * locks anyone out - it makes room.
 */
async function createSession(user: AuthenticatedUserRow, context: SessionContext): Promise<AuthSession> {
  const sessionId = newId();
  const refreshToken = createOpaqueToken();
  const refreshExpiresAt = dateFromNow(env.tokens.refreshTtlSeconds);

  await withTransaction(async (connection) => {
    await connection.query(
      `UPDATE refresh_sessions
          SET revoked_at = NOW(3), revoked_reason = 'replaced'
        WHERE user_id = ?
          AND revoked_at IS NULL
          AND id NOT IN (
            SELECT id FROM (
              SELECT id
                FROM refresh_sessions
               WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW(3)
               ORDER BY created_at DESC
               LIMIT ?
            ) AS keep
          )`,
      [user.id, user.id, env.tokens.maxActiveRefreshSessions],
    );

    await connection.query(
      `INSERT INTO refresh_sessions (id, user_id, token_hash, expires_at, user_agent, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, user.id, hashToken(refreshToken), refreshExpiresAt, context.userAgent, context.ipAddress],
    );
  });

  const access = signAccessToken({ userId: user.id, sessionId });

  return {
    user: toAuthenticatedUser(user),
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    expiresInSeconds: env.tokens.accessTtlSeconds,
  };
}

// -----------------------------------------------------------------------------
// Refresh, sign-out and password recovery
// -----------------------------------------------------------------------------

interface SessionRow extends RowDataPacket {
  id: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  email: string | null;
  phone_e164: string | null;
  display_name: string;
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  disabled_at: Date | null;
}

const SESSION_LOOKUP = `
  SELECT rs.id, rs.user_id, rs.expires_at, rs.revoked_at,
         u.email, u.phone_e164, u.display_name, u.email_verified_at, u.phone_verified_at, u.disabled_at
    FROM refresh_sessions rs
    JOIN users u ON u.id = rs.user_id
   WHERE rs.token_hash = ?
   LIMIT 1`;

/** Revokes every live session for an account. */
export async function revokeAllSessions(userId: string, reason: string): Promise<void> {
  await pool.query(
    'UPDATE refresh_sessions SET revoked_at = NOW(3), revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
    [reason, userId],
  );
}

/**
 * Exchanges a refresh token for a new access/refresh pair.
 *
 * Re-use of a token that was already rotated or revoked is treated as a
 * compromise and revokes everything for the account. That is what turns token
 * rotation from a formality into a control: a stolen refresh token works at most
 * once, and using it then locks the attacker out along with the real device.
 */
export async function refreshSession(refreshToken: string, context: SessionContext): Promise<AuthSession> {
  const [rows] = await pool.query<SessionRow[]>(SESSION_LOOKUP, [hashToken(refreshToken)]);
  const session = rows[0];

  if (!session) throw sessionExpired();

  if (session.revoked_at !== null) {
    await revokeAllSessions(session.user_id, 'reuse_detected');
    throw sessionExpired();
  }

  if (session.expires_at.getTime() <= Date.now()) {
    await pool.query(
      "UPDATE refresh_sessions SET revoked_at = NOW(3), revoked_reason = 'expired' WHERE id = ? AND revoked_at IS NULL",
      [session.id],
    );
    throw sessionExpired();
  }

  if (session.disabled_at !== null) {
    await revokeAllSessions(session.user_id, 'account_disabled');
    throw new AppError('account_disabled', 403, 'This account has been switched off. Contact whoever runs Unihood.');
  }

  // The presented session is retired and its replacement issued in one
  // transaction, so a failure cannot leave the member with no usable token.
  const sessionId = newId();
  const nextRefreshToken = createOpaqueToken();
  const refreshExpiresAt = dateFromNow(env.tokens.refreshTtlSeconds);

  await withTransaction(async (connection) => {
    const [rotated] = await connection.query<ResultSetHeader>(
      `UPDATE refresh_sessions
          SET revoked_at = NOW(3), revoked_reason = 'rotated', last_used_at = NOW(3)
        WHERE id = ? AND revoked_at IS NULL`,
      [session.id],
    );

    // Lost a race against another refresh of the same token.
    if (rotated.affectedRows === 0) {
      throw sessionExpired('This sign-in was replaced by a newer one. Sign in again to continue.');
    }

    await connection.query(
      `INSERT INTO refresh_sessions (id, user_id, token_hash, expires_at, user_agent, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, session.user_id, hashToken(nextRefreshToken), refreshExpiresAt, context.userAgent, context.ipAddress],
    );
  });

  const access = signAccessToken({ userId: session.user_id, sessionId });

  return {
    user: toAuthenticatedUser({
      id: session.user_id,
      email: session.email,
      phone_e164: session.phone_e164,
      display_name: session.display_name,
      email_verified_at: session.email_verified_at,
      phone_verified_at: session.phone_verified_at,
    }),
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken: nextRefreshToken,
    refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    expiresInSeconds: env.tokens.accessTtlSeconds,
  };
}

/**
 * Revokes the session behind a refresh token.
 *
 * Idempotent and silent: signing out twice, or with a token this server has
 * never seen, is a success from the client's point of view - there is nothing
 * left to do.
 */
export async function logout(refreshToken: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_sessions
        SET revoked_at = COALESCE(revoked_at, NOW(3)),
            revoked_reason = COALESCE(revoked_reason, 'signed_out')
      WHERE token_hash = ?`,
    [hashToken(refreshToken)],
  );
}

/**
 * Issues a password-reset link.
 *
 * Returns `null` for an unknown address (the route answers 202 regardless, so
 * this cannot be used to enumerate accounts). Any outstanding link for the same
 * account is consumed first, which is what makes "only the newest link works"
 * true rather than merely likely.
 */
export async function requestPasswordReset(email: string, redirectTo: string | null): Promise<EmailDispatch | null> {
  const user = await findUserByEmail(normalizeEmail(email));
  // A phone-only account has no address, so it can never be found here - the
  // guard makes that explicit rather than relying on it.
  if (!user || user.email === null || user.disabled_at !== null) return null;

  await pool.query('UPDATE password_reset_tokens SET consumed_at = NOW(3) WHERE user_id = ? AND consumed_at IS NULL', [
    user.id,
  ]);

  return dispatchPasswordResetEmail(user.id, user.email, user.display_name, redirectTo);
}

interface ResetTokenRow extends RowDataPacket {
  id: string;
  user_id: string;
  expires_at: Date;
  consumed_at: Date | null;
  email: string;
  display_name: string;
}

/**
 * Sets a new password from a reset link.
 *
 * One transaction does all three things that must not be separable: consume the
 * token, replace the hash, and revoke every live session. A password change that
 * left old sessions alive would be theatre.
 */
export async function resetPassword(token: string, password: string): Promise<void> {
  const [rows] = await pool.query<ResetTokenRow[]>(
    `SELECT t.id, t.user_id, t.expires_at, t.consumed_at, u.email, u.display_name
       FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?
      LIMIT 1`,
    [hashToken(token)],
  );

  const row = rows[0];
  if (!row) throw new AppError('invalid_token', 400, 'That password link is not valid. Ask for a new one.');
  if (row.consumed_at !== null) {
    throw new AppError('invalid_token', 400, 'That password link has already been used. Ask for a new one.');
  }
  if (row.expires_at.getTime() <= Date.now()) {
    throw new AppError('token_expired', 400, 'That password link has expired. Ask for a new one.');
  }

  assertPasswordAcceptable(password, { email: row.email, displayName: row.display_name });
  const passwordHash = await hashPassword(password);

  await withTransaction(async (connection) => {
    const [result] = await connection.query<ResultSetHeader>(
      'UPDATE password_reset_tokens SET consumed_at = NOW(3) WHERE id = ? AND consumed_at IS NULL',
      [row.id],
    );
    if (result.affectedRows === 0) {
      throw new AppError('invalid_token', 400, 'That password link has already been used. Ask for a new one.');
    }

    await connection.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, row.user_id]);
    await connection.query(
      "UPDATE refresh_sessions SET revoked_at = NOW(3), revoked_reason = 'password_changed' WHERE user_id = ? AND revoked_at IS NULL",
      [row.user_id],
    );
  });
}

// -----------------------------------------------------------------------------
// Changing the password of a signed-in account
// -----------------------------------------------------------------------------

/**
 * Replaces the password of the account that is signed in.
 *
 * Three rules, all of them deliberate:
 *
 *   1. **The current password is required.** A session is not treated as proof of
 *      ownership: an unlocked or borrowed phone would otherwise be enough to lock
 *      the owner out of their own account.
 *   2. **The new password has to be different.** Replacing a hash with a hash of
 *      the password it already verifies would answer "changed" while nothing
 *      changed, and the one scrypt comparison that catches it is cheaper than the
 *      confusion it prevents.
 *   3. **Every *other* session is revoked, and this one is not.** A live session
 *      was opened with the old password, which is exactly what a password change
 *      is meant to end - but signing the member out of the device they are holding
 *      would be a worse answer than the problem it solves.
 *
 * A phone-only account (`password_hash IS NULL`, created by a code in an earlier
 * version) has no current password to verify, so this endpoint cannot be the way a
 * password appears on it: one dummy comparison runs first so the timing still says
 * nothing, and the answer is `password_not_set`, exactly as `/login` gives.
 */
export async function changePassword(
  userId: string,
  sessionId: string | null,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const [rows] = await pool.query<UserRow[]>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`, [userId]);
  const user = rows[0];
  if (!user) throw new AppError('unauthorized', 401, 'Your account could not be found. Sign in again.');

  if (user.password_hash === null) {
    await verifyPassword(input.currentPassword, await dummyPasswordHash());
    throw new AppError(
      'password_not_set',
      409,
      'That account has no password on it yet. Ask whoever runs Unihood to set one, then sign in with it.',
    );
  }

  if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
    throw new AppError('invalid_credentials', 401, 'That password does not match this account.');
  }

  assertPasswordAcceptable(input.newPassword, { phone: user.phone_e164, displayName: user.display_name });

  if (await verifyPassword(input.newPassword, user.password_hash)) {
    throw badRequest('Your new password needs to be different from your current one.', { field: 'newPassword' });
  }

  const passwordHash = await hashPassword(input.newPassword);

  await withTransaction(async (connection) => {
    await connection.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);

    // The `id <> ?` guard only holds when there is a session to spare: a NULL
    // there compares false against every row, which would revoke nothing at all.
    if (sessionId === null) {
      await connection.query(
        "UPDATE refresh_sessions SET revoked_at = NOW(3), revoked_reason = 'password_changed' WHERE user_id = ? AND revoked_at IS NULL",
        [userId],
      );
      return;
    }

    await connection.query(
      `UPDATE refresh_sessions
          SET revoked_at = NOW(3), revoked_reason = 'password_changed'
        WHERE user_id = ? AND revoked_at IS NULL AND id <> ?`,
      [userId, sessionId],
    );
  });
}

/** The caller's own account row, for `GET /api/auth/me`. */
export async function getAuthenticatedUser(userId: string): Promise<AuthenticatedUser> {
  const [rows] = await pool.query<UserRow[]>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`, [userId]);
  const row = rows[0];
  if (!row) throw new AppError('unauthorized', 401, 'Your account could not be found. Sign in again.');
  return toAuthenticatedUser(row);
}

/**
 * Reads the deep link stored with a reset token, **without consuming it**.
 *
 * The email link lands on this API, which has to know where to bounce the
 * browser next; the target was recorded when the link was requested, so it cannot
 * be influenced by whoever opens the message. Consumption happens later, in
 * `resetPassword`, so a member who abandons the reset screen can still use the
 * same link.
 *
 * Returns `null` for an unknown, spent or expired token - the caller renders a
 * page saying so rather than forwarding a dead token to the app.
 */
export async function findPasswordResetRedirect(token: string): Promise<string | null> {
  const [rows] = await pool.query<ResetTokenRow[]>(
    `SELECT t.id, t.user_id, t.expires_at, t.consumed_at, u.email, u.display_name
       FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?
      LIMIT 1`,
    [hashToken(token)],
  );

  const row = rows[0];
  if (!row || row.consumed_at !== null || row.expires_at.getTime() <= Date.now()) return null;
  return row.redirect_to;
}
