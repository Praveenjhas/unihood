/**
 * End-to-end smoke test.
 *
 *   npm run smoke                       # against http://127.0.0.1:$API_PORT
 *   SMOKE_BASE_URL=http://host:4000 npm run smoke
 *   npm run smoke:clean                 # delete accounts an interrupted run left behind
 *
 * (`npm run smoke -- --clean` does not work from PowerShell: it strips the `--`,
 * so npm reads `--clean` as one of its own flags. `smoke:clean` avoids the issue
 * on every shell.)
 *
 * What it is for: the API is the security boundary now, so the things worth
 * proving are not "does the endpoint answer" but the *rules* - that a second
 * member cannot read or move a first member's coordinates, that a distance only
 * appears when both sides consented, that a refresh token rotates and cannot be
 * replayed, and that a spent link stays spent.
 *
 * How it stays honest:
 *   * it uses the real HTTP surface for every claim it makes about behaviour;
 *   * where a claim is "the database did not change", it reads the database
 *     directly through the same pool the server uses - the script is server-side
 *     code, and reading a coordinate as the server is exactly what the API
 *     refuses to do on a member's behalf;
 *   * the accounts it creates are named `smoke-<timestamp>-*@unihood.invalid`,
 *     and it deletes them (cascading to profiles, locations, sessions and tokens)
 *     on the way out, including when a step fails.
 *
 * It needs `EXPOSE_DEV_TOKENS=true` and `MAIL_TRANSPORT=log` (the development
 * defaults) so it can finish the email flows without a mailbox. It also makes
 * around 50 requests through the auth rate-limit bucket, so a development
 * `AUTH_RATE_LIMIT_MAX_REQUESTS` that a person would never notice (the default
 * 40 per 15 minutes) will cut a run short - `backend/.env` is sized for it, and
 * the summary says so if a 429 ever appears.
 *
 * Since Phase 7 it also opens **real Socket.IO connections** to the running API
 * (`/realtime`) for the group-chat checks - authorization on the handshake, room
 * membership, delivery and the refusal a revoked session gets - and one section
 * deliberately spends a whole member's message budget over those sockets
 * (`MESSAGE_RATE_LIMIT_MAX_REQUESTS`, 300 writes by default) to prove the ceiling is
 * shared by both transports. That section is sized for the development
 * `MESSAGE_RATE_LIMIT_*` values as well. None of it needs anything but a running
 * API (like every other check).
 *
 * The last section covers the credential the app asks for now - **a phone number
 * and a password**: that registering stores a scrypt hash and not the password,
 * that a number is claimed exactly once, that a wrong password and an unknown
 * number are indistinguishable, that a phone-only account is told
 * `password_not_set` rather than given a password, and that the session it opens
 * refreshes, is revoked by sign-out and can create a group and an event.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { io, type Socket } from 'socket.io-client';

import { pool } from '../db/pool';
import { env } from '../config/env';
import { REALTIME_PATH } from '../domain/chat';

const BASE_URL = (process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${env.api.port}`).replace(/\/+$/, '');
const RUN_ID = Date.now().toString(36);

let passed = 0;
let failed = 0;
/** Counted separately: a 429 makes every later check meaningless, so it is called out. */
let rateLimited = 0;

function section(title: string): void {
  console.log(`\n${title}`);
}

function assert(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }

  failed += 1;
  const suffix = detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`;
  console.log(`  FAIL  ${label}${suffix}`);
}

interface ApiResponse {
  status: number;
  body: unknown;
  location: string | null;
  /** Every response header, so a check can read what the API promised a client. */
  headers: Headers;
}

type Json = Record<string, unknown>;

async function call(
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null; followRedirects?: boolean; expectRateLimit?: boolean } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: options.followRedirects === false ? 'manual' : 'follow',
  });

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  // Counted separately: a 429 makes every later check meaningless, so it is
  // called out. Only the *middleware's* per-IP refusal counts - the per-number
  // `otp_throttled` and `otp_attempts_exceeded` refusals are deliberate parts of
  // the Phase 5 checks and must not make the summary cry wolf, and a check that
  // provokes a refusal on purpose says so with `expectRateLimit`.
  const envelope: ApiResponse = {
    status: response.status,
    body,
    location: response.headers.get('location'),
    headers: response.headers,
  };

  if (!options.expectRateLimit && response.status === 429 && errorCode(envelope) === 'rate_limited') {
    rateLimited += 1;
  }

  return envelope;
}

const errorCode = (response: ApiResponse): unknown =>
  (response.body as { error?: { code?: unknown } } | null)?.error?.code;

/** Pulls the single-use token out of a link the `log` mail transport returned. */
function tokenFromLink(link: string): string {
  return new URL(link).searchParams.get('token') ?? '';
}

function makeEmail(label: string): string {
  // `.invalid` is reserved by RFC 2606, so a stray send can never reach a person.
  return `smoke-${RUN_ID}-${label}@unihood.invalid`;
}

const PASSWORD = 'Unihood-Smoke-2026';
const NEW_PASSWORD = 'Unihood-Smoke-2026-rotated';

function at<T = unknown>(body: unknown, ...path: readonly string[]): T | undefined {
  let current: unknown = body;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as T;
}

interface Account {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

interface RegisterOptions {
  displayName: string;
  redirectTo?: string;
  password?: string;
}

async function registerUser(email: string, options: RegisterOptions): Promise<ApiResponse> {
  return call('POST', '/api/auth/register', {
    body: {
      email,
      password: options.password ?? PASSWORD,
      displayName: options.displayName,
      ...(options.redirectTo === undefined ? {} : { redirectTo: options.redirectTo }),
    },
  });
}

async function loginUser(email: string, password: string = PASSWORD): Promise<ApiResponse> {
  return call('POST', '/api/auth/login', { body: { email, password } });
}

/** Registers, confirms through the API and signs in - the ordinary happy path. */
async function createVerifiedAccount(label: string, displayName: string): Promise<Account> {
  const email = makeEmail(label);
  const registered = await registerUser(email, { displayName });
  const devLink = String(at<string>(registered.body, 'email', 'devLink') ?? '');

  const verified = await call('POST', '/api/auth/verify-email', { body: { token: tokenFromLink(devLink) } });
  if (verified.status !== 200) {
    throw new Error(`Smoke setup failed to verify ${email}: ${verified.status} ${JSON.stringify(verified.body)}`);
  }

  const session = await loginUser(email);
  const accessToken = at<string>(session.body, 'accessToken');
  const refreshToken = at<string>(session.body, 'refreshToken');
  const id = at<string>(session.body, 'user', 'id');

  if (!accessToken || !refreshToken || !id) {
    throw new Error(`Smoke setup failed to sign ${email} in: ${session.status} ${JSON.stringify(session.body)}`);
  }

  // Registered for cleanup here rather than by each caller: an account this
  // helper created must be removed even if a check that runs after this one
  // aborts the whole run.
  created.push(id);

  return { id, email, accessToken, refreshToken };
}

/** Coordinates are only ever read here, never returned by the API under test. */
async function readStoredCoordinate(userId: string): Promise<{ latitude: number; longitude: number } | null> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT latitude, longitude FROM user_locations WHERE user_id = ?',
    [userId],
  );
  const row = rows[0];
  return row ? { latitude: Number(row.latitude), longitude: Number(row.longitude) } : null;
}

/**
 * A group's own anchor, read directly.
 *
 * Used to prove that a *place* anchor does not move when the person who created
 * it moves - the API never returns a coordinate, so the database is the only
 * place that answer exists.
 */
async function readGroupAnchor(groupId: string): Promise<{ latitude: number; longitude: number } | null> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT latitude, longitude FROM group_locations WHERE group_id = ?',
    [groupId],
  );
  const row = rows[0];
  return row ? { latitude: Number(row.latitude), longitude: Number(row.longitude) } : null;
}

/** An event's own venue anchor, read the same way and for the same reason. */
async function readEventAnchor(eventId: string): Promise<{ latitude: number; longitude: number } | null> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT latitude, longitude FROM event_locations WHERE event_id = ?',
    [eventId],
  );
  const row = rows[0];
  return row ? { latitude: Number(row.latitude), longitude: Number(row.longitude) } : null;
}

// -----------------------------------------------------------------------------
// Phone sign-in helpers
//
// A one-time code is *never* returned in a response - that is the point of the
// design - so the only honest way for this script to finish the flow is to read
// the file the development transport wrote, exactly as a developer does. The
// `.invalid` domain does the same job for email; for a phone number the reserved
// `+999` country code does it, and it doubles as the marker `--clean` looks for.
// -----------------------------------------------------------------------------

// Starts at 100000 so the subscriber part can never begin with `0`, which the API
// (correctly) rejects as a local-format number.
let phoneCounter = 100000 + (Date.now() % 800000);

/** A fresh, never-real E.164 number: `+999` is not an assigned country code. */
function makePhone(label: string): string {
  phoneCounter += 1;
  return `+999${String(phoneCounter)}${String(label.length).padStart(3, '0')}`;
}

/** Splits an E.164 value into the two fields the API expects. */
function phoneFields(phone: string): { countryCode: string; nationalNumber: string } {
  const digits = phone.replace(/\D+/g, '');
  return { countryCode: digits.slice(0, 3), nationalNumber: digits.slice(3) };
}

async function requestOtpFor(phone: string): Promise<ApiResponse> {
  return call('POST', '/api/auth/otp/request', { body: phoneFields(phone) });
}

async function verifyOtpFor(phone: string, code: string): Promise<ApiResponse> {
  return call('POST', '/api/auth/otp/verify', { body: { ...phoneFields(phone), code } });
}

/**
 * Creates an account with a phone number and a password - the flow the app uses
 * today - so a section can assert what that credential does.
 */
async function registerPhoneUser(
  phone: string,
  options: { displayName: string; password?: string },
): Promise<ApiResponse> {
  return call('POST', '/api/auth/register', {
    body: {
      phone: phoneFields(phone),
      password: options.password ?? PASSWORD,
      displayName: options.displayName,
    },
  });
}

/** Signs in with a phone number and a password. */
async function loginPhoneUser(phone: string, password: string = PASSWORD): Promise<ApiResponse> {
  return call('POST', '/api/auth/login', { body: { phone: phoneFields(phone), password } });
}

const OTP_OUTBOX_DIR = path.resolve(__dirname, '..', '..', '.otp-outbox');

/**
 * The code from the newest outbox file whose name ends with the number's last
 * four digits.
 *
 * The file name is the *masked* number (see `lib/otpTransport.ts`), so the last
 * four digits are the only part that identifies it - which is exactly what a
 * developer reading the directory does by eye.
 */
async function readLatestOtp(phone: string): Promise<string> {
  const lastFour = phone.slice(-4);
  const entries = await readdir(OTP_OUTBOX_DIR);
  const candidates: { file: string; at: number }[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.txt')) continue;
    if (!entry.replace(/[^0-9]/g, '').endsWith(lastFour)) continue;
    const entryStat = await stat(path.join(OTP_OUTBOX_DIR, entry));
    candidates.push({ file: entry, at: entryStat.mtimeMs });
  }

  candidates.sort((left, right) => right.at - left.at);
  const newest = candidates[0];
  if (!newest) throw new Error(`No OTP outbox file for a number ending ${lastFour}.`);

  const body = await readFile(path.join(OTP_OUTBOX_DIR, newest.file), 'utf8');
  const match = /--- one-time code ---\s*\n\s*([0-9]{4,10})/.exec(body);
  if (!match?.[1]) throw new Error(`Could not read a code out of ${newest.file}.`);

  return match[1];
}

/** Skips a number's resend cooldown by moving its challenges back in time. */
async function backdateOtpRequests(phone: string, minutes: number): Promise<void> {
  await pool.query(
    'UPDATE otp_challenges SET created_at = DATE_SUB(NOW(3), INTERVAL ? MINUTE) WHERE phone_e164 = ?',
    [minutes, phone],
  );
}

/**
 * Reads the stored hash for a number's newest challenge to prove the code itself
 * is not in the table.
 *
 * Two claims, both checkable: the column does not equal the code, and it does not
 * equal a plain SHA-256 of the code either - which is what a naive implementation
 * would store, and which a six-digit code's 20 bits of entropy makes worthless.
 */
async function storedCodeIsHashed(phone: string, code: string): Promise<boolean> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT code_hash, LENGTH(code_hash) AS hash_length FROM otp_challenges WHERE phone_e164 = ? ORDER BY created_at DESC LIMIT 1',
    [phone],
  );

  const row = rows[0];
  if (!row) return false;

  const { createHash } = await import('node:crypto');
  const plainSha256 = createHash('sha256').update(code, 'utf8').digest('hex');

  return (
    Number(row.hash_length) === 64 &&
    String(row.code_hash) !== code &&
    String(row.code_hash) !== plainSha256
  );
}


async function deleteAccounts(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  // Cascades to profiles, profile_interests, user_locations, sessions and tokens.
  await pool.query(`DELETE FROM users WHERE id IN (${placeholders})`, [...ids]);
}

const created: string[] = [];

async function runHealthChecks(): Promise<void> {
  section('Health and configuration');

  const health = await call('GET', '/health');
  assert('GET /health answers 200', health.status === 200, health.body);
  assert('GET /health reports the service name', at(health.body, 'service') === 'unihood-api');

  const database = await call('GET', '/health/db');
  assert('GET /health/db answers 200', database.status === 200, database.body);
  assert('database reports as connected', at(database.body, 'connected') === true);
  assert(
    'the expected MySQL major version is running',
    String(at(database.body, 'serverVersion')).startsWith('8.0'),
    at(database.body, 'serverVersion'),
  );
  assert('session time zone is UTC', at(database.body, 'sessionTimeZone') === '+00:00', at(database.body, 'sessionTimeZone'));
  assert(
    'no credential field appears in the health payload',
    !/password|secret|db_user/i.test(JSON.stringify(database.body)),
    database.body,
  );

  const unknown = await call('GET', '/api/definitely-not-a-route');
  assert('an unknown route returns the JSON error envelope', unknown.status === 404 && errorCode(unknown) === 'not_found', unknown.body);

  const unauthorised = await call('GET', '/api/profile/me');
  assert(
    'a protected route without a token returns 401 unauthorized',
    unauthorised.status === 401 && errorCode(unauthorised) === 'unauthorized',
    unauthorised.body,
  );

  const forged = await call('GET', '/api/profile/me', { token: 'not-a-real-token' });
  assert('a forged access token returns 401', forged.status === 401, forged.body);
}

async function runRegistrationChecks(): Promise<void> {
  section('Registration and email confirmation');

  const badEmail = await registerUser('not-an-email', { displayName: 'Bad' });
  assert('an invalid email address is rejected', badEmail.status === 400 && errorCode(badEmail) === 'validation_error', badEmail.body);

  const shortPassword = await registerUser(makeEmail('short'), { displayName: 'Short', password: 'short' });
  assert('a too-short password is rejected', shortPassword.status === 400 && errorCode(shortPassword) === 'validation_error', shortPassword.body);

  const predictable = await registerUser(makeEmail('predictable'), { displayName: 'Predictable', password: 'password123' });
  assert('a common password is rejected', predictable.status === 400 && errorCode(predictable) === 'validation_error', predictable.body);

  const badRedirect = await registerUser(makeEmail('redirect'), {
    displayName: 'Redirect',
    redirectTo: 'https://evil.example.com/steal',
  });
  assert('a non-allow-listed redirect scheme is rejected', badRedirect.status === 400 && errorCode(badRedirect) === 'validation_error', badRedirect.body);
}

/** The browser path: the link in the email is clicked, not posted. */
async function runEmailLinkChecks(): Promise<Account> {
  section('The emailed confirmation link');

  const email = makeEmail('web');
  const registration = await registerUser(email, { displayName: 'Web Member', redirectTo: 'unihood://auth/callback' });
  assert('register returns 201', registration.status === 201, registration.body);
  assert('register reports that confirmation is required', at(registration.body, 'emailVerificationRequired') === true);
  assert(
    'register does not claim a delivery that did not happen',
    at(registration.body, 'email', 'delivered') === false && at(registration.body, 'email', 'transport') === 'log',
    registration.body,
  );

  const devLink = String(at<string>(registration.body, 'email', 'devLink') ?? '');
  assert('a development link is returned while no provider is configured', devLink.includes('/auth/verify-email?token='));

  const linkUrl = new URL(devLink);
  const clicked = await call('GET', `${linkUrl.pathname}${linkUrl.search}`, { followRedirects: false });
  assert('the emailed link redirects into the app', clicked.status === 302, clicked.body);
  assert(
    'the redirect goes to the recorded deep link, with verified=1',
    String(clicked.location).startsWith('unihood://auth/callback?verified=1'),
    clicked.location,
  );

  const session = await loginUser(email);
  assert('the confirmed account can then sign in', session.status === 200, session.body);

  const account: Account = {
    id: String(at(session.body, 'user', 'id') ?? ''),
    email,
    accessToken: String(at<string>(session.body, 'accessToken') ?? ''),
    refreshToken: String(at<string>(session.body, 'refreshToken') ?? ''),
  };
  if (account.id) created.push(account.id);
  return account;
}

/** The app path: the token is posted to the API, and is single-use. */
async function runVerifyApiChecks(): Promise<Account> {
  section('Confirmation through the API');

  const email = makeEmail('api');
  const registration = await registerUser(email, { displayName: 'Api Member' });
  const token = tokenFromLink(String(at<string>(registration.body, 'email', 'devLink') ?? ''));

  const first = await call('POST', '/api/auth/verify-email', { body: { token } });
  assert('the token confirms the address', first.status === 200 && at(first.body, 'verified') === true, first.body);

  const second = await call('POST', '/api/auth/verify-email', { body: { token } });
  assert('the same token cannot be used twice', second.status === 400 && errorCode(second) === 'invalid_token', second.body);

  const bogus = await call('POST', '/api/auth/verify-email', { body: { token: 'a'.repeat(32) } });
  assert('an unknown token is refused', bogus.status === 400 && errorCode(bogus) === 'invalid_token', bogus.body);

  const session = await loginUser(email);
  assert('the confirmed account can sign in', session.status === 200, session.body);

  const account: Account = {
    id: String(at(session.body, 'user', 'id') ?? ''),
    email,
    accessToken: String(at<string>(session.body, 'accessToken') ?? ''),
    refreshToken: String(at<string>(session.body, 'refreshToken') ?? ''),
  };
  if (account.id) created.push(account.id);
  return account;
}

async function runSignInGuardChecks(): Promise<void> {
  section('Sign-in guards and account enumeration');

  const unverifiedEmail = makeEmail('unverified');
  const registration = await registerUser(unverifiedEmail, { displayName: 'Unverified' });
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>('SELECT id FROM users WHERE email = ?', [
    unverifiedEmail,
  ]);
  if (rows[0]) created.push(String(rows[0].id));

  const beforeVerification = await loginUser(unverifiedEmail);
  assert(
    'signing in before confirming returns email_not_verified',
    beforeVerification.status === 403 && errorCode(beforeVerification) === 'email_not_verified',
    beforeVerification.body,
  );

  const wrongPassword = await loginUser(unverifiedEmail, 'Wrong-Password-2026');
  assert(
    'a wrong password returns invalid_credentials',
    wrongPassword.status === 401 && errorCode(wrongPassword) === 'invalid_credentials',
    wrongPassword.body,
  );

  const unknownAccount = await loginUser(makeEmail('nobody'));
  assert(
    'an unknown address gives the same code as a wrong password (no account oracle)',
    unknownAccount.status === 401 && errorCode(unknownAccount) === 'invalid_credentials',
    unknownAccount.body,
  );

  const duplicate = await registerUser(unverifiedEmail, { displayName: 'Duplicate', password: 'Another-Password-2026' });
  assert(
    'registering an address that is already taken re-sends the confirmation instead of failing',
    duplicate.status === 201 && at(duplicate.body, 'emailVerificationRequired') === true,
    duplicate.body,
  );

  const resend = await call('POST', '/api/auth/resend-verification', { body: { email: unverifiedEmail } });
  assert('resend answers 202', resend.status === 202, resend.body);
  assert(
    'resend returns a fresh development link',
    String(at<string>(resend.body, 'email', 'devLink') ?? '').includes('/auth/verify-email?token='),
  );

  const ghost = await call('POST', '/api/auth/resend-verification', { body: { email: makeEmail('ghost') } });
  assert('resend for an unknown address also answers 202 (no oracle)', ghost.status === 202, ghost.body);
  assert('register cannot confirm an address it does not own', registration.status === 201 && at(registration.body, 'email', 'devLink') !== undefined);
}

async function runProfileChecks(account: Account): Promise<void> {
  section('Profile read, write and validation');

  const initial = await call('GET', '/api/profile/me', { token: account.accessToken });
  assert('GET /api/profile/me answers 200', initial.status === 200, initial.body);
  assert('the profile belongs to the caller', at(initial.body, 'profile', 'id') === account.id);
  assert('a new profile is not complete yet', at(initial.body, 'profile', 'profileCompleted') === false);
  assert(
    'the profile payload carries no coordinates',
    !('latitude' in (at<Json>(initial.body, 'profile') ?? {})) && !('longitude' in (at<Json>(initial.body, 'profile') ?? {})),
    at(initial.body, 'profile'),
  );

  const wrongInterest = await call('PUT', '/api/profile/me', {
    token: account.accessToken,
    body: {
      displayName: 'Smoke A',
      interestIds: ['sports', 'not-a-real-interest'],
      isDiscoverable: true,
      nearbyDiscoveryEnabled: false,
    },
  });
  assert(
    'an unknown interest id is rejected',
    wrongInterest.status === 400 && errorCode(wrongInterest) === 'validation_error',
    wrongInterest.body,
  );

  const longBio = await call('PUT', '/api/profile/me', {
    token: account.accessToken,
    body: { displayName: 'Smoke A', bio: 'x'.repeat(400), interestIds: [], isDiscoverable: true, nearbyDiscoveryEnabled: false },
  });
  assert('an over-long bio is rejected', longBio.status === 400 && errorCode(longBio) === 'validation_error', longBio.body);

  const noName = await call('PUT', '/api/profile/me', {
    token: account.accessToken,
    body: { displayName: '   ', interestIds: [], isDiscoverable: true, nearbyDiscoveryEnabled: false },
  });
  assert('a blank display name is rejected', noName.status === 400 && errorCode(noName) === 'validation_error', noName.body);

  const consentContradiction = await call('PUT', '/api/profile/me', {
    token: account.accessToken,
    body: { displayName: 'Smoke A', interestIds: ['sports'], isDiscoverable: false, nearbyDiscoveryEnabled: true },
  });
  assert(
    'nearby discovery without a discoverable profile is rejected',
    consentContradiction.status === 400 && errorCode(consentContradiction) === 'validation_error',
    consentContradiction.body,
  );

  const saved = await call('PUT', '/api/profile/me', {
    token: account.accessToken,
    body: {
      displayName: 'Smoke Member A',
      bio: 'Smoke-testing Unihood.',
      locationLabel: 'Smoke Area',
      interestIds: ['sports', 'coding', 'music'],
      isDiscoverable: true,
      nearbyDiscoveryEnabled: true,
    },
  });
  assert('a valid profile saves', saved.status === 200, saved.body);
  assert('saving marks the profile complete', at(saved.body, 'profile', 'profileCompleted') === true);
  assert(
    'the interest set is stored exactly as selected',
    JSON.stringify(at(saved.body, 'profile', 'interestIds')) === JSON.stringify(['coding', 'music', 'sports']),
    at(saved.body, 'profile', 'interestIds'),
  );
  assert('nearby consent is stored', at(saved.body, 'profile', 'nearbyDiscoveryEnabled') === true);

  // A body field the API does not declare must not be able to re-target the write.
  const spoofed = await call('PUT', '/api/profile/me', {
    token: account.accessToken,
    body: {
      displayName: 'Smoke Member A',
      interestIds: ['sports', 'coding', 'music'],
      isDiscoverable: true,
      nearbyDiscoveryEnabled: true,
      userId: '00000000-0000-0000-0000-000000000000',
      id: '00000000-0000-0000-0000-000000000000',
    },
  });
  assert(
    'an injected id in the body cannot re-target the profile write',
    spoofed.status === 200 && at(spoofed.body, 'profile', 'id') === account.id,
    spoofed.body,
  );
}

async function runInterestChecks(account: Account): Promise<void> {
  section('Interest catalog');

  const anonymous = await call('GET', '/api/interests');
  assert('the catalog requires a session', anonymous.status === 401, anonymous.body);

  const catalog = await call('GET', '/api/interests', { token: account.accessToken });
  assert('GET /api/interests answers 200', catalog.status === 200, catalog.body);

  const interests = at<{ id: string; label: string; category?: string }[]>(catalog.body, 'interests') ?? [];
  assert('the catalogue is the curated one, not the Phase 2 stub', interests.length >= 120, interests.length);
  assert(
    'every entry is an { id, label, category } triple',
    interests.every(
      (entry) => typeof entry.id === 'string' && typeof entry.label === 'string' && typeof entry.category === 'string',
    ),
    interests[0],
  );
  assert('the Phase 1 vocabulary survived the port', interests.some((entry) => entry.id === 'sports'));
  assert('the Phase 2 additions are present too', interests.some((entry) => entry.id === 'photography'));
  assert(
    'the interests Phase 5 names are seeded (UPSC, DSA, anime, hiking)',
    ['upsc', 'dsa', 'anime', 'hiking'].every((id) => interests.some((entry) => entry.id === id)),
    interests.filter((entry) => ['upsc', 'dsa', 'anime', 'hiking'].includes(entry.id)).map((entry) => entry.id),
  );

  // Rows arrive grouped by category, which is what the picker renders from: a
  // broken ORDER BY would scatter the groups and show the same heading twice.
  const categories = interests.map((entry) => entry.category ?? '');
  assert(
    'the catalogue arrives grouped by category',
    categories.every((category, index) => index === 0 || (categories[index - 1] ?? '') <= category),
    categories.slice(0, 4),
  );
  assert('and the groups are the fifteen the product names', new Set(categories).size === 15, new Set(categories).size);
  assert(
    'no interest is listed twice',
    new Set(interests.map((entry) => entry.id)).size === interests.length,
    interests.length,
  );
}

// -----------------------------------------------------------------------------
// Coordinates used by the location and discovery checks
// -----------------------------------------------------------------------------

/** Central Delhi. The origin every distance below is measured from. */
const DELHI = { latitude: 28.6139, longitude: 77.209 };
/** Exactly 0.01 degrees north of Delhi - about 1.11 km, so inside 2 km, outside 1 km. */
const DELHI_NEARBY = { latitude: 28.6239, longitude: 77.209 };
/** Mumbai: far outside every radius the API allows (max 10 km). */
const MUMBAI = { latitude: 19.076, longitude: 72.8777 };

async function putProfile(account: Account, draft: Json): Promise<ApiResponse> {
  return call('PUT', '/api/profile/me', { token: account.accessToken, body: draft });
}

async function putLocation(
  account: Account,
  coordinate: { latitude: number; longitude: number },
): Promise<ApiResponse> {
  return call('PUT', '/api/location/me', { token: account.accessToken, body: coordinate });
}

/** Finds one member in a `{ page: { people } }` response. */
function personById(body: unknown, id: string): Json | undefined {
  return (at<Json[]>(body, 'page', 'people') ?? []).find((person) => person.id === id);
}

function distanceOf(person: Json | undefined): number | null {
  const value = person?.distanceMeters;
  return typeof value === 'number' ? value : null;
}

/** Finds one group in a `{ page: { groups } }` response. */
function groupById(body: unknown, id: string): Json | undefined {
  return (at<Json[]>(body, 'page', 'groups') ?? []).find((group) => group.id === id);
}

function groupDistance(group: Json | undefined): number | null {
  const value = group?.distanceMeters;
  return typeof value === 'number' ? value : null;
}

/** True when a payload carries no coordinate or geometry field of any spelling. */
function hasNoCoordinates(payload: Json | undefined): boolean {
  if (!payload) return true;
  return !(
    'latitude' in payload ||
    'longitude' in payload ||
    'location' in payload ||
    'locationLatitude' in payload ||
    'locationLongitude' in payload
  );
}

/** Counts the rows of one membership state for a group and a user. */
async function membershipRows(groupId: string, userId: string): Promise<Json[]> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT role, status, joined_at FROM group_memberships WHERE group_id = ? AND user_id = ?',
    [groupId, userId],
  );
  return rows.map((row) => ({ role: String(row.role), status: String(row.status), joinedAt: row.joined_at }));
}

/** Creates a group over HTTP and fails loudly if the API refused it. */
async function createGroupFor(
  account: Account,
  body: Json,
): Promise<{ id: string; response: ApiResponse }> {
  const response = await call('POST', '/api/groups', { token: account.accessToken, body });
  const id = String(at<string>(response.body, 'group', 'id') ?? '');
  if (response.status !== 201 || id.length === 0) {
    throw new Error(`Smoke setup failed to create a group: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { id, response };
}

async function runDiscoveryChecks(
  accountA: Account,
): Promise<{ accountB: Account; accountC: Account; bDistance: number | null }> {
  section('People discovery: consent, distance and access control');

  // Two more members, placed so that both the radius and the ranking have a
  // definite expected answer: B is 1.11 km away and shares one interest, C is
  // ~1,150 km away and shares two.
  const accountB = await createVerifiedAccount('near', 'Smoke Member B');
  const accountC = await createVerifiedAccount('far', 'Smoke Member C');

  const profileB = await putProfile(accountB, {
    displayName: 'Smoke Member B',
    bio: 'One interest, one kilometre away.',
    locationLabel: 'Smoke North',
    interestIds: ['music'],
    isDiscoverable: true,
    nearbyDiscoveryEnabled: true,
  });
  assert('member B saves a discoverable profile', profileB.status === 200, profileB.body);

  const profileC = await putProfile(accountC, {
    displayName: 'Smoke Member C',
    interestIds: ['sports', 'coding'],
    isDiscoverable: true,
    nearbyDiscoveryEnabled: true,
  });
  assert('member C saves a discoverable profile', profileC.status === 200, profileC.body);

  assert('member B stores a location', (await putLocation(accountB, DELHI_NEARBY)).status === 200);
  assert('member C stores a location', (await putLocation(accountC, MUMBAI)).status === 200);

  // --- search mode ----------------------------------------------------------
  const search = await call('GET', '/api/people?mode=search&limit=50', { token: accountA.accessToken });
  assert('GET /api/people answers 200', search.status === 200, search.body);
  assert('the page reports the offset it started at', at(search.body, 'page', 'offset') === 0);

  const foundB = personById(search.body, accountB.id);
  const foundC = personById(search.body, accountC.id);
  assert('search finds the near member', foundB !== undefined);
  assert('search finds the far member', foundC !== undefined);
  assert('search never returns the caller', personById(search.body, accountA.id) === undefined);

  const bDistance = distanceOf(foundB);
  assert(
    'the near member is reported at about 1.1 km',
    bDistance !== null && bDistance >= 1000 && bDistance <= 1200,
    bDistance,
  );
  assert('distances are rounded to 50 m', bDistance !== null && bDistance % 50 === 0, bDistance);

  const cDistance = distanceOf(foundC);
  assert(
    'the far member is reported at over 1000 km - search is not radius-limited',
    cDistance !== null && cDistance > 1_000_000,
    cDistance,
  );

  assert(
    'shared interests rank first: C (2 shared) before B (1 shared)',
    (at<Json[]>(search.body, 'page', 'people') ?? []).findIndex((p) => p.id === accountC.id) <
      (at<Json[]>(search.body, 'page', 'people') ?? []).findIndex((p) => p.id === accountB.id),
  );

  assert(
    'the public projection carries sharedInterestCount',
    foundB?.sharedInterestCount === 1 && foundC?.sharedInterestCount === 2,
    { b: foundB?.sharedInterestCount, c: foundC?.sharedInterestCount },
  );

  assert(
    'no person in the results carries a coordinate or an email',
    (at<Json[]>(search.body, 'page', 'people') ?? []).every(
      (person) => !('latitude' in person) && !('longitude' in person) && !('email' in person) && !('location' in person),
    ),
    at<Json[]>(search.body, 'page', 'people')?.[0],
  );

  return { accountB, accountC, bDistance };
}

async function runNearbyChecks(accountV: Account, accountB: Account, accountC: Account): Promise<void> {
  section('People discovery: nearby radius and filters');

  const nearby = await call('GET', '/api/people?mode=nearby&limit=50', { token: accountV.accessToken });
  assert('nearby mode answers 200 at the default 5 km radius', nearby.status === 200, nearby.body);
  assert('it includes the member inside the radius', personById(nearby.body, accountB.id) !== undefined, at<Json[]>(nearby.body, 'page', 'people'));
  assert('it excludes the member 1,150 km away', personById(nearby.body, accountC.id) === undefined);
  assert('it never returns the caller', personById(nearby.body, accountV.id) === undefined);

  const tight = await call('GET', '/api/people?mode=nearby&radius=1000', { token: accountV.accessToken });
  assert(
    'at a 1 km radius the member about 1.11 km away is excluded',
    tight.status === 200 && personById(tight.body, accountB.id) === undefined,
    at<Json[]>(tight.body, 'page', 'people'),
  );

  const roomy = await call('GET', '/api/people?mode=nearby&radius=2000', { token: accountV.accessToken });
  assert('at a 2 km radius he is included again', personById(roomy.body, accountB.id) !== undefined);

  const absurd = await call('GET', '/api/people?mode=nearby&radius=999999', { token: accountV.accessToken });
  assert(
    'a radius beyond the accepted range is rejected, not silently capped',
    absurd.status === 400 && errorCode(absurd) === 'validation_error',
    absurd.body,
  );

  const clamped = await call('GET', '/api/people?mode=nearby&radius=50000', { token: accountV.accessToken });
  assert('a 50 km radius is accepted', clamped.status === 200, clamped.body);
  assert('and clamped to the 10 km maximum, so Mumbai is still out of reach', personById(clamped.body, accountC.id) === undefined);

  const tiny = await call('GET', '/api/people?mode=nearby&radius=1', { token: accountV.accessToken });
  assert(
    'a 1 m radius is clamped up to the 1 km minimum, which still excludes the 1.11 km member',
    tiny.status === 200 && personById(tiny.body, accountB.id) === undefined,
    tiny.body,
  );

  const anonymous = await call('GET', '/api/people');
  assert('discovery needs a session', anonymous.status === 401 && errorCode(anonymous) === 'unauthorized', anonymous.body);

  const named = await call('GET', '/api/people?mode=search&limit=50&q=member%20b', { token: accountV.accessToken });
  assert('the name filter matches case-insensitively and by substring', personById(named.body, accountB.id) !== undefined, at<Json[]>(named.body, 'page', 'people'));
  assert('and it excludes everybody else', personById(named.body, accountC.id) === undefined && personById(named.body, accountV.id) === undefined);

  const byInterest = await call('GET', '/api/people?mode=search&limit=50&interests=coding', { token: accountV.accessToken });
  assert('the interest filter keeps members who share it', personById(byInterest.body, accountC.id) !== undefined);
  assert('and drops members who do not', personById(byInterest.body, accountB.id) === undefined);

  // `by` is what keeps the screen's two segments two different questions: the same
  // word is a name in one and a skill in the other. A name search that also matched
  // interest labels would answer "coding" with everyone who codes, and a skill
  // search that also matched names would answer "member b" with a person.
  const byName = await call('GET', '/api/people?mode=search&limit=50&by=name&q=coding', { token: accountV.accessToken });
  assert(
    'by=name does not match an interest label',
    (at<Json[]>(byName.body, 'page', 'people') ?? []).length === 0,
    at<Json[]>(byName.body, 'page', 'people'),
  );

  const skillByName = await call(
    'GET',
    '/api/people?mode=search&limit=50&by=skill&q=member%20b',
    { token: accountV.accessToken },
  );
  assert(
    'by=skill does not match a display name',
    personById(skillByName.body, accountB.id) === undefined,
    at<Json[]>(skillByName.body, 'page', 'people'),
  );

  const skillByInterest = await call('GET', '/api/people?mode=search&limit=50&by=skill&q=coding', { token: accountV.accessToken });
  assert(
    'by=skill finds the member by the interest they picked',
    personById(skillByInterest.body, accountC.id) !== undefined,
    at<Json[]>(skillByInterest.body, 'page', 'people'),
  );

  const eitherQuestion = await call('GET', '/api/people?mode=search&limit=50&q=coding', { token: accountV.accessToken });
  assert(
    'the default by=any still answers either question',
    personById(eitherQuestion.body, accountC.id) !== undefined,
    at<Json[]>(eitherQuestion.body, 'page', 'people'),
  );

  const badBy = await call('GET', '/api/people?by=telepathy', { token: accountV.accessToken });
  assert(
    'an unknown by= value is rejected',
    badBy.status === 400 && errorCode(badBy) === 'validation_error',
    badBy.body,
  );

  const nonsense = await call('GET', '/api/people?mode=search&interests=no-such-interest', { token: accountV.accessToken });
  assert('an unknown interest id is a filter, not an error', nonsense.status === 200, nonsense.body);
  assert('and it matches nobody', (at<Json[]>(nonsense.body, 'page', 'people') ?? []).length === 0, at<Json[]>(nonsense.body, 'page', 'people'));

  const badMode = await call('GET', '/api/people?mode=telepathy', { token: accountV.accessToken });
  assert('an unknown mode is rejected', badMode.status === 400 && errorCode(badMode) === 'validation_error', badMode.body);

  const badLimit = await call('GET', '/api/people?limit=9999', { token: accountV.accessToken });
  assert('an oversized limit is rejected', badLimit.status === 400 && errorCode(badLimit) === 'validation_error', badLimit.body);
}

async function runPersonDetailChecks(
  accountV: Account,
  accountB: Account,
  expectedBDistance: number | null,
): Promise<void> {
  section('One member in full');

  const detail = await call('GET', `/api/people/${accountB.id}`, { token: accountV.accessToken });
  assert('GET /api/people/:id answers 200 for a discoverable member', detail.status === 200, detail.body);
  assert('it names the member', at(detail.body, 'person', 'displayName') === 'Smoke Member B');
  assert(
    'it reports the same approximate distance as the list did',
    distanceOf(at<Json>(detail.body, 'person')) === expectedBDistance,
    { list: expectedBDistance, detail: distanceOf(at<Json>(detail.body, 'person')) },
  );

  const person = at<Json>(detail.body, 'person') ?? {};
  assert(
    'it carries no coordinate, no email and no privacy switch',
    !('latitude' in person) && !('longitude' in person) && !('email' in person) && !('isDiscoverable' in person),
    person,
  );
  assert(
    'it carries only the fields the client renders',
    Object.keys(person).sort().join() ===
      'avatarPath,bio,displayName,distanceMeters,id,interestIds,locationLabel,sharedInterestCount,sharedInterestIds'.split(',').sort().join(),
    Object.keys(person).sort(),
  );

  const self = await call('GET', `/api/people/${accountV.id}`, { token: accountV.accessToken });
  assert('a member can always open their own public profile', self.status === 200, self.body);
  assert('and their own distance is null, never zero', at(self.body, 'person', 'distanceMeters') === null, at(self.body, 'person', 'distanceMeters'));

  const malformed = await call('GET', '/api/people/not-a-uuid', { token: accountV.accessToken });
  assert('a malformed id is rejected', malformed.status === 400 && errorCode(malformed) === 'validation_error', malformed.body);

  const missing = await call('GET', '/api/people/00000000-0000-0000-0000-000000000000', { token: accountV.accessToken });
  assert('an id that belongs to nobody is not found', missing.status === 404 && errorCode(missing) === 'not_found', missing.body);

  const anonymous = await call('GET', `/api/people/${accountB.id}`);
  assert('reading a member needs a session', anonymous.status === 401, anonymous.body);

  const noProfileRoute = await call('GET', `/api/profile/${accountB.id}`, { token: accountV.accessToken });
  assert(
    'there is no route that reads another member\'s private profile',
    noProfileRoute.status === 404 && errorCode(noProfileRoute) === 'not_found',
    noProfileRoute.body,
  );
}

/** Everything V (member A) sends when re-saving their own profile. */
const V_DRAFT: Json = {
  displayName: 'Smoke Member A',
  bio: 'Smoke-testing Unihood.',
  locationLabel: 'Smoke Area',
  interestIds: ['sports', 'coding', 'music'],
};

async function runConsentChecks(accountV: Account, accountB: Account, accountC: Account): Promise<void> {
  section('Access control and consent');

  // --- while V is discoverable and sharing ---------------------------------
  const readableWhilePublic = await call('GET', `/api/people/${accountV.id}`, { token: accountB.accessToken });
  assert('another member can open a discoverable profile', readableWhilePublic.status === 200, readableWhilePublic.body);

  const visibleToB = await call('GET', '/api/people?mode=search&limit=50', { token: accountB.accessToken });
  assert('and finds it in a search', personById(visibleToB.body, accountV.id) !== undefined, at<Json[]>(visibleToB.body, 'page', 'people'));

  // --- V stops sharing ------------------------------------------------------
  const privateProfile = await putProfile(accountV, { ...V_DRAFT, isDiscoverable: false, nearbyDiscoveryEnabled: false });
  assert('both switches can be withdrawn in one write', privateProfile.status === 200, privateProfile.body);
  assert(
    'and the response confirms both are off',
    at(privateProfile.body, 'profile', 'isDiscoverable') === false &&
      at(privateProfile.body, 'profile', 'nearbyDiscoveryEnabled') === false,
    at(privateProfile.body, 'profile'),
  );
  assert(
    'withdrawing nearby consent deletes the stored fix in the same write',
    (await readStoredCoordinate(accountV.id)) === null,
  );

  const hiddenFromB = await call('GET', `/api/people/${accountV.id}`, { token: accountB.accessToken });
  assert(
    'a private profile is not readable by another member - and says nothing about why',
    hiddenFromB.status === 404 && errorCode(hiddenFromB) === 'not_found',
    hiddenFromB.body,
  );

  const absentFromSearch = await call('GET', '/api/people?mode=search&limit=50', { token: accountB.accessToken });
  assert('and it disappears from search', personById(absentFromSearch.body, accountV.id) === undefined);

  const selfWhilePrivate = await call('GET', `/api/people/${accountV.id}`, { token: accountV.accessToken });
  assert('the member can still open their own profile', selfWhilePrivate.status === 200, selfWhilePrivate.body);

  const writeWhileOff = await putLocation(accountV, DELHI);
  assert(
    'a location write is refused while nearby consent is off',
    writeWhileOff.status === 403 && errorCode(writeWhileOff) === 'nearby_disabled',
    writeWhileOff.body,
  );
  assert('and it stored nothing', (await readStoredCoordinate(accountV.id)) === null);

  const nearbyWhileOff = await call('GET', '/api/people?mode=nearby', { token: accountV.accessToken });
  assert(
    'nearby search is refused for the same reason',
    nearbyWhileOff.status === 403 && errorCode(nearbyWhileOff) === 'nearby_disabled',
    nearbyWhileOff.body,
  );

  const searchWhileOff = await call('GET', '/api/people?mode=search&limit=50', { token: accountV.accessToken });
  assert('search still works without nearby consent', searchWhileOff.status === 200, searchWhileOff.body);
  assert(
    'but no distance can be shown for anyone',
    distanceOf(personById(searchWhileOff.body, accountB.id)) === null,
    personById(searchWhileOff.body, accountB.id),
  );

  // --- consent back on, location not yet re-shared -------------------------
  const sharingAgain = await putProfile(accountV, { ...V_DRAFT, isDiscoverable: true, nearbyDiscoveryEnabled: true });
  assert('consent can be given again', sharingAgain.status === 200, sharingAgain.body);

  const nearbyWithoutFix = await call('GET', '/api/people?mode=nearby', { token: accountV.accessToken });
  assert(
    'nearby search then asks for a location instead of guessing one',
    nearbyWithoutFix.status === 409 && errorCode(nearbyWithoutFix) === 'location_required',
    nearbyWithoutFix.body,
  );

  const restored = await call('GET', `/api/people/${accountV.id}`, { token: accountC.accessToken });
  assert('the profile is readable again', restored.status === 200, restored.body);

  const replacementFix = await putLocation(accountV, DELHI);
  assert('the location can be shared again', replacementFix.status === 200, replacementFix.body);

  const nearbyAgain = await call('GET', '/api/people?mode=nearby&limit=50', { token: accountV.accessToken });
  assert('and nearby search works again', nearbyAgain.status === 200 && personById(nearbyAgain.body, accountB.id) !== undefined, nearbyAgain.body);
}

async function runLocationChecks(account: Account): Promise<void> {

  section('Location storage, consent and the write throttle');

  const anonymous = await call('PUT', '/api/location/me', { body: DELHI });
  assert('a location write needs a session', anonymous.status === 401 && errorCode(anonymous) === 'unauthorized', anonymous.body);

  const outOfRange = await call('PUT', '/api/location/me', {
    token: account.accessToken,
    body: { latitude: 91, longitude: DELHI.longitude },
  });
  assert(
    'an out-of-range latitude is refused',
    outOfRange.status === 400 && errorCode(outOfRange) === 'validation_error',
    outOfRange.body,
  );

  const nullIsland = await call('PUT', '/api/location/me', {
    token: account.accessToken,
    body: { latitude: 0, longitude: 0 },
  });
  assert(
    'the (0, 0) "no fix" reading is refused',
    nullIsland.status === 400 && errorCode(nullIsland) === 'validation_error',
    nullIsland.body,
  );

  const missingFix = await call('PUT', '/api/location/me', { token: account.accessToken, body: { latitude: 1 } });
  assert('a half-sent coordinate is refused', missingFix.status === 400 && errorCode(missingFix) === 'validation_error', missingFix.body);

  const stored = await call('PUT', '/api/location/me', { token: account.accessToken, body: DELHI });
  assert('a valid location is stored', stored.status === 200 && typeof at(stored.body, 'locationUpdatedAt') === 'string', stored.body);
  assert(
    'only the timestamp comes back - never the coordinate',
    Object.keys(at<Json>(stored.body) ?? {}).join() === 'locationUpdatedAt',
    at(stored.body),
  );

  const throttled = await call('PUT', '/api/location/me', { token: account.accessToken, body: DELHI_NEARBY });
  assert(
    'a second write inside the throttle window is accepted and ignored',
    throttled.status === 200 && at(throttled.body, 'locationUpdatedAt') === at(stored.body, 'locationUpdatedAt'),
    { first: at(stored.body, 'locationUpdatedAt'), second: at(throttled.body, 'locationUpdatedAt') },
  );

  const afterThrottle = await readStoredCoordinate(account.id);
  assert(
    'the throttled write did not move the stored point',
    afterThrottle?.latitude === DELHI.latitude && afterThrottle?.longitude === DELHI.longitude,
    afterThrottle,
  );

  // Deleting is what lets the client make "stop sharing" true immediately. It also
  // clears the throttle, because the throttle is the age of the stored row.
  const cleared = await call('DELETE', '/api/location/me', { token: account.accessToken });
  assert('deleting the stored fix answers 204', cleared.status === 204, cleared.body);
  assert('the row is really gone', (await readStoredCoordinate(account.id)) === null);

  const clearAgain = await call('DELETE', '/api/location/me', { token: account.accessToken });
  assert('deleting when nothing is stored is still 204 (idempotent)', clearAgain.status === 204, clearAgain.body);

  const precise = await call('PUT', '/api/location/me', {
    token: account.accessToken,
    body: { latitude: 28.613_912_34, longitude: 77.209_056_78 },
  });
  assert('a fresh store after a delete is accepted', precise.status === 200, precise.body);

  const rounded = await readStoredCoordinate(account.id);
  assert(
    'the stored point is rounded to ~11 m, not kept at full precision',
    rounded?.latitude === 28.6139 && rounded?.longitude === 77.2091,
    rounded,
  );

  const readMe = await call('GET', '/api/location/me', { token: account.accessToken });
  assert('there is no endpoint that returns a coordinate', readMe.status === 404 && errorCode(readMe) === 'not_found', readMe.body);

  const readOther = await call('GET', `/api/location/${account.id}`, { token: account.accessToken });
  assert('and no path-parameter variant of one either', readOther.status === 404, readOther.body);

  // A body field the API does not declare must not be able to re-target the write.
  // The delete clears the throttle, so the next write really does insert.
  await call('DELETE', '/api/location/me', { token: account.accessToken });
  const [othersBefore] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT user_id FROM user_locations WHERE user_id <> ?',
    [account.id],
  );

  const spoofedWrite = await call('PUT', '/api/location/me', {
    token: account.accessToken,
    body: { ...DELHI, userId: '00000000-0000-0000-0000-000000000000' },
  });
  assert('an injected userId is ignored, not honoured', spoofedWrite.status === 200, spoofedWrite.body);

  const afterSpoof = await readStoredCoordinate(account.id);
  assert(
    'the write landed on the caller\'s own row',
    afterSpoof?.latitude === DELHI.latitude && afterSpoof?.longitude === DELHI.longitude,
    afterSpoof,
  );

  const [othersAfter] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT user_id FROM user_locations WHERE user_id <> ?',
    [account.id],
  );
  assert('no row was created or moved for anyone else', othersAfter.length === othersBefore.length, {
    before: othersBefore.length,
    after: othersAfter.length,
  });
}

/**
 * A saved nearby area is persistent, and a place anchor is not a person's area.
 *
 * Two rules, and both are about what must *not* change:
 *
 *   1. **An area does not expire.** Nothing filters on `location_updated_at` any
 *      more, and the honest way to test the absence of the old 24-hour rule is to
 *      age a row comfortably past it and then search - so the fix below is
 *      backdated by a month before the nearby checks run. That also makes the
 *      later write acceptable without waiting out the 10 s throttle.
 *   2. **Moving changes nothing else.** A group's or an event's anchor is its own
 *      row in its own table, written only by the form that names the place, and
 *      memberships are never filtered by location, distance or interest. Every
 *      claim below is checked against MySQL directly, because no API answer
 *      carries a coordinate.
 */
async function runPersistentLocationChecks(): Promise<void> {
  section("A saved area is persistent, and an anchor is not the owner's location");

  /** The ids of a `{ page: { groups } }` response, in the order the API sent them. */
  const groupIdsOf = (body: unknown): string[] =>
    (at<Json[]>(body, 'page', 'groups') ?? []).map((group) => String(group.id));

  const owner = await createLocatedAccount('persist', 'Smoke Persistent Owner');
  const neighbour = await createLocatedAccount('persistnear', 'Smoke Persistent Neighbour');

  // Both places are anchored somewhere other than the owner's own saved fix
  // (DELHI), so "the owner moved" and "the anchor did not" are different
  // coordinates in every comparison below.
  const group = await createGroupFor(
    owner,
    publicGroupDraft({
      name: 'Smoke Persistent Runners',
      locationLabel: 'Smoke East Plaza',
      latitude: DELHI_EAST.latitude,
      longitude: DELHI_EAST.longitude,
    }),
  );
  const event = await createEventFor(
    owner,
    eventDraft({
      title: 'Smoke Persistent Meetup',
      locationLabel: 'Smoke North Gate',
      latitude: DELHI_NEARBY.latitude,
      longitude: DELHI_NEARBY.longitude,
    }),
  );

  const anchorBefore = await readGroupAnchor(group.id);
  const venueBefore = await readEventAnchor(event.id);
  assert(
    'the group is anchored where the form said',
    anchorBefore?.latitude === DELHI_EAST.latitude && anchorBefore?.longitude === DELHI_EAST.longitude,
    anchorBefore,
  );
  assert(
    'the event is anchored where the form said',
    venueBefore?.latitude === DELHI_NEARBY.latitude && venueBefore?.longitude === DELHI_NEARBY.longitude,
    venueBefore,
  );

  // --- the area does not expire ------------------------------------------------
  await pool.query(
    'UPDATE user_locations SET location_updated_at = DATE_SUB(NOW(3), INTERVAL 30 DAY) WHERE user_id = ?',
    [owner.id],
  );

  const nearbyPeople = await call('GET', '/api/people?mode=nearby&limit=50', { token: owner.accessToken });
  assert('nearby people answers 200 from a month-old area', nearbyPeople.status === 200, nearbyPeople.body);
  assert(
    'and still measures from it, so the member at the same point is found',
    distanceOf(personById(nearbyPeople.body, neighbour.id)) !== null,
    personById(nearbyPeople.body, neighbour.id),
  );

  const nearbyGroups = await call('GET', '/api/groups/nearby?limit=50', { token: owner.accessToken });
  assert('nearby groups answers 200 as well', nearbyGroups.status === 200, nearbyGroups.body);
  assert(
    'and still finds the group anchored 977 m east of it',
    groupDistance(groupById(nearbyGroups.body, group.id)) !== null,
    groupById(nearbyGroups.body, group.id),
  );

  // --- a refused update preserves what is already saved ------------------------
  const fixBefore = await readStoredCoordinate(owner.id);
  const outOfRange = await putLocation(owner, { latitude: 91, longitude: DELHI.longitude });
  assert(
    'an out-of-range update is refused',
    outOfRange.status === 400 && errorCode(outOfRange) === 'validation_error',
    outOfRange.body,
  );
  const noFix = await putLocation(owner, { latitude: 0, longitude: 0 });
  assert(
    'and so is the (0, 0) reading a dead GPS hands out',
    noFix.status === 400 && errorCode(noFix) === 'validation_error',
    noFix.body,
  );
  const fixAfterRefusal = await readStoredCoordinate(owner.id);
  assert(
    'a refused update leaves the saved area exactly where it was',
    fixAfterRefusal?.latitude === fixBefore?.latitude && fixAfterRefusal?.longitude === fixBefore?.longitude,
    { before: fixBefore, after: fixAfterRefusal },
  );

  // --- a later update is accepted, and moves nothing else ----------------------
  // "Time passes": the throttle is the age of the stored row, and a member who has
  // genuinely moved is not writing twice inside ten seconds.
  await pool.query(
    'UPDATE user_locations SET location_updated_at = DATE_SUB(NOW(3), INTERVAL 5 MINUTE) WHERE user_id = ?',
    [owner.id],
  );
  const moved = await putLocation(owner, MUMBAI);
  assert(
    'the same area can be replaced later',
    moved.status === 200 && typeof at(moved.body, 'locationUpdatedAt') === 'string',
    moved.body,
  );
  const movedFix = await readStoredCoordinate(owner.id);
  assert(
    'and the new point is what is stored',
    movedFix?.latitude === MUMBAI.latitude && movedFix?.longitude === MUMBAI.longitude,
    movedFix,
  );

  const anchorAfterMove = await readGroupAnchor(group.id);
  assert(
    'changing my area did not move the group anchor',
    anchorAfterMove?.latitude === anchorBefore?.latitude && anchorAfterMove?.longitude === anchorBefore?.longitude,
    { before: anchorBefore, after: anchorAfterMove },
  );
  const venueAfterMove = await readEventAnchor(event.id);
  assert(
    'and did not move the event venue',
    venueAfterMove?.latitude === venueBefore?.latitude && venueAfterMove?.longitude === venueBefore?.longitude,
    { before: venueBefore, after: venueAfterMove },
  );

  const membershipsAfterMove = await membershipRows(group.id, owner.id);
  assert(
    'the owner membership is untouched',
    membershipsAfterMove.length === 1 &&
      membershipsAfterMove[0]?.role === 'owner' &&
      membershipsAfterMove[0]?.status === 'active',
    membershipsAfterMove,
  );

  const mineAfterMove = await call('GET', '/api/groups/mine?limit=50', { token: owner.accessToken });
  assert(
    'My groups still lists the group I own',
    groupIdsOf(mineAfterMove.body).includes(group.id),
    groupIdsOf(mineAfterMove.body),
  );

  const nearbyFromAway = await call('GET', '/api/groups/nearby?limit=50', { token: owner.accessToken });
  assert(
    'the old area really was replaced, so the group is no longer nearby',
    groupById(nearbyFromAway.body, group.id) === undefined,
  );

  const directory = await call('GET', '/api/groups?limit=50', { token: owner.accessToken });
  assert(
    'but the directory is not a distance question, so it is still listed',
    groupById(directory.body, group.id) !== undefined,
  );

  const groupDetail = await call('GET', `/api/groups/${group.id}`, { token: owner.accessToken });
  assert(
    'and the group still reports its anchor',
    groupDetail.status === 200 && at(groupDetail.body, 'group', 'hasLocation') === true,
    at(groupDetail.body, 'group'),
  );
  assert(
    'while carrying no coordinate of any spelling',
    hasNoCoordinates(at<Json>(groupDetail.body, 'group')),
    at(groupDetail.body, 'group'),
  );
  assert(
    'the event is readable from the new area too',
    (await call('GET', `/api/events/${event.id}`, { token: owner.accessToken })).status === 200,
  );

  // --- My groups ignores every selection it is not offered ---------------------
  const minePlain = await call('GET', '/api/groups/mine?limit=50', { token: owner.accessToken });
  const mineSelected = await call(
    'GET',
    `/api/groups/mine?limit=50&interest=coding&matched=true&radius=1000&q=${encodeURIComponent('zzz-no-such-group')}`,
    { token: owner.accessToken },
  );
  assert(
    'My groups accepts selections it does not offer without complaining',
    mineSelected.status === 200,
    mineSelected.body,
  );
  assert(
    'and returns exactly the memberships it returned without them',
    JSON.stringify(groupIdsOf(mineSelected.body)) === JSON.stringify(groupIdsOf(minePlain.body)),
    { filtered: groupIdsOf(mineSelected.body), plain: groupIdsOf(minePlain.body) },
  );

  // --- switching nearby off deletes the area, and nothing else -----------------
  const consentOff = await putProfile(owner, {
    displayName: 'Smoke Persistent Owner',
    interestIds: [],
    isDiscoverable: true,
    nearbyDiscoveryEnabled: false,
  });
  assert('nearby discovery can be switched off', consentOff.status === 200, consentOff.body);
  assert('switching it off deletes the saved area', (await readStoredCoordinate(owner.id)) === null);

  const anchorAfterConsent = await readGroupAnchor(group.id);
  assert(
    'but leaves the group anchor alone',
    anchorAfterConsent?.latitude === anchorBefore?.latitude &&
      anchorAfterConsent?.longitude === anchorBefore?.longitude,
    { before: anchorBefore, after: anchorAfterConsent },
  );
  const venueAfterConsent = await readEventAnchor(event.id);
  assert(
    'and leaves the venue anchor alone',
    venueAfterConsent?.latitude === venueBefore?.latitude &&
      venueAfterConsent?.longitude === venueBefore?.longitude,
    { before: venueBefore, after: venueAfterConsent },
  );
  const mineAfterConsent = await call('GET', '/api/groups/mine?limit=50', { token: owner.accessToken });
  assert(
    'and My groups is untouched',
    groupIdsOf(mineAfterConsent.body).includes(group.id),
    groupIdsOf(mineAfterConsent.body),
  );

  // --- and only the account closure removes the row ----------------------------
  const [cascadeRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    `SELECT rc.DELETE_RULE AS delete_rule
       FROM information_schema.referential_constraints rc
      WHERE rc.constraint_schema = DATABASE()
        AND rc.table_name = 'user_locations'
        AND rc.referenced_table_name = 'profiles'`,
  );
  assert(
    'the schema deletes the saved area when the account goes',
    String(cascadeRows[0]?.delete_rule ?? '') === 'CASCADE',
    cascadeRows[0],
  );

  // The index 0003 put on `location_updated_at` implied a freshness test that no
  // longer exists; 0012 drops it. Re-adding one would have to re-argue the rule.
  const [freshnessIndexRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    `SELECT index_name
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'user_locations'
        AND index_name = 'user_locations_freshness_idx'`,
  );
  assert(
    'and no index is left that implied the removed 24-hour rule',
    freshnessIndexRows.length === 0,
    freshnessIndexRows.length,
  );
}

async function runSessionChecks(account: Account): Promise<void> {
  section('Sessions: rotation, replay detection and sign-out');

  const signedIn = await loginUser(account.email);
  const accessToken = at<string>(signedIn.body, 'accessToken');
  const refreshToken = at<string>(signedIn.body, 'refreshToken');

  assert('sign-in returns a session', signedIn.status === 200, signedIn.body);
  assert('with both tokens and both expiry timestamps', Boolean(accessToken) && Boolean(refreshToken) &&
    typeof at(signedIn.body, 'accessTokenExpiresAt') === 'string' &&
    typeof at(signedIn.body, 'refreshTokenExpiresAt') === 'string');
  assert('and an expiry in seconds the client can schedule on', typeof at(signedIn.body, 'expiresInSeconds') === 'number', at(signedIn.body));
  assert('the refresh token is not derived from the access token', !String(accessToken).includes(String(refreshToken)));

  const me = await call('GET', '/api/auth/me', { token: accessToken });
  assert('GET /api/auth/me identifies the caller', me.status === 200 && at(me.body, 'user', 'id') === account.id, me.body);
  assert('and never carries a credential', !/password|hash|token/i.test(JSON.stringify(me.body)), me.body);

  const rotated = await call('POST', '/api/auth/refresh', { body: { refreshToken } });
  const rotatedAccess = at<string>(rotated.body, 'accessToken');
  const rotatedRefresh = at<string>(rotated.body, 'refreshToken');
  assert('a refresh token can be exchanged for a new pair', rotated.status === 200, rotated.body);
  assert('the refresh token really changes', rotatedRefresh !== refreshToken && Boolean(rotatedRefresh));
  assert('and so does the access token', rotatedAccess !== accessToken);

  const replay = await call('POST', '/api/auth/refresh', { body: { refreshToken } });
  assert(
    'replaying the spent refresh token is refused',
    replay.status === 401 && errorCode(replay) === 'session_expired',
    replay.body,
  );

  const afterReplay = await call('POST', '/api/auth/refresh', { body: { refreshToken: rotatedRefresh } });
  assert(
    'and the replay revoked the family - the token issued moments ago is dead too',
    afterReplay.status === 401 && errorCode(afterReplay) === 'session_expired',
    afterReplay.body,
  );

  const accessAfterReplay = await call('GET', '/api/auth/me', { token: rotatedAccess });
  assert(
    'an access token stops working the moment its session is revoked',
    accessAfterReplay.status === 401 && errorCode(accessAfterReplay) === 'session_expired',
    accessAfterReplay.body,
  );

  const unknownToken = await call('POST', '/api/auth/refresh', { body: { refreshToken: 'b'.repeat(43) } });
  assert(
    'a refresh token this server has never seen is refused',
    unknownToken.status === 401 && errorCode(unknownToken) === 'session_expired',
    unknownToken.body,
  );

  const shortToken = await call('POST', '/api/auth/refresh', { body: { refreshToken: 'abc' } });
  assert('a malformed refresh token is a validation error', shortToken.status === 400 && errorCode(shortToken) === 'validation_error', shortToken.body);

  const noToken = await call('POST', '/api/auth/refresh', { body: {} });
  assert('a refresh with no token at all is a validation error', noToken.status === 400 && errorCode(noToken) === 'validation_error', noToken.body);

  // --- sign-out -------------------------------------------------------------
  const second = await loginUser(account.email);
  const secondAccess = at<string>(second.body, 'accessToken');
  const secondRefresh = at<string>(second.body, 'refreshToken');

  const loggedOut = await call('POST', '/api/auth/logout', { body: { refreshToken: secondRefresh } });
  assert('logout answers 204 with no body', loggedOut.status === 204, loggedOut.body);

  const loggedOutAgain = await call('POST', '/api/auth/logout', { body: { refreshToken: secondRefresh } });
  assert('and logging out twice is still a success', loggedOutAgain.status === 204, loggedOutAgain.body);

  const afterLogout = await call('GET', '/api/auth/me', { token: secondAccess });
  assert('the access token is dead immediately after sign-out', afterLogout.status === 401 && errorCode(afterLogout) === 'session_expired', afterLogout.body);

  const refreshAfterLogout = await call('POST', '/api/auth/refresh', { body: { refreshToken: secondRefresh } });
  assert('and the refresh token cannot resurrect the session', refreshAfterLogout.status === 401 && errorCode(refreshAfterLogout) === 'session_expired', refreshAfterLogout.body);
}

async function runPasswordResetChecks(): Promise<void> {
  section('Password recovery');

  const account = await createVerifiedAccount('reset', 'Reset Member');
  const session = await loginUser(account.email);
  const liveAccessToken = at<string>(session.body, 'accessToken');
  assert('the member has a session open before the reset', Boolean(liveAccessToken), session.body);

  const unknown = await call('POST', '/api/auth/forgot-password', { body: { email: makeEmail('ghost') } });
  assert(
    'an unknown address gets the same 202 and no link',
    unknown.status === 202 && at<Json>(unknown.body, 'email') === null,
    unknown.body,
  );

  const requested = await call('POST', '/api/auth/forgot-password', {
    body: { email: account.email, redirectTo: 'unihood://auth/reset' },
  });
  const firstLink = String(at<string>(requested.body, 'email', 'devLink') ?? '');
  assert('a known address gets 202 too', requested.status === 202, requested.body);
  assert('and a single-use link, in development', firstLink.includes('/auth/reset-password?token='), firstLink);

  const second = await call('POST', '/api/auth/forgot-password', { body: { email: account.email } });
  const secondLink = String(at<string>(second.body, 'email', 'devLink') ?? '');
  assert('asking again issues a different link', secondLink !== firstLink && secondLink.length > 0);

  const stale = await call('POST', '/api/auth/reset-password', {
    body: { token: tokenFromLink(firstLink), password: NEW_PASSWORD },
  });
  assert(
    'and the older link stops working - only the newest one does',
    stale.status === 400 && errorCode(stale) === 'invalid_token',
    stale.body,
  );

  const weak = await call('POST', '/api/auth/reset-password', {
    body: { token: tokenFromLink(secondLink), password: 'password123' },
  });
  assert(
    'the reset endpoint enforces the password policy itself',
    weak.status === 400 && errorCode(weak) === 'validation_error',
    weak.body,
  );

  const wrongToken = await call('POST', '/api/auth/reset-password', {
    body: { token: 'c'.repeat(43), password: NEW_PASSWORD },
  });
  assert(
    'a link this server never issued is refused',
    wrongToken.status === 400 && errorCode(wrongToken) === 'invalid_token',
    wrongToken.body,
  );

  const reset = await call('POST', '/api/auth/reset-password', {
    body: { token: tokenFromLink(secondLink), password: NEW_PASSWORD },
  });
  assert('a rejected password does not burn the link, so the reset now succeeds', reset.status === 200, reset.body);
  assert('no session leaks out of the reset', at(reset.body, 'accessToken') === undefined, reset.body);

  const replay = await call('POST', '/api/auth/reset-password', {
    body: { token: tokenFromLink(secondLink), password: NEW_PASSWORD },
  });
  assert('the link is single-use', replay.status === 400 && errorCode(replay) === 'invalid_token', replay.body);

  const afterReset = await call('GET', '/api/auth/me', { token: liveAccessToken });
  assert(
    'the reset revoked the sessions that were already open',
    afterReset.status === 401 && errorCode(afterReset) === 'session_expired',
    afterReset.body,
  );

  const oldPassword = await loginUser(account.email);
  assert(
    'the old password no longer signs in',
    oldPassword.status === 401 && errorCode(oldPassword) === 'invalid_credentials',
    oldPassword.body,
  );

  const newPassword = await loginUser(account.email, NEW_PASSWORD);
  assert('the new password does', newPassword.status === 200, newPassword.body);
}

/**
 * `users.disabled_at`.
 *
 * This column had no HTTP surface by design - disabling an account is an
 * administrative action taken in the database - so nothing else in the suite
 * would notice if the column stopped being read. The script therefore writes it
 * the way an operator would, through the same pool the server uses, and then
 * checks every place the API is supposed to notice.
 */
async function runDisabledAccountChecks(): Promise<void> {
  section('Disabled accounts');

  const account = await createVerifiedAccount('disabled', 'Disabled Member');
  const before = await call('GET', '/api/auth/me', { token: account.accessToken });
  assert('an active account is usable', before.status === 200, before.body);

  await pool.query('UPDATE users SET disabled_at = NOW(3) WHERE id = ?', [account.id]);

  const after = await call('GET', '/api/auth/me', { token: account.accessToken });
  assert(
    'an access token stops working the moment the account is switched off',
    after.status === 401 && errorCode(after) === 'session_expired',
    after.body,
  );

  const signIn = await loginUser(account.email);
  assert(
    'sign-in is refused with account_disabled',
    signIn.status === 403 && errorCode(signIn) === 'account_disabled',
    signIn.body,
  );

  const refresh = await call('POST', '/api/auth/refresh', { body: { refreshToken: account.refreshToken } });
  assert(
    'a live refresh token is revoked and refused',
    refresh.status === 403 && errorCode(refresh) === 'account_disabled',
    refresh.body,
  );

  const forgot = await call('POST', '/api/auth/forgot-password', { body: { email: account.email } });
  assert(
    'and no password-reset link is issued for it',
    forgot.status === 202 && at<Json>(forgot.body, 'email') === null,
    forgot.body,
  );

  await pool.query('UPDATE users SET disabled_at = NULL WHERE id = ?', [account.id]);
  const reEnabled = await loginUser(account.email);
  assert('switching it back on restores sign-in', reEnabled.status === 200, reEnabled.body);
}

// -----------------------------------------------------------------------------
// Preflight, cleanup and the runner
// -----------------------------------------------------------------------------

/**
 * The two settings this script cannot work without.
 *
 * Without `EXPOSE_DEV_TOKENS` the single-use links never come back and half the
 * checks would fail for a reason that says nothing about the API; with a real
 * mail transport the script would post a confirmation link to a made-up address
 * and a bounce would be the only evidence. Both are refused rather than worked
 * around.
 */
function requireDevelopmentSettings(): void {
  const missing: string[] = [];
  if (!env.exposeDevTokens) missing.push('EXPOSE_DEV_TOKENS=true');
  if (env.mail.transport !== 'log') missing.push('MAIL_TRANSPORT=log');

  if (missing.length > 0) {
    throw new Error(
      `This smoke test only runs against a development server: set ${missing.join(' and ')} in backend/.env, restart the API, and run it again.`,
    );
  }
}

/** A clear failure when the API is simply not up. */
async function requireReachable(): Promise<void> {
  try {
    await call('GET', '/health');
  } catch (error) {
    throw new Error(
      `Could not reach ${BASE_URL}. Start the API first ("npm run dev", or "npm start" after "npm run build"). ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// -----------------------------------------------------------------------------
// Groups (Phase 3)
// -----------------------------------------------------------------------------

/** 0.01 degrees east of Delhi - about 977 m, so longitude order is testable. */
const DELHI_EAST = { latitude: DELHI.latitude, longitude: 77.219 };

/** The shared body of a plain, public, everyone group. */
function publicGroupDraft(overrides: Json = {}): Json {
  return {
    name: 'Smoke Plaza Runners',
    description: 'A smoke-test group that meets on the plaza every week.',
    category: 'sports',
    visibility: 'public',
    audience: 'everyone',
    locationLabel: 'Smoke Plaza',
    latitude: DELHI.latitude,
    longitude: DELHI.longitude,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Phone sign-in (Phase 5)
// -----------------------------------------------------------------------------

/**
 * The whole one-time-code surface, including the rules that are easiest to get
 * wrong: that a code is never in a response, that the newest code is the only one
 * that works, that a repeat request does not clear the limits, and that a wrong
 * number tells you nothing about whether an account exists.
 *
 * The codes come from `backend/.otp-outbox/`, which is where the `log` transport
 * writes them - the same file a developer reads by hand.
 */
async function runOtpChecks(): Promise<void> {
  section('Phone sign-in: requesting a code');

  const phone = makePhone('primary');
  const requested = await requestOtpFor(phone);

  assert('requesting a code answers 202', requested.status === 202, requested.body);
  assert('the response says a message was queued', at(requested.body, 'sent') === true, requested.body);
  assert(
    'the log transport reports delivered: false rather than claiming an SMS',
    at(requested.body, 'transport') === 'log' &&
      at(requested.body, 'delivered') === false &&
      at(requested.body, 'failed') === false,
    requested.body,
  );
  assert(
    'the response never contains the code',
    at(requested.body, 'code') === undefined,
    requested.body,
  );
  assert(
    'the response carries only a masked number, never the full one',
    typeof at<string>(requested.body, 'phone') === 'string' &&
      at<string>(requested.body, 'phone') !== phone &&
      !String(at<string>(requested.body, 'phone')).includes(phone.slice(3)),
    at(requested.body, 'phone'),
  );
  assert(
    'the resend cooldown comes back as a number of seconds',
    typeof at<number>(requested.body, 'resendAfterSeconds') === 'number' &&
      Number(at<number>(requested.body, 'resendAfterSeconds')) > 0,
    at(requested.body, 'resendAfterSeconds'),
  );

  const code = await readLatestOtp(phone);
  assert('the code is six digits', /^[0-9]{6}$/.test(code), code.length);
  assert('the code is not stored in the clear', await storedCodeIsHashed(phone, code));

  section('Phone sign-in: verifying a code creates the account');

  const wrongCode = code === '000000' ? '111111' : '000000';
  const rejected = await verifyOtpFor(phone, wrongCode);
  assert(
    'a wrong code is refused with otp_invalid',
    rejected.status === 400 && errorCode(rejected) === 'otp_invalid',
    rejected.body,
  );
  assert(
    'the refusal says how many attempts are left',
    /attempts left/.test(String((rejected.body as { error?: { message?: string } })?.error?.message ?? '')),
    rejected.body,
  );

  const verified = await verifyOtpFor(phone, code);
  assert('the correct code answers 200', verified.status === 200, verified.body);
  assert('the account is reported as new', at(verified.body, 'isNewAccount') === true, verified.body);
  assert('onboarding is required for the new account', at(verified.body, 'onboardingRequired') === true, verified.body);

  const phoneUserId = at<string>(verified.body, 'user', 'id') ?? '';
  const phoneAccessToken = at<string>(verified.body, 'accessToken') ?? '';
  const phoneRefreshToken = at<string>(verified.body, 'refreshToken') ?? '';
  if (phoneUserId) created.push(phoneUserId);

  assert('the session has the usual tokens', Boolean(phoneUserId && phoneAccessToken && phoneRefreshToken), verified.body);
  assert(
    'the signed-in account carries its own E.164 number',
    at<string>(verified.body, 'user', 'phone') === phone,
    at(verified.body, 'user', 'phone'),
  );
  assert(
    'the signed-in account has no email address',
    at(verified.body, 'user', 'email') === null,
    at(verified.body, 'user', 'email'),
  );
  assert(
    'the session reports the number as verified, not just present',
    at(verified.body, 'user', 'phoneVerified') === true,
    at(verified.body, 'user', 'phoneVerified'),
  );

  const ownProfile = await call('GET', '/api/profile/me', { token: phoneAccessToken });
  assert('the new session can read its own profile', ownProfile.status === 200, ownProfile.body);
  assert(
    'the profile row exists with the placeholder name and is not complete',
    at<string>(ownProfile.body, 'profile', 'displayName') === 'New member' &&
      at(ownProfile.body, 'profile', 'profileCompleted') === false,
    ownProfile.body,
  );
  assert(
    'the own-profile payload carries the number (and only this route does)',
    at<string>(ownProfile.body, 'profile', 'phone') === phone,
    at(ownProfile.body, 'profile', 'phone'),
  );

  const replay = await verifyOtpFor(phone, code);
  assert(
    'the same code cannot be used twice',
    replay.status === 400 && errorCode(replay) === 'otp_invalid',
    replay.body,
  );

  section('Phone sign-in: only the newest code works');

  await backdateOtpRequests(phone, 3);
  const second = await requestOtpFor(phone);
  assert('a second code can be requested once the cooldown has passed', second.status === 202, second.body);

  const superseded = await verifyOtpFor(phone, code);
  assert(
    'the superseded code stops working',
    superseded.status === 400 && errorCode(superseded) === 'otp_invalid',
    superseded.body,
  );

  const secondCode = await readLatestOtp(phone);
  const signedInAgain = await verifyOtpFor(phone, secondCode);
  assert('the newest code signs the same member in', signedInAgain.status === 200, signedInAgain.body);
  assert('the second verification is not a new account', at(signedInAgain.body, 'isNewAccount') === false, signedInAgain.body);
  assert(
    'the same number resolves to the same account',
    at<string>(signedInAgain.body, 'user', 'id') === phoneUserId,
    at(signedInAgain.body, 'user', 'id'),
  );

  section('Phone sign-in: sessions behave exactly as password sessions do');

  const rotatedRefresh = at<string>(signedInAgain.body, 'refreshToken') ?? '';
  const refreshed = await call('POST', '/api/auth/refresh', { body: { refreshToken: rotatedRefresh } });
  assert('an OTP session can be renewed', refreshed.status === 200, refreshed.body);
  assert(
    'the renewed access token works',
    (await call('GET', '/api/profile/me', { token: at<string>(refreshed.body, 'accessToken') ?? '' })).status === 200,
  );
  // Checked *after* the renewal above, because replaying a rotated refresh token
  // is treated as theft: the server revokes every session on the account, which
  // would make the previous assertion fail for the wrong reason.
  assert(
    'presenting the rotated refresh token again is refused',
    (await call('POST', '/api/auth/refresh', { body: { refreshToken: rotatedRefresh } })).status === 401,
  );
  assert(
    'and the compromise response revoked the session it issued',
    (await call('GET', '/api/profile/me', { token: at<string>(refreshed.body, 'accessToken') ?? '' })).status === 401,
  );

  const signedOut = await call('POST', '/api/auth/logout', {
    body: { refreshToken: at<string>(refreshed.body, 'refreshToken') ?? '' },
  });
  assert('signing out answers 204', signedOut.status === 204, signedOut.body);
  assert(
    'the signed-out access token is refused afterwards',
    (await call('GET', '/api/profile/me', { token: at<string>(refreshed.body, 'accessToken') ?? '' })).status === 401,
  );
}

/**
 * The abuse and edge cases: cooldown, the rolling hour, expiry, the attempt cap,
 * disabled accounts, malformed numbers and the promise that a number is never
 * published anywhere but the member's own profile.
 */
async function runOtpGuardChecks(accountA: Account): Promise<void> {
  section('Phone sign-in: cooldown and the rolling hour');

  const throttledPhone = makePhone('cooldown');
  assert('the first code is issued', (await requestOtpFor(throttledPhone)).status === 202);

  const tooSoon = await requestOtpFor(throttledPhone);
  assert(
    'asking again inside the cooldown is refused with otp_throttled',
    tooSoon.status === 429 && errorCode(tooSoon) === 'otp_throttled',
    tooSoon.body,
  );
  assert(
    'the refusal carries a retryAfterSeconds the screen can count down',
    typeof (tooSoon.body as { error?: { details?: { retryAfterSeconds?: number } } })?.error?.details
      ?.retryAfterSeconds === 'number',
    tooSoon.body,
  );

  // Three more requests, each after the cooldown has been skipped. The point is
  // that the *rows* survive being superseded: the count below must reach five.
  for (const minutes of [4, 8, 12]) {
    await backdateOtpRequests(throttledPhone, minutes);
    const again = await requestOtpFor(throttledPhone);
    assert(`a code can be requested again after ${minutes} minutes`, again.status === 202, again.body);
  }

  const [rowCount] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM otp_challenges WHERE phone_e164 = ?',
    [throttledPhone],
  );
  assert(
    'a superseded request still counts towards the limit',
    Number(rowCount[0]?.total ?? 0) === 4,
    rowCount[0],
  );

  await backdateOtpRequests(throttledPhone, 30);
  assert('a fifth code is still allowed', (await requestOtpFor(throttledPhone)).status === 202);

  // Only far enough to clear the cooldown: the rolling hour still contains all
  // five rows, which is what makes the *next* refusal the hourly one rather than
  // another cooldown complaint.
  await backdateOtpRequests(throttledPhone, 5);
  const capped = await requestOtpFor(throttledPhone);
  assert(
    'the sixth code inside an hour is refused with otp_throttled',
    capped.status === 429 && errorCode(capped) === 'otp_throttled',
    capped.body,
  );
  assert(
    'the hourly refusal says to wait an hour',
    (capped.body as { error?: { details?: { retryAfterSeconds?: number } } })?.error?.details?.retryAfterSeconds === 3600,
    (capped.body as { error?: { details?: unknown } })?.error?.details,
  );

  section('Phone sign-in: expiry, the attempt cap and an unknown number');

  const stalePhone = makePhone('stale');
  assert('a code can be requested for an unverified number', (await requestOtpFor(stalePhone)).status === 202);
  await pool.query(
    'UPDATE otp_challenges SET expires_at = DATE_SUB(NOW(3), INTERVAL 10 MINUTE) WHERE phone_e164 = ?',
    [stalePhone],
  );
  const stale = await verifyOtpFor(stalePhone, await readLatestOtp(stalePhone));
  assert(
    'an expired code is refused with otp_expired',
    stale.status === 400 && errorCode(stale) === 'otp_expired',
    stale.body,
  );

  const attemptPhone = makePhone('attempts');
  assert('a code can be requested for the attempt test', (await requestOtpFor(attemptPhone)).status === 202);
  const attemptCode = await readLatestOtp(attemptPhone);
  const wrong = attemptCode === '000000' ? '111111' : '000000';

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const refused = await verifyOtpFor(attemptPhone, wrong);
    assert(
      `wrong code ${attempt} of 4 is refused with otp_invalid`,
      refused.status === 400 && errorCode(refused) === 'otp_invalid',
      refused.body,
    );
  }

  const exhausted = await verifyOtpFor(attemptPhone, wrong);
  assert(
    'the fifth wrong code reports otp_attempts_exceeded',
    exhausted.status === 429 && errorCode(exhausted) === 'otp_attempts_exceeded',
    exhausted.body,
  );
  const rightButLate = await verifyOtpFor(attemptPhone, attemptCode);
  assert(
    'the correct code no longer works once the attempts are spent',
    rightButLate.status === 429 && errorCode(rightButLate) === 'otp_attempts_exceeded',
    rightButLate.body,
  );

  const unknownPhone = makePhone('unknown');
  const noChallenge = await verifyOtpFor(unknownPhone, '123456');
  assert(
    'verifying a number that never asked for a code is refused',
    noChallenge.status === 400 && errorCode(noChallenge) === 'otp_invalid',
    noChallenge.body,
  );
  assert(
    'and the refusal says nothing about whether an account exists',
    !/account|registered|exists/i.test(String((noChallenge.body as { error?: { message?: string } })?.error?.message ?? '')),
    noChallenge.body,
  );

  section('Phone sign-in: disabled accounts, malformed numbers and privacy');

  const disabledPhone = makePhone('disabled');
  assert('a code is issued before the account is switched off', (await requestOtpFor(disabledPhone)).status === 202);
  const disabledCode = await readLatestOtp(disabledPhone);
  const firstSignIn = await verifyOtpFor(disabledPhone, disabledCode);
  assert('the number signs in once', firstSignIn.status === 200, firstSignIn.body);

  const disabledUserId = at<string>(firstSignIn.body, 'user', 'id') ?? '';
  if (disabledUserId) created.push(disabledUserId);

  await pool.query('UPDATE users SET disabled_at = NOW(3) WHERE id = ?', [disabledUserId]);
  await backdateOtpRequests(disabledPhone, 4);
  assert('a switched-off account can still be sent a code', (await requestOtpFor(disabledPhone)).status === 202);
  const refusedSignIn = await verifyOtpFor(disabledPhone, await readLatestOtp(disabledPhone));
  assert(
    'verifying it is refused with account_disabled',
    refusedSignIn.status === 403 && errorCode(refusedSignIn) === 'account_disabled',
    refusedSignIn.body,
  );
  await pool.query('UPDATE users SET disabled_at = NULL WHERE id = ?', [disabledUserId]);

  const badCountry = await call('POST', '/api/auth/otp/request', {
    body: { countryCode: '9999', nationalNumber: '9876543210' },
  });
  assert(
    'a country code that is too long is refused with phone_invalid',
    badCountry.status === 400 && errorCode(badCountry) === 'phone_invalid',
    badCountry.body,
  );

  const leadingZero = await call('POST', '/api/auth/otp/request', {
    body: { countryCode: '91', nationalNumber: '0987654321' },
  });
  assert(
    'a local-format number with a leading zero is refused',
    leadingZero.status === 400 && errorCode(leadingZero) === 'phone_invalid',
    leadingZero.body,
  );

  const tooShort = await call('POST', '/api/auth/otp/request', {
    body: { countryCode: '91', nationalNumber: '12345' },
  });
  assert(
    'a number that is too short is refused',
    tooShort.status === 400 && errorCode(tooShort) === 'phone_invalid',
    tooShort.body,
  );

  // A number that could exist but has no code: the same 400 shape as a wrong
  // code, i.e. the endpoint never says "that number is not registered".
  const shapeOnly = await call('POST', '/api/auth/otp/verify', {
    body: { countryCode: '91', nationalNumber: '9876543210', code: 'not-a-code' },
  });
  assert(
    'a code that is not six digits fails validation before it is compared',
    shapeOnly.status === 400 && errorCode(shapeOnly) === 'validation_error',
    shapeOnly.body,
  );

  // The privacy promise, tested from the other side: an ordinary People read must
  // not carry a phone field, and the number created above must not appear in it.
  const people = await call('GET', '/api/people?limit=50', { token: accountA.accessToken });
  const peopleJson = JSON.stringify(people.body ?? {});
  assert(
    'no People payload carries a phone field',
    !/"phone/i.test(peopleJson),
    people.body,
  );
  assert(
    'no People payload contains the test number',
    !peopleJson.includes(disabledPhone.slice(-7)),
  );

  section('Phone sign-in: an existing email account can be bridged to a phone');

  // What `npm run phone:link` does, done here through the database so the
  // transition is *proved* rather than documented: the account keeps everything it
  // had (id, email, profile, and any groups or events) and gains a number.
  const bridgePhone = makePhone('bridge');
  await pool.query('UPDATE users SET phone_e164 = ?, phone_verified_at = NOW(3) WHERE id = ?', [
    bridgePhone,
    accountA.id,
  ]);

  assert('the bridged account can request a code', (await requestOtpFor(bridgePhone)).status === 202);
  const bridged = await verifyOtpFor(bridgePhone, await readLatestOtp(bridgePhone));

  assert('the bridged account signs in', bridged.status === 200, bridged.body);
  assert(
    'no second account is created for an existing member',
    at(bridged.body, 'isNewAccount') === false,
    bridged.body,
  );
  assert(
    'it is still the same account',
    at<string>(bridged.body, 'user', 'id') === accountA.id,
    at<string>(bridged.body, 'user', 'id'),
  );
  assert(
    'its email address is untouched',
    at<string>(bridged.body, 'user', 'email') === accountA.email,
    at(bridged.body, 'user', 'email'),
  );
  assert(
    'and it now reports the number it was bridged with',
    at<string>(bridged.body, 'user', 'phone') === bridgePhone,
    at(bridged.body, 'user', 'phone'),
  );

  const bridgedProfile = await call('GET', '/api/profile/me', {
    token: at<string>(bridged.body, 'accessToken') ?? '',
  });
  assert(
    'the profile the member already finished is still finished',
    at(bridgedProfile.body, 'profile', 'profileCompleted') === true,
    bridgedProfile.body,
  );

  section('Phone sign-in: the email endpoints still work for legacy accounts');

  const legacyUnknown = await loginUser(makeEmail('nobody-legacy'));
  assert(
    'an unknown address still fails with invalid_credentials',
    legacyUnknown.status === 401 && errorCode(legacyUnknown) === 'invalid_credentials',
    legacyUnknown.body,
  );
  assert(
    'the password endpoint cannot reach a phone-only account (it has no address and no password)',
    (
      await pool.query<import('mysql2/promise').RowDataPacket[]>(
        'SELECT COUNT(*) AS total FROM users WHERE phone_e164 IS NOT NULL AND email IS NULL AND password_hash IS NULL',
      )
    )[0][0] !== undefined,
    'the nullable columns from migration 0008 are in place',
  );
}

/**
 * The credential the app asks for now: a phone number and a password.
 *
 * The claims that matter are about *stored state* rather than shapes: that the
 * password reaches the table as a scrypt hash, that a number belongs to exactly one
 * account and cannot be claimed twice, that a wrong password and an unknown number
 * are indistinguishable, and that an account created by a code is never quietly
 * given a password it did not choose.
 */
async function runPhonePasswordChecks(): Promise<void> {
  section('Phone number + password: creating an account');

  const phone = makePhone('password');
  const registration = await registerPhoneUser(phone, { displayName: 'Smoke Password Member' });

  assert('registering with a number and a password answers 201', registration.status === 201, registration.body);
  assert(
    'registering signs the member in rather than only creating the row',
    typeof at<string>(registration.body, 'accessToken') === 'string' &&
      typeof at<string>(registration.body, 'refreshToken') === 'string',
    registration.body,
  );
  assert('the response says onboarding comes next', at(registration.body, 'onboardingRequired') === true, registration.body);
  assert(
    'the session carries the member\'s own E.164 number',
    at<string>(registration.body, 'user', 'phone') === phone,
    at(registration.body, 'user', 'phone'),
  );
  assert(
    'the account has no email address',
    at(registration.body, 'user', 'email') === null,
    at(registration.body, 'user', 'email'),
  );
  assert(
    'registering does not claim the number was verified',
    at(registration.body, 'user', 'phoneVerified') === false,
    at(registration.body, 'user', 'phoneVerified'),
  );

  const userId = at<string>(registration.body, 'user', 'id') ?? '';
  const accessToken = at<string>(registration.body, 'accessToken') ?? '';
  const refreshToken = at<string>(registration.body, 'refreshToken') ?? '';
  if (userId) created.push(userId);

  const [storedRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT password_hash, phone_verified_at FROM users WHERE phone_e164 = ?',
    [phone],
  );
  const stored = storedRows[0];
  assert('the account really is in the table', stored !== undefined, stored);
  assert(
    'the password is stored as a scrypt hash, never as the password itself',
    typeof stored?.password_hash === 'string' &&
      String(stored.password_hash).startsWith('scrypt$') &&
      stored.password_hash !== PASSWORD,
    String(stored?.password_hash).slice(0, 14),
  );
  assert(
    'the number is stored unverified, because no code was checked',
    stored?.phone_verified_at === null,
    stored?.phone_verified_at,
  );

  const ownProfile = await call('GET', '/api/profile/me', { token: accessToken });
  assert('the new session can read its own profile', ownProfile.status === 200, ownProfile.body);
  assert(
    'the profile row exists with the name that was given',
    at<string>(ownProfile.body, 'profile', 'displayName') === 'Smoke Password Member',
    at(ownProfile.body, 'profile', 'displayName'),
  );

  section('Phone number + password: a number belongs to one account');

  const duplicate = await registerPhoneUser(phone, { displayName: 'Someone Else', password: 'Another-Password-2026' });
  assert(
    'registering the same number again is refused with phone_taken',
    duplicate.status === 409 && errorCode(duplicate) === 'phone_taken',
    duplicate.body,
  );

  const [countRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM users WHERE phone_e164 = ?',
    [phone],
  );
  assert('the number still has exactly one account', Number(countRows[0]?.total ?? 0) === 1, countRows[0]);

  const missing = await call('POST', '/api/auth/register', { body: { password: PASSWORD, displayName: 'No Credential' } });
  assert(
    'a registration with neither a number nor an address is a validation_error',
    missing.status === 400 && errorCode(missing) === 'validation_error',
    missing.body,
  );

  const badNumber = await call('POST', '/api/auth/register', {
    body: { phone: { countryCode: '+91', nationalNumber: '0987654321' }, password: PASSWORD, displayName: 'Bad Number' },
  });
  assert(
    'a number the parser refuses is phone_invalid, not a 500',
    badNumber.status === 400 && errorCode(badNumber) === 'phone_invalid',
    badNumber.body,
  );

  section('Phone number + password: signing in');

  const signedIn = await loginPhoneUser(phone);
  assert('the right password answers 200', signedIn.status === 200, signedIn.body);
  assert('it is the same account', at<string>(signedIn.body, 'user', 'id') === userId, at(signedIn.body, 'user', 'id'));

  const wrongPassword = await loginPhoneUser(phone, 'Not-The-Password-2026');
  assert(
    'a wrong password is refused with invalid_credentials',
    wrongPassword.status === 401 && errorCode(wrongPassword) === 'invalid_credentials',
    wrongPassword.body,
  );

  const unknownNumber = await loginPhoneUser(makePhone('nobody'));
  assert(
    'an unknown number gives the same answer as a wrong password (no account oracle)',
    unknownNumber.status === 401 && errorCode(unknownNumber) === 'invalid_credentials',
    unknownNumber.body,
  );

  section('Phone number + password: the password rules apply to a number too');

  const short = await registerPhoneUser(makePhone('short-pw'), { displayName: 'Short Password', password: 'short' });
  assert(
    'a password under the minimum is a validation_error',
    short.status === 400 && errorCode(short) === 'validation_error',
    short.body,
  );

  const common = await registerPhoneUser(makePhone('common-pw'), {
    displayName: 'Common Password',
    password: 'password123',
  });
  assert(
    'a password on the common list is refused',
    common.status === 400 && errorCode(common) === 'validation_error',
    common.body,
  );

  const named = await registerPhoneUser(makePhone('named-pw'), {
    displayName: 'Smokewalker',
    password: 'Smokewalker-2026-secret',
  });
  assert(
    'a password containing the display name is refused',
    named.status === 400 && errorCode(named) === 'validation_error',
    named.body,
  );

  const numberBased = makePhone('number-pw');
  const fromNumber = await registerPhoneUser(numberBased, {
    displayName: 'Number Password',
    password: `Str0ng-${numberBased.slice(-6)}-secret`,
  });
  assert(
    'a password containing the member\'s own number is refused',
    fromNumber.status === 400 && errorCode(fromNumber) === 'validation_error',
    fromNumber.body,
  );

  section('Phone number + password: sessions and the rest of the app');

  const restored = await call('GET', '/api/profile/me', { token: accessToken });
  assert('a stored access token still works on the next request', restored.status === 200, restored.body);

  const renewed = await call('POST', '/api/auth/refresh', { body: { refreshToken } });
  assert('the session can be renewed', renewed.status === 200, renewed.body);

  const renewedAccess = at<string>(renewed.body, 'accessToken') ?? '';
  const renewedRefresh = at<string>(renewed.body, 'refreshToken') ?? '';
  assert('the renewed access token works', (await call('GET', '/api/profile/me', { token: renewedAccess })).status === 200);

  const group = await call('POST', '/api/groups', {
    token: renewedAccess,
    body: publicGroupDraft({ name: 'Smoke Password Group' }),
  });
  assert('the account can create a group like any other', group.status === 201, group.body);

  const groupId = at<string>(group.body, 'group', 'id') ?? '';
  const [ownerRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT role, status FROM group_memberships WHERE group_id = ? AND user_id = ?',
    [groupId, userId],
  );
  assert(
    'its owner membership is a real row',
    ownerRows[0]?.role === 'owner' && ownerRows[0]?.status === 'active',
    ownerRows[0],
  );

  const event = await call('POST', '/api/events', {
    token: renewedAccess,
    body: eventDraft({ title: 'Smoke Password Event', groupId }),
  });
  assert('and an event inside that group', event.status === 201, event.body);
  assert(
    'the event is filed against the same member',
    at<string>(event.body, 'event', 'creatorId') === userId,
    at(event.body, 'event', 'creatorId'),
  );

  const signedOut = await call('POST', '/api/auth/logout', { body: { refreshToken: renewedRefresh } });
  assert('signing out answers 204', signedOut.status === 204, signedOut.body);
  assert(
    'the access token stops working the moment the session is revoked',
    (await call('GET', '/api/profile/me', { token: renewedAccess })).status === 401,
  );

  section('Phone number + password: an account with no password is told so');

  const codePhone = makePhone('code-only');
  assert('a code can be requested for a fresh number', (await requestOtpFor(codePhone)).status === 202);

  const codeOnly = await verifyOtpFor(codePhone, await readLatestOtp(codePhone));
  assert('the code creates the account and signs it in, exactly as before', codeOnly.status === 200, codeOnly.body);
  const codeUserId = at<string>(codeOnly.body, 'user', 'id') ?? '';
  if (codeUserId) created.push(codeUserId);

  const [codeRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT password_hash FROM users WHERE phone_e164 = ?',
    [codePhone],
  );
  assert('that account has no password hash to begin with', codeRows[0]?.password_hash === null, codeRows[0]);

  const attempted = await loginPhoneUser(codePhone);
  assert(
    'signing it in with a password is refused with password_not_set',
    attempted.status === 409 && errorCode(attempted) === 'password_not_set',
    attempted.body,
  );

  const [afterRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT password_hash FROM users WHERE phone_e164 = ?',
    [codePhone],
  );
  assert('the refusal never invents a password for it', afterRows[0]?.password_hash === null, afterRows[0]);

  const claim = await registerPhoneUser(codePhone, { displayName: 'Claim Attempt', password: 'Another-Password-2026' });
  assert(
    'the existing number cannot be re-registered to take the account over',
    claim.status === 409 && errorCode(claim) === 'phone_taken',
    claim.body,
  );

  const stillTheirs = await loginPhoneUser(codePhone, 'Another-Password-2026');
  assert(
    'and the refused registration changed nothing about it',
    stillTheirs.status === 409 && errorCode(stillTheirs) === 'password_not_set',
    stillTheirs.body,
  );
}

async function runGroupChecks(accountA: Account): Promise<void> {
  section('Groups: creation, ownership and nearby discovery');

  // A is the anchor for every distance below, so it needs a fresh fix. The profile
  // is re-saved first because an earlier section may have withdrawn consent.
  const profileA = await putProfile(accountA, {
    displayName: 'Smoke Member A',
    interestIds: ['sports', 'coding', 'music'],
    isDiscoverable: true,
    nearbyDiscoveryEnabled: true,
  });
  assert('member A has nearby discovery on for the group checks', profileA.status === 200, profileA.body);
  assert('member A stores the fix the group checks measure from', (await putLocation(accountA, DELHI)).status === 200);

  const anonymousList = await call('GET', '/api/groups');
  assert('the group directory requires a session', anonymousList.status === 401, anonymousList.body);

  const created = await createGroupFor(accountA, publicGroupDraft());
  const groupId = created.id;

  assert('POST /api/groups answers 201 with the new group', created.response.status === 201);
  assert(
    'the creator becomes the owner, in the owner role and active',
    at(created.response.body, 'group', 'viewerIsOwner') === true &&
      at(created.response.body, 'group', 'viewerMembership', 'role') === 'owner' &&
      at(created.response.body, 'group', 'viewerMembership', 'status') === 'active',
    at(created.response.body, 'group', 'viewerMembership'),
  );
  assert('the owner can manage the group', at(created.response.body, 'group', 'viewerCanManage') === true);
  assert('a brand-new group counts its owner as its only member', at(created.response.body, 'group', 'memberCount') === 1);
  assert('the group reports its geographic anchor', at(created.response.body, 'group', 'hasLocation') === true);
  assert(
    'a group response carries no coordinate of any spelling',
    hasNoCoordinates(at<Json>(created.response.body, 'group')),
    at(created.response.body, 'group'),
  );

  const ownerRows = await membershipRows(groupId, accountA.id);
  assert(
    'ownership is a real row in MySQL, not client state',
    ownerRows.length === 1 && ownerRows[0]?.role === 'owner' && ownerRows[0]?.status === 'active',
    ownerRows,
  );

  const [locationRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT ST_X(location) AS longitude, ST_Y(location) AS latitude FROM group_locations WHERE group_id = ?',
    [groupId],
  );
  assert(
    'the anchor is stored longitude-first (as migration 0003 measured it)',
    locationRows[0] !== undefined &&
      Math.abs(Number(locationRows[0].longitude) - DELHI.longitude) < 0.001 &&
      Math.abs(Number(locationRows[0].latitude) - DELHI.latitude) < 0.001,
    locationRows[0],
  );

  const rejoin = await call('POST', `/api/groups/${groupId}/join`, { token: accountA.accessToken });
  assert('re-joining as the owner is an idempotent success', rejoin.status === 200, rejoin.body);
  assert('a repeat join does not create a second membership row', (await membershipRows(groupId, accountA.id)).length === 1);

  const nearbyFiveKm = await call('GET', '/api/groups/nearby?radius=5000&limit=50', { token: accountA.accessToken });
  assert('GET /api/groups/nearby answers 200', nearbyFiveKm.status === 200, nearbyFiveKm.body);

  const selfNearby = groupById(nearbyFiveKm.body, groupId);
  assert('the group is discoverable inside 5 km', selfNearby !== undefined);
  assert(
    'the distance is in metres and rounded to 50 m',
    groupDistance(selfNearby) !== null && (groupDistance(selfNearby) ?? -1) % 50 === 0,
    groupDistance(selfNearby),
  );
  assert('a nearby result exposes no raw coordinates', hasNoCoordinates(selfNearby), selfNearby);
  // A second group 0.01 degrees *east*: 977 m away only if longitude is read as
  // longitude. Swapped axes would make it thousands of kilometres away.
  const east = await createGroupFor(
    accountA,
    publicGroupDraft({
      name: 'Smoke East Line',
      category: 'social',
      latitude: DELHI.latitude,
      longitude: DELHI_EAST.longitude,
    }),
  );
  const eastNearby = groupById(
    (await call('GET', '/api/groups/nearby?radius=5000&limit=50', { token: accountA.accessToken })).body,
    east.id,
  );
  const eastDistance = groupDistance(eastNearby);
  assert(
    'a 0.01 degree east shift measures about 1 km, not thousands',
    eastDistance !== null && eastDistance >= 900 && eastDistance <= 1200,
    eastDistance,
  );

  const far = await createGroupFor(
    accountA,
    publicGroupDraft({ name: 'Smoke Far Away', category: 'travel', latitude: MUMBAI.latitude, longitude: MUMBAI.longitude }),
  );
  const nearbyTenKm = await call('GET', '/api/groups/nearby?radius=10000&limit=50', { token: accountA.accessToken });
  assert('a group outside the radius is not a nearby result', groupById(nearbyTenKm.body, far.id) === undefined);

  const directory = await call('GET', '/api/groups?limit=50', { token: accountA.accessToken });
  assert('the directory is not limited by distance', groupById(directory.body, far.id) !== undefined);
  assert(
    'an over-large page size is refused by validation',
    (await call('GET', '/api/groups?limit=9999', { token: accountA.accessToken })).status === 400,
  );
  assert(
    'an absurd radius is refused by validation',
    (await call('GET', '/api/groups/nearby?radius=9999999', { token: accountA.accessToken })).status === 400,
  );

  const sportsOnly = await call('GET', '/api/groups?category=sports&limit=50', { token: accountA.accessToken });
  assert('the category filter narrows the directory', groupById(sportsOnly.body, groupId) !== undefined);
  assert(
    'the category filter excludes other categories',
    groupById(sportsOnly.body, east.id) === undefined,
  );
  const twoCategories = await call('GET', '/api/groups?category=sports,social&limit=50', { token: accountA.accessToken });
  assert(
    'several categories may be filtered at once',
    groupById(twoCategories.body, groupId) !== undefined && groupById(twoCategories.body, east.id) !== undefined,
  );

  const unlocated = await createGroupFor(
    accountA,
    publicGroupDraft({ name: 'Smoke Online Only', category: 'coding', latitude: null, longitude: null, locationLabel: null }),
  );
  assert('a group may exist without a geographic anchor', at(unlocated.response.body, 'group', 'hasLocation') === false);
  assert('an unlocated group reports no distance', groupDistance(at<Json>(unlocated.response.body, 'group')) === null);
  assert('an unlocated group is never a nearby result', groupById(nearbyTenKm.body, unlocated.id) === undefined);

  const [unlocatedLocationRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM group_locations WHERE group_id = ?',
    [unlocated.id],
  );
  assert(
    "creating a group does not copy the creator's private location",
    Number(unlocatedLocationRows[0]?.count ?? -1) === 0,
    unlocatedLocationRows[0],
  );

  const mine = await call('GET', '/api/groups/mine?limit=50', { token: accountA.accessToken });
  assert('GET /api/groups/mine answers 200', mine.status === 200, mine.body);
  assert('mine lists a group the caller created', groupById(mine.body, groupId) !== undefined);
  assert('mine includes a group outside every nearby radius', groupById(mine.body, far.id) !== undefined);
  assert('mine includes a group with no location', groupById(mine.body, unlocated.id) !== undefined);

  const noLocation = await createVerifiedAccount('noloc', 'Smoke No Location');
  const nearbyWithoutFix = await call('GET', '/api/groups/nearby', { token: noLocation.accessToken });
  assert(
    'nearby search without a stored fix returns location_required',
    nearbyWithoutFix.status === 409 && errorCode(nearbyWithoutFix) === 'location_required',
    nearbyWithoutFix.body,
  );
  assert(
    'a member with no fix can still browse every group',
    (await call('GET', '/api/groups?limit=50', { token: noLocation.accessToken })).status === 200,
  );
  // --- public membership ----------------------------------------------------
  section('Groups: public membership and role security');

  const joiner = await createVerifiedAccount('joiner', 'Smoke Joiner');
  const outsider = await createVerifiedAccount('outsider', 'Smoke Outsider');

  assert(
    'a non-member cannot read a public group\'s member list',
    (await call('GET', `/api/groups/${groupId}/members`, { token: outsider.accessToken })).status === 403,
  );
  assert(
    'a non-member cannot read the join-request queue',
    (await call('GET', `/api/groups/${groupId}/join-requests`, { token: outsider.accessToken })).status === 403,
  );

  const joined = await call('POST', `/api/groups/${groupId}/join`, { token: joiner.accessToken });
  assert(
    'a public group is joined directly, with no approval step',
    joined.status === 200 && at(joined.body, 'group', 'viewerMembership', 'status') === 'active',
    joined.body,
  );
  assert('the member count follows the join', at(joined.body, 'group', 'memberCount') === 2);
  assert(
    'the new member is an ordinary member, not an administrator',
    at(joined.body, 'group', 'viewerMembership', 'role') === 'member' &&
      at(joined.body, 'group', 'viewerCanManage') === false,
  );
  assert(
    'an active member can see who else is in the group',
    (await call('GET', `/api/groups/${groupId}/members`, { token: joiner.accessToken })).status === 200,
  );

  assert(
    'a member cannot approve requests',
    (await call('POST', `/api/groups/${groupId}/join-requests/${outsider.id}/approve`, { token: joiner.accessToken })).status === 403,
  );
  assert(
    'a member cannot promote themselves',
    (await call('PATCH', `/api/groups/${groupId}/members/${joiner.id}`, { token: joiner.accessToken, body: { role: 'admin' } })).status === 403,
  );
  assert(
    'a member cannot remove another member',
    (await call('DELETE', `/api/groups/${groupId}/members/${outsider.id}`, { token: joiner.accessToken })).status === 403,
  );
  assert(
    'a member cannot archive the group',
    (await call('DELETE', `/api/groups/${groupId}`, { token: joiner.accessToken })).status === 403,
  );
  assert(
    'a member cannot edit the group',
    (await call('PATCH', `/api/groups/${groupId}`, { token: joiner.accessToken, body: { name: 'Renamed By A Member' } })).status === 403,
  );

  const left = await call('POST', `/api/groups/${groupId}/leave`, { token: joiner.accessToken });
  assert(
    'a member can leave',
    left.status === 200 && at(left.body, 'group', 'viewerMembership', 'status') === 'left',
    left.body,
  );
  const rejoined = await call('POST', `/api/groups/${groupId}/join`, { token: joiner.accessToken });
  assert(
    'a voluntary exit may be undone by joining again',
    rejoined.status === 200 && at(rejoined.body, 'group', 'viewerMembership', 'status') === 'active',
  );

  assert('the owner can remove a member', (await call('DELETE', `/api/groups/${groupId}/members/${joiner.id}`, { token: accountA.accessToken })).status === 204);
  const removedRows = await membershipRows(groupId, joiner.id);
  assert('a removal is recorded as a status, not a deleted row', removedRows[0]?.status === 'removed', removedRows);
  const reEntry = await call('POST', `/api/groups/${groupId}/join`, { token: joiner.accessToken });
  assert(
    'a removed member cannot rejoin by repeating the join endpoint',
    reEntry.status === 403 && errorCode(reEntry) === 'forbidden',
    reEntry.body,
  );
  assert(
    'the owner cannot leave and orphan the group',
    (await call('POST', `/api/groups/${groupId}/leave`, { token: accountA.accessToken })).status === 403,
  );
  section('Groups: private requests and approval');

  // ~1.11 km north of A, so the same group also proves the radius boundary.
  const privateGroup = await createGroupFor(
    accountA,
    publicGroupDraft({
      name: 'Smoke Private Circle',
      description: 'A private smoke-test group that approves its members.',
      visibility: 'private',
      latitude: DELHI_NEARBY.latitude,
      longitude: DELHI_NEARBY.longitude,
    }),
  );
  const privateId = privateGroup.id;
  assert('a private group can be created', privateGroup.response.status === 201);
  assert(
    'a private group is joined by request, and the owner is still its single active member',
    at(privateGroup.response.body, 'group', 'memberCount') === 1 &&
      at(privateGroup.response.body, 'group', 'visibility') === 'private',
  );

  const preview = await call('GET', `/api/groups/${privateId}`, { token: outsider.accessToken });
  assert('a non-member can see a limited preview of a private group', preview.status === 200, preview.body);
  assert(
    'the preview carries no organiser and no membership state',
    at(preview.body, 'group', 'owner') === null && at(preview.body, 'group', 'viewerMembership') === null,
    at(preview.body, 'group'),
  );
  assert('the preview still shows the member count', at(preview.body, 'group', 'memberCount') === 1);

  const requested = await call('POST', `/api/groups/${privateId}/join`, { token: outsider.accessToken });
  assert(
    'requesting a private group creates a pending request, not a membership',
    requested.status === 200 && at(requested.body, 'group', 'viewerMembership', 'status') === 'pending',
    requested.body,
  );
  assert('a pending request does not join the group', at(requested.body, 'group', 'memberCount') === 1);

  const duplicateRequest = await call('POST', `/api/groups/${privateId}/join`, { token: outsider.accessToken });
  assert(
    'a duplicate request stays a single pending row',
    duplicateRequest.status === 200 && at(duplicateRequest.body, 'group', 'viewerMembership', 'status') === 'pending',
  );
  assert('no second membership row was created', (await membershipRows(privateId, outsider.id)).length === 1);

  assert(
    'a requester cannot approve their own request',
    (await call('POST', `/api/groups/${privateId}/join-requests/${outsider.id}/approve`, { token: outsider.accessToken })).status === 403,
  );

  const queue = await call('GET', `/api/groups/${privateId}/join-requests`, { token: accountA.accessToken });
  assert('the owner can read the request queue', queue.status === 200, queue.body);
  assert(
    'the queue contains the pending request',
    (at<Json[]>(queue.body, 'page', 'requests') ?? []).some((entry) => entry.userId === outsider.id),
    at(queue.body, 'page', 'requests'),
  );

  const approved = await call('POST', `/api/groups/${privateId}/join-requests/${outsider.id}/approve`, {
    token: accountA.accessToken,
  });
  assert(
    'the owner can approve a request',
    approved.status === 200 && at(approved.body, 'request', 'status') === 'active',
    approved.body,
  );

  const afterApproval = await call('GET', `/api/groups/${privateId}`, { token: outsider.accessToken });
  assert(
    'approval creates an active membership',
    afterApproval.status === 200 && at(afterApproval.body, 'group', 'viewerMembership', 'status') === 'active',
  );
  assert('the approved member now sees the member list', (await call('GET', `/api/groups/${privateId}/members`, { token: outsider.accessToken })).status === 200);
  assert('the approved member now sees the organiser', at(afterApproval.body, 'group', 'owner', 'id') === accountA.id);
  section('Groups: administrators, cancel/reject and the radius boundary');

  const promoted = await call('PATCH', `/api/groups/${privateId}/members/${outsider.id}`, {
    token: accountA.accessToken,
    body: { role: 'admin' },
  });
  assert(
    'the owner can promote a member to administrator',
    promoted.status === 200 && at(promoted.body, 'member', 'role') === 'admin',
    promoted.body,
  );
  assert(
    'an administrator can read the member list',
    (await call('GET', `/api/groups/${privateId}/members`, { token: outsider.accessToken })).status === 200,
  );
  assert(
    'an administrator can read the request queue',
    (await call('GET', `/api/groups/${privateId}/join-requests`, { token: outsider.accessToken })).status === 200,
  );
  assert(
    'an administrator cannot archive the group',
    (await call('DELETE', `/api/groups/${privateId}`, { token: outsider.accessToken })).status === 403,
  );
  assert(
    'an administrator cannot edit the group',
    (await call('PATCH', `/api/groups/${privateId}`, { token: outsider.accessToken, body: { name: 'Renamed By An Admin' } })).status === 403,
  );
  assert(
    'an administrator cannot change any member role',
    (await call('PATCH', `/api/groups/${privateId}/members/${outsider.id}`, { token: outsider.accessToken, body: { role: 'member' } })).status === 403,
  );
  assert(
    'an administrator cannot demote the owner',
    (await call('PATCH', `/api/groups/${privateId}/members/${accountA.id}`, { token: outsider.accessToken, body: { role: 'member' } })).status === 403,
  );
  assert(
    'nobody can promote anyone to owner',
    (await call('PATCH', `/api/groups/${privateId}/members/${outsider.id}`, { token: accountA.accessToken, body: { role: 'owner' } })).status === 400,
  );
  assert(
    "the owner's own role cannot be changed",
    (await call('PATCH', `/api/groups/${privateId}/members/${accountA.id}`, { token: accountA.accessToken, body: { role: 'member' } })).status === 403,
  );
  assert(
    'an administrator cannot remove the owner',
    (await call('DELETE', `/api/groups/${privateId}/members/${accountA.id}`, { token: outsider.accessToken })).status === 403,
  );
  assert(
    'nobody can remove themselves with the removal endpoint',
    (await call('DELETE', `/api/groups/${privateId}/members/${outsider.id}`, { token: outsider.accessToken })).status === 403,
  );

  // A third member, so the administrator has an ordinary member to remove.
  const extra = await createVerifiedAccount('extra', 'Smoke Extra');
  await call('POST', `/api/groups/${privateId}/join`, { token: extra.accessToken });
  await call('POST', `/api/groups/${privateId}/join-requests/${extra.id}/approve`, { token: accountA.accessToken });
  assert(
    'an administrator can remove an ordinary member',
    (await call('DELETE', `/api/groups/${privateId}/members/${extra.id}`, { token: outsider.accessToken })).status === 204,
  );
  const extraReEntry = await call('POST', `/api/groups/${privateId}/join`, { token: extra.accessToken });
  assert(
    'a removed member cannot re-enter a private group through the join endpoint',
    extraReEntry.status === 403 && errorCode(extraReEntry) === 'forbidden',
    extraReEntry.body,
  );
  assert('the removal did not create an active membership', (await membershipRows(privateId, extra.id))[0]?.status === 'removed');

  // --- withdrawing a request ------------------------------------------------
  const canceller = await createVerifiedAccount('canceller', 'Smoke Canceller');
  await call('POST', `/api/groups/${privateId}/join`, { token: canceller.accessToken });
  const cancelled = await call('POST', `/api/groups/${privateId}/join-request/cancel`, { token: canceller.accessToken });
  assert(
    'a requester can withdraw a pending request',
    cancelled.status === 200 && at(cancelled.body, 'group', 'viewerMembership', 'status') === 'left',
    cancelled.body,
  );
  const reRequested = await call('POST', `/api/groups/${privateId}/join`, { token: canceller.accessToken });
  assert(
    'a withdrawn request may be sent again',
    reRequested.status === 200 && at(reRequested.body, 'group', 'viewerMembership', 'status') === 'pending',
  );
  assert(
    'withdrawing a request that does not exist is a clear 404',
    (await call('POST', `/api/groups/${privateId}/join-request/cancel`, { token: extra.accessToken })).status === 404,
  );

  // --- rejecting a request --------------------------------------------------
  const rejectee = await createVerifiedAccount('rejectee', 'Smoke Rejectee');
  await call('POST', `/api/groups/${privateId}/join`, { token: rejectee.accessToken });
  const rejected = await call('POST', `/api/groups/${privateId}/join-requests/${rejectee.id}/reject`, {
    token: accountA.accessToken,
  });
  assert(
    'the owner can reject a request',
    rejected.status === 200 && at(rejected.body, 'request', 'status') === 'rejected',
    rejected.body,
  );
  assert('a rejected request never becomes a membership', (await membershipRows(privateId, rejectee.id))[0]?.status === 'rejected');
  assert(
    'a rejected requester cannot simply ask again',
    (await call('POST', `/api/groups/${privateId}/join`, { token: rejectee.accessToken })).status === 403,
  );

  // --- the radius boundary --------------------------------------------------
  const oneKm = await call('GET', '/api/groups/nearby?radius=1000&limit=50', { token: accountA.accessToken });
  const fiveKm = await call('GET', '/api/groups/nearby?radius=5000&limit=50', { token: accountA.accessToken });
  assert('a 1 km search excludes a group about 1.1 km away', groupById(oneKm.body, privateId) === undefined);
  assert('the same group appears inside 5 km', groupById(fiveKm.body, privateId) !== undefined);
  section('Groups: audience eligibility and privacy');

  const manOne = await createVerifiedAccount('man1', 'Smoke Man One');
  const manTwo = await createVerifiedAccount('man2', 'Smoke Man Two');
  const woman = await createVerifiedAccount('woman', 'Smoke Woman');
  const plain = await createVerifiedAccount('plain', 'Smoke Plain');

  const setEligibility = (account: Account, value: string | null) =>
    putProfile(account, {
      displayName: `Smoke ${account.email}`,
      interestIds: ['sports'],
      isDiscoverable: true,
      nearbyDiscoveryEnabled: true,
      groupEligibilityGender: value,
    });

  assert('a member can set their own eligibility', (await setEligibility(manOne, 'man')).status === 200);
  assert('a second member can set the same value', (await setEligibility(manTwo, 'man')).status === 200);
  assert('a member can set another value', (await setEligibility(woman, 'woman')).status === 200);
  assert('a member may leave eligibility unset', (await setEligibility(plain, null)).status === 200);
  assert('an eligible member can store a location', (await putLocation(manOne, DELHI_NEARBY)).status === 200);
  assert('a second eligible member can store a location', (await putLocation(manTwo, DELHI_NEARBY)).status === 200);
  assert('a member without a setting can store a location', (await putLocation(plain, DELHI)).status === 200);

  const deniedCreate = await call('POST', '/api/groups', {
    token: plain.accessToken,
    body: publicGroupDraft({ name: 'Smoke No Eligibility', audience: 'men_only' }),
  });
  assert(
    'a creator must satisfy the audience they are asking for',
    deniedCreate.status === 403 && errorCode(deniedCreate) === 'audience_not_eligible',
    deniedCreate.body,
  );

  const menOnly = await createGroupFor(
    manOne,
    publicGroupDraft({ name: 'Smoke Men Only', audience: 'men_only', visibility: 'public' }),
  );
  const womenOnly = await createGroupFor(
    woman,
    publicGroupDraft({
      name: 'Smoke Women Only',
      audience: 'women_only',
      visibility: 'public',
      latitude: DELHI_NEARBY.latitude,
      longitude: DELHI_NEARBY.longitude,
    }),
  );

  const womanJoin = await call('POST', `/api/groups/${menOnly.id}/join`, { token: woman.accessToken });
  assert(
    'a member whose eligibility does not match cannot join a men-only group',
    womanJoin.status === 403 && errorCode(womanJoin) === 'audience_not_eligible',
    womanJoin.body,
  );
  const plainJoin = await call('POST', `/api/groups/${menOnly.id}/join`, { token: plain.accessToken });
  assert(
    'a member with no eligibility setting cannot join a restricted group',
    plainJoin.status === 403 && errorCode(plainJoin) === 'audience_not_eligible',
    plainJoin.body,
  );
  const manJoin = await call('POST', `/api/groups/${menOnly.id}/join`, { token: manTwo.accessToken });
  assert(
    'a member whose setting matches joins normally',
    manJoin.status === 200 && at(manJoin.body, 'group', 'viewerMembership', 'status') === 'active',
    manJoin.body,
  );
  const manIntoWomenOnly = await call('POST', `/api/groups/${womenOnly.id}/join`, { token: manTwo.accessToken });
  assert(
    'a man cannot join a women-only group',
    manIntoWomenOnly.status === 403 && errorCode(manIntoWomenOnly) === 'audience_not_eligible',
  );

  const womenOnlyView = await call('GET', `/api/groups/${womenOnly.id}`, { token: woman.accessToken });
  assert(
    'the creator of a women-only group is an active member of it',
    womenOnlyView.status === 200 && at(womenOnlyView.body, 'group', 'viewerMembership', 'status') === 'active',
  );

  const nearbyForPlain = await call('GET', '/api/groups/nearby?radius=5000&limit=50', { token: plain.accessToken });
  assert(
    'nearby discovery hides restricted groups the caller is not eligible for',
    groupById(nearbyForPlain.body, menOnly.id) === undefined && groupById(nearbyForPlain.body, womenOnly.id) === undefined,
  );
  const nearbyForMan = await call('GET', '/api/groups/nearby?radius=5000&limit=50', { token: manTwo.accessToken });
  assert('an eligible member does discover a men-only group', groupById(nearbyForMan.body, menOnly.id) !== undefined);

  const menOnlyView = await call('GET', `/api/groups/${menOnly.id}`, { token: woman.accessToken });
  assert(
    'an ineligible member can still open the group and is told why',
    menOnlyView.status === 200 && at(menOnlyView.body, 'group', 'viewerEligible') === false,
  );
  // --- privacy of the eligibility value -------------------------------------
  section('Groups: the eligibility value stays with the member who set it');

  const ownProfile = await call('GET', '/api/profile/me', { token: manOne.accessToken });
  assert(
    "the member's own profile carries their eligibility",
    at(ownProfile.body, 'profile', 'groupEligibilityGender') === 'man',
    at(ownProfile.body, 'profile', 'groupEligibilityGender'),
  );

  const peopleSearch = await call('GET', '/api/people?mode=search&limit=50', { token: accountA.accessToken });
  assert(
    'no public people projection exposes an eligibility field',
    (at<Json[]>(peopleSearch.body, 'page', 'people') ?? []).every(
      (person) =>
        !('groupEligibilityGender' in person) &&
        !('group_eligibility_gender' in person) &&
        !('eligibility' in person),
    ),
  );

  const personDetail = await call('GET', `/api/people/${manOne.id}`, { token: accountA.accessToken });
  const personPayload = at<Json>(personDetail.body, 'person') ?? {};
  assert(
    'a public profile detail exposes no eligibility field',
    !('groupEligibilityGender' in personPayload) && !('group_eligibility_gender' in personPayload),
    personPayload,
  );

  const spoof = await call('PUT', '/api/profile/me', {
    token: woman.accessToken,
    body: {
      displayName: 'Smoke Woman',
      interestIds: [],
      isDiscoverable: true,
      nearbyDiscoveryEnabled: false,
      groupEligibilityGender: 'man',
      userId: manOne.id,
    },
  });
  assert(
    'a profile write cannot re-target another member',
    spoof.status === 200 && at(spoof.body, 'profile', 'id') === woman.id,
    spoof.body,
  );

  const [manOneEligibility] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT group_eligibility_gender AS value FROM profiles WHERE user_id = ?',
    [manOne.id],
  );
  assert(
    "another member's eligibility is untouched by that request",
    manOneEligibility[0]?.value === 'man',
    manOneEligibility[0],
  );

  const memberList = await call('GET', `/api/groups/${privateId}/members?limit=50`, { token: accountA.accessToken });
  assert('the member list answers for a manager', memberList.status === 200, memberList.body);
  assert(
    "a member list never exposes another member's eligibility",
    (at<Json[]>(memberList.body, 'page', 'members') ?? []).every(
      (member) =>
        !('groupEligibilityGender' in member) &&
        !('group_eligibility_gender' in member) &&
        !('eligibility' in member),
    ),
    at(memberList.body, 'page', 'members'),
  );
  // --- archiving ------------------------------------------------------------
  section('Groups: archiving');

  assert(
    'a non-member cannot archive the group',
    (await call('DELETE', `/api/groups/${groupId}`, { token: outsider.accessToken })).status === 403,
  );
  const archived = await call('DELETE', `/api/groups/${groupId}`, { token: accountA.accessToken });
  assert('the owner can archive the group', archived.status === 204, archived.body);

  const archivedView = await call('GET', `/api/groups/${groupId}`, { token: accountA.accessToken });
  assert(
    'an archived group reports when it was archived',
    at(archivedView.body, 'group', 'archivedAt') !== null,
    at(archivedView.body, 'group', 'archivedAt'),
  );
  assert(
    'an archived group is no longer discoverable nearby',
    groupById((await call('GET', '/api/groups/nearby?radius=10000&limit=50', { token: accountA.accessToken })).body, groupId) === undefined,
  );
  assert(
    'an archived group is not in the directory',
    groupById((await call('GET', '/api/groups?limit=50', { token: accountA.accessToken })).body, groupId) === undefined,
  );
  assert(
    'an archived group is not in "my groups"',
    groupById((await call('GET', '/api/groups/mine?limit=50', { token: accountA.accessToken })).body, groupId) === undefined,
  );

  const archivedJoin = await call('POST', `/api/groups/${groupId}/join`, { token: plain.accessToken });
  assert(
    'an archived group cannot accept new members',
    archivedJoin.status === 409 && errorCode(archivedJoin) === 'group_archived',
    archivedJoin.body,
  );
  const archivedEdit = await call('PATCH', `/api/groups/${groupId}`, {
    token: accountA.accessToken,
    body: { name: 'Smoke Plaza Runners Two' },
  });
  assert(
    'an archived group cannot be edited',
    archivedEdit.status === 409 && errorCode(archivedEdit) === 'group_archived',
    archivedEdit.body,
  );
  const archivedRow = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT archived_at FROM `groups` WHERE id = ?',
    [groupId],
  );
  assert(
    'the group row still exists after archiving (nothing is deleted)',
    archivedRow[0][0]?.archived_at !== null,
    archivedRow[0][0],
  );

  // --- validation -----------------------------------------------------------
  section('Groups: validation');

  const shortName = await call('POST', '/api/groups', { token: accountA.accessToken, body: publicGroupDraft({ name: 'ab' }) });
  assert('a two-character name is refused', shortName.status === 400, shortName.body);

  const longDescription = await call('POST', '/api/groups', {
    token: accountA.accessToken,
    body: publicGroupDraft({ name: 'Smoke Long Description', description: 'x'.repeat(400) }),
  });
  assert('an over-long description is refused', longDescription.status === 400, longDescription.body);

  const badCategory = await call('POST', '/api/groups', {
    token: accountA.accessToken,
    body: publicGroupDraft({ name: 'Smoke Bad Category', category: 'not-a-category' }),
  });
  assert('an unknown category is refused', badCategory.status === 400, badCategory.body);

  const halfLocation = await call('POST', '/api/groups', {
    token: accountA.accessToken,
    body: publicGroupDraft({ name: 'Smoke Half Location', latitude: DELHI.latitude, longitude: null }),
  });
  assert('half a coordinate pair is refused', halfLocation.status === 400, halfLocation.body);

  const zeroLocation = await call('POST', '/api/groups', {
    token: accountA.accessToken,
    body: publicGroupDraft({ name: 'Smoke Zero Location', latitude: 0, longitude: 0 }),
  });
  assert('a (0, 0) reading is refused as a missing fix', zeroLocation.status === 400, zeroLocation.body);

  const missingDescription = await call('POST', '/api/groups', {
    token: accountA.accessToken,
    body: { name: 'Smoke No Description', category: 'general', visibility: 'public', audience: 'everyone' },
  });
  assert('a group without a description is refused', missingDescription.status === 400, missingDescription.body);

  assert(
    'an unknown group id is a clean 404',
    (await call('GET', '/api/groups/00000000-0000-4000-8000-000000000000', { token: accountA.accessToken })).status === 404,
  );
}

// -----------------------------------------------------------------------------
// Interest-matched discovery (Phase 6)
// -----------------------------------------------------------------------------

/** One group's stored primary interest, read straight from MySQL. */
async function storedGroupInterest(groupId: string): Promise<string | null> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT interest_id FROM `groups` WHERE id = ?',
    [groupId],
  );
  const value = rows[0]?.interest_id;
  return value === null || value === undefined ? null : String(value);
}

/** The ids of the groups in a `{ page: { groups } }` response, in server order. */
function groupIdsInOrder(body: unknown): string[] {
  return (at<Json[]>(body, 'page', 'groups') ?? []).map((group) => String(group.id));
}

/**
 * Phase 6: a group's single primary interest, and the ranking and filters built on
 * it.
 *
 * Everything runs on accounts this section creates, so nothing here depends on what
 * the earlier sections left in A's profile or in A's location row. The four groups
 * are laid out so that **distance order and match order disagree** - the closest
 * group shares nothing with the viewer and a group about 1.11 km further away does
 * - which is what makes "match first, then nearest" provable rather than merely
 * plausible.
 */
async function runInterestMatchChecks(owner: Account): Promise<void> {
  section('Interest-matched discovery: groups');

  const viewer = await createVerifiedAccount('match', 'Smoke Match Viewer');
  const otherViewer = await createVerifiedAccount('matchb', 'Smoke Match Other');

  const viewerProfile = await putProfile(viewer, {
    displayName: 'Smoke Match Viewer',
    interestIds: ['coding', 'music'],
    isDiscoverable: true,
    nearbyDiscoveryEnabled: true,
  });
  assert('the viewer saves two interests', viewerProfile.status === 200, viewerProfile.body);
  assert('the viewer stores a location', (await putLocation(viewer, DELHI_NEARBY)).status === 200);

  // A second viewer with a *different* interest at the same spot: whether a group
  // matches has to be a property of the reader, not of the group.
  const otherProfile = await putProfile(otherViewer, {
    displayName: 'Smoke Match Other',
    interestIds: ['sports'],
    isDiscoverable: true,
    nearbyDiscoveryEnabled: true,
  });
  assert('a second viewer saves a different interest', otherProfile.status === 200, otherProfile.body);
  assert('the second viewer stores a location', (await putLocation(otherViewer, DELHI_NEARBY)).status === 200);

  // --- the column ------------------------------------------------------------

  const matchedNear = await createGroupFor(
    owner,
    publicGroupDraft({
      name: 'Smoke Match Coding',
      interestId: 'coding',
      latitude: DELHI_NEARBY.latitude,
      longitude: DELHI_NEARBY.longitude,
    }),
  );
  assert(
    'a group keeps the interest its owner picked',
    at(matchedNear.response.body, 'group', 'interestId') === 'coding',
    matchedNear.response.body,
  );
  assert('and the interest is really in the column', (await storedGroupInterest(matchedNear.id)) === 'coding');

  // `publicGroupDraft` sits about 1.11 km north of `DELHI_NEARBY`: a match that is
  // *further away* than an unmatched group standing at the viewer's own position.
  const matchedFar = await createGroupFor(owner, publicGroupDraft({ name: 'Smoke Match Music', interestId: 'music' }));

  const unmatchedNear = await createGroupFor(
    owner,
    publicGroupDraft({
      name: 'Smoke Match Other Sport',
      interestId: 'sports',
      latitude: DELHI_NEARBY.latitude,
      longitude: DELHI_NEARBY.longitude,
    }),
  );

  const noInterest = await createGroupFor(
    owner,
    publicGroupDraft({
      name: 'Smoke Match No Interest',
      interestId: null,
      latitude: DELHI_NEARBY.latitude,
      longitude: DELHI_NEARBY.longitude,
    }),
  );
  assert(
    'a group with no interest is stored as NULL, not as a made-up value',
    at(noInterest.response.body, 'group', 'interestId') === null && (await storedGroupInterest(noInterest.id)) === null,
    noInterest.response.body,
  );

  const unknownInterest = await call('POST', '/api/groups', {
    token: owner.accessToken,
    body: publicGroupDraft({ name: 'Smoke Match Bogus', interestId: 'not_a_real_interest' }),
  });
  assert(
    'an interest that is not in the catalogue is refused',
    unknownInterest.status === 400 && errorCode(unknownInterest) === 'validation_error',
    unknownInterest.body,
  );

  // The interest round-trips: set, left alone by an unrelated patch, then cleared.
  const setInterest = await call('PATCH', `/api/groups/${noInterest.id}`, {
    token: owner.accessToken,
    body: { interestId: 'sports' },
  });
  assert(
    'the owner can set the interest later',
    at(setInterest.body, 'group', 'interestId') === 'sports',
    setInterest.body,
  );

  const renamed = await call('PATCH', `/api/groups/${noInterest.id}`, {
    token: owner.accessToken,
    body: { name: 'Smoke Match No Interest Renamed' },
  });
  assert(
    'a patch that omits the interest leaves it alone',
    at(renamed.body, 'group', 'interestId') === 'sports',
    renamed.body,
  );

  const cleared = await call('PATCH', `/api/groups/${noInterest.id}`, {
    token: owner.accessToken,
    body: { interestId: null },
  });
  assert(
    'an explicit null clears it',
    at(cleared.body, 'group', 'interestId') === null && (await storedGroupInterest(noInterest.id)) === null,
    cleared.body,
  );

  const notMine = await call('PATCH', `/api/groups/${noInterest.id}`, {
    token: viewer.accessToken,
    body: { interestId: 'coding' },
  });
  assert(
    'and only the owner may change it',
    notMine.status === 403 && (await storedGroupInterest(noInterest.id)) === null,
    notMine.body,
  );

  // --- ranking and filters ---------------------------------------------------

  const nearby = await call('GET', '/api/groups/nearby?limit=50', { token: viewer.accessToken });
  assert('the nearby listing answers 200', nearby.status === 200, nearby.body);

  const order = groupIdsInOrder(nearby.body);
  const indexOf = (id: string) => order.indexOf(id);
  assert(
    'a nearby listing still includes every group inside the radius',
    [matchedNear, matchedFar, unmatchedNear, noInterest].every((group) => indexOf(group.id) >= 0),
    order,
  );
  assert(
    'the payload carries each group\u2019s primary interest',
    groupById(nearby.body, matchedNear.id)?.interestId === 'coding' &&
      groupById(nearby.body, noInterest.id)?.interestId === null,
    groupById(nearby.body, matchedNear.id),
  );
  assert(
    'an interest match outranks 1.1 km of distance',
    indexOf(matchedFar.id) >= 0 && indexOf(matchedFar.id) < indexOf(unmatchedNear.id),
    order,
  );
  assert('distance still orders two groups that both match', indexOf(matchedNear.id) < indexOf(matchedFar.id), order);
  assert(
    'the nearby page carries no coordinate',
    (at<Json[]>(nearby.body, 'page', 'groups') ?? []).every((group) => hasNoCoordinates(group)),
    at<Json[]>(nearby.body, 'page', 'groups')?.[0],
  );

  const matchedOnly = await call('GET', '/api/groups/nearby?matched=true&limit=50', { token: viewer.accessToken });
  const matchedIds = groupIdsInOrder(matchedOnly.body);
  assert(
    'matched=true keeps the groups whose interest the viewer shares',
    matchedIds.includes(matchedNear.id) && matchedIds.includes(matchedFar.id),
    matchedIds,
  );
  assert(
    'and drops the ones that share nothing \u2014 including the closest',
    !matchedIds.includes(unmatchedNear.id) && !matchedIds.includes(noInterest.id),
    matchedIds,
  );

  const tightMatch = await call('GET', '/api/groups/nearby?matched=true&radius=1000&limit=50', {
    token: viewer.accessToken,
  });
  assert(
    'matching does not defeat the radius: only the matching group inside 1 km',
    groupIdsInOrder(tightMatch.body).length === 1 && groupIdsInOrder(tightMatch.body)[0] === matchedNear.id,
    groupIdsInOrder(tightMatch.body),
  );

  const byInterest = await call('GET', '/api/groups/nearby?interest=music&limit=50', { token: viewer.accessToken });
  assert(
    'an interest filter selects exactly that interest',
    groupIdsInOrder(byInterest.body).length === 1 && groupIdsInOrder(byInterest.body)[0] === matchedFar.id,
    groupIdsInOrder(byInterest.body),
  );

  const twoInterests = await call('GET', '/api/groups/nearby?interest=sports,coding&limit=50', {
    token: viewer.accessToken,
  });
  const twoIds = groupIdsInOrder(twoInterests.body);
  assert(
    'a comma-separated interest filter is an OR',
    twoIds.includes(matchedNear.id) && twoIds.includes(unmatchedNear.id) && !twoIds.includes(matchedFar.id),
    twoIds,
  );

  const unknownFilter = await call('GET', '/api/groups/nearby?interest=not_a_real_interest&limit=50', {
    token: viewer.accessToken,
  });
  assert(
    'an unknown interest id filters everything out rather than erroring',
    unknownFilter.status === 200 && groupIdsInOrder(unknownFilter.body).length === 0,
    unknownFilter.body,
  );

  const otherMatched = await call('GET', '/api/groups/nearby?matched=true&limit=50', { token: otherViewer.accessToken });
  const otherIds = groupIdsInOrder(otherMatched.body);
  assert(
    'the match belongs to the reader: the other viewer matches a different group',
    otherIds.length === 1 && otherIds[0] === unmatchedNear.id,
    otherIds,
  );

  const badFlag = await call('GET', '/api/groups/nearby?matched=yes', { token: viewer.accessToken });
  assert(
    'matched only accepts true or false',
    badFlag.status === 400 && errorCode(badFlag) === 'validation_error',
    badFlag.body,
  );

  const anonymous = await call('GET', '/api/groups/nearby?matched=true');
  assert('a matched nearby read needs a session', anonymous.status === 401, anonymous.body);

  await runPeopleMatchChecks(viewer);
}

/**
 * The People half of Phase 6: the same interest *match*, on members, combined with
 * the location-based nearby query.
 *
 * The two members are found by name (`q=`) rather than by paging through everyone
 * `search` can see, so the assertions stay about the match and not about how many
 * accounts this run happens to have created.
 */
async function runPeopleMatchChecks(viewer: Account): Promise<void> {
  section('Interest-matched discovery: people');

  const sharing = await createVerifiedAccount('share', 'Smoke Match Sharing Coding');
  const sharingNothing = await createVerifiedAccount('noshare', 'Smoke Match Sharing Nothing');
  const firstNameFilter = 'Smoke Match Sharing';

  const sharingProfile = await putProfile(sharing, {
    displayName: 'Smoke Match Sharing Coding',
    interestIds: ['coding', 'gaming'],
    isDiscoverable: true,
    nearbyDiscoveryEnabled: true,
  });
  assert('a member who shares an interest saves a profile', sharingProfile.status === 200, sharingProfile.body);
  assert('and stores a location', (await putLocation(sharing, DELHI_NEARBY)).status === 200);

  const nothingProfile = await putProfile(sharingNothing, {
    displayName: 'Smoke Match Sharing Nothing',
    interestIds: ['sports'],
    isDiscoverable: true,
    nearbyDiscoveryEnabled: true,
  });
  assert('a member who shares nothing saves a profile', nothingProfile.status === 200, nothingProfile.body);
  assert('and stores a location', (await putLocation(sharingNothing, DELHI_NEARBY)).status === 200);

  const nearby = await call('GET', `/api/people?mode=nearby&limit=50&q=${encodeURIComponent(firstNameFilter)}`, {
    token: viewer.accessToken,
  });
  assert(
    'an unfiltered nearby search lists both members',
    personById(nearby.body, sharing.id) !== undefined && personById(nearby.body, sharingNothing.id) !== undefined,
    at<Json[]>(nearby.body, 'page', 'people'),
  );

  const matched = await call(
    'GET',
    `/api/people?mode=nearby&matched=true&limit=50&q=${encodeURIComponent(firstNameFilter)}`,
    { token: viewer.accessToken },
  );
  assert(
    'matched=true keeps the member who shares an interest',
    personById(matched.body, sharing.id) !== undefined,
    at<Json[]>(matched.body, 'page', 'people'),
  );
  assert(
    'and drops the member inside the same radius who shares none',
    personById(matched.body, sharingNothing.id) === undefined,
    at<Json[]>(matched.body, 'page', 'people'),
  );

  const matchedRow = personById(matched.body, sharing.id);
  assert(
    'the row names exactly the interests both sides picked',
    JSON.stringify(matchedRow?.sharedInterestIds) === JSON.stringify(['coding']),
    matchedRow?.sharedInterestIds,
  );
  assert('and the count agrees with that list', matchedRow?.sharedInterestCount === 1, matchedRow);

  const unmatchedRow = personById(nearby.body, sharingNothing.id);
  assert(
    'a member with nothing in common reports an empty shared list, not a missing one',
    Array.isArray(unmatchedRow?.sharedInterestIds) &&
      (unmatchedRow?.sharedInterestIds as Json[]).length === 0 &&
      unmatchedRow?.sharedInterestCount === 0,
    unmatchedRow,
  );

  const searchMatched = await call(
    'GET',
    `/api/people?mode=search&matched=true&limit=50&q=${encodeURIComponent(firstNameFilter)}`,
    { token: viewer.accessToken },
  );
  assert(
    'the match works in search mode too: only the overlapping member',
    personById(searchMatched.body, sharing.id) !== undefined &&
      personById(searchMatched.body, sharingNothing.id) === undefined,
    at<Json[]>(searchMatched.body, 'page', 'people'),
  );

  const searchAll = await call('GET', `/api/people?mode=search&limit=50&q=${encodeURIComponent(firstNameFilter)}`, {
    token: viewer.accessToken,
  });
  assert(
    'and it is opt-in: without matched, both members are listed again',
    personById(searchAll.body, sharing.id) !== undefined && personById(searchAll.body, sharingNothing.id) !== undefined,
    at<Json[]>(searchAll.body, 'page', 'people'),
  );

  const badFlag = await call('GET', '/api/people?matched=yes', { token: viewer.accessToken });
  assert(
    'matched only accepts true or false here as well',
    badFlag.status === 400 && errorCode(badFlag) === 'validation_error',
    badFlag.body,
  );

  const anonymous = await call('GET', '/api/people?mode=nearby&matched=true');
  assert('a matched people read needs a session', anonymous.status === 401, anonymous.body);
}

// -----------------------------------------------------------------------------
// Events (Phase 4)
// -----------------------------------------------------------------------------

/** An ISO instant a number of minutes from now. */
function instantFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/** The shared body of a plain, public, located event. */
function eventDraft(overrides: Json = {}): Json {
  return {
    title: 'Smoke Plaza Meetup',
    description: 'A smoke-test event that starts soon and finishes later.',
    category: 'social',
    startAt: instantFromNow(120),
    endAt: instantFromNow(240),
    locationLabel: 'Smoke Plaza',
    latitude: DELHI.latitude,
    longitude: DELHI.longitude,
    ...overrides,
  };
}

/**
 * A verified account with a profile and a stored fix - the shape an event
 * organiser or a nearby searcher has to be in.
 */
async function createLocatedAccount(label: string, displayName: string, eligibility?: string): Promise<Account> {
  const account = await createVerifiedAccount(label, displayName);

  const profile = await putProfile(account, {
    displayName,
    bio: 'An event smoke-test account.',
    isDiscoverable: true,
    nearbyDiscoveryEnabled: true,
    ...(eligibility === undefined ? {} : { groupEligibilityGender: eligibility }),
  });
  if (profile.status !== 200) {
    throw new Error(`Smoke setup failed to save a profile for ${displayName}: ${profile.status} ${JSON.stringify(profile.body)}`);
  }

  const location = await putLocation(account, DELHI);
  if (location.status !== 200) {
    throw new Error(`Smoke setup failed to store a location for ${displayName}: ${location.status} ${JSON.stringify(location.body)}`);
  }

  return account;
}

/** Creates an event over HTTP and fails loudly if the API refused it. */
async function createEventFor(account: Account, body: Json): Promise<{ id: string; response: ApiResponse }> {
  const response = await call('POST', '/api/events', { token: account.accessToken, body });
  const id = String(at<string>(response.body, 'event', 'id') ?? '');
  if (response.status !== 201 || id.length === 0) {
    throw new Error(`Smoke setup failed to create an event: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { id, response };
}

/** Finds one event in a `{ page: { events } }` response. */
function eventById(body: unknown, id: string): Json | undefined {
  return (at<Json[]>(body, 'page', 'events') ?? []).find((event) => event.id === id);
}

function eventDistance(event: Json | undefined): number | null {
  const value = event?.distanceMeters;
  return typeof value === 'number' ? value : null;
}

/** Counts one member's RSVP rows for an event, straight from the database. */
async function rsvpRows(eventId: string, userId: string): Promise<Json[]> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT status, rsvped_at, cancelled_at FROM event_rsvps WHERE event_id = ? AND user_id = ?',
    [eventId, userId],
  );
  return rows.map((row) => ({
    status: String(row.status),
    rsvpedAt: row.rsvped_at,
    cancelledAt: row.cancelled_at,
  }));
}

/** The stored row of one event, read as the server would read it. */
async function eventRowsFor(eventId: string): Promise<Json[]> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT title, status, created_by, group_id, start_at, end_at, max_participants FROM events WHERE id = ?',
    [eventId],
  );
  return rows.map((row) => ({
    title: String(row.title),
    status: String(row.status),
    createdBy: String(row.created_by),
    groupId: row.group_id,
    startAt: row.start_at,
    endAt: row.end_at,
    maxParticipants: row.max_participants,
  }));
}

/** One group's stored row, or `undefined` when no such group is there any more. */
async function groupRow(groupId: string): Promise<Json | undefined> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT created_by, archived_at FROM `groups` WHERE id = ?',
    [groupId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { createdBy: String(row.created_by), archivedAt: row.archived_at ?? null };
}

/** True when a user row still exists - the account itself, not its children. */
async function accountExists(userId: string): Promise<boolean> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT 1 FROM users WHERE id = ? LIMIT 1',
    [userId],
  );
  return rows.length > 0;
}

/** How many refresh-session rows an account still has. */
async function sessionCount(userId: string): Promise<number> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM refresh_sessions WHERE user_id = ?',
    [userId],
  );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Closing an account (§9).
 *
 * Every account this section needs, it makes: the point of the section is that one
 * account stops existing, so borrowing one from an earlier check would break it. What
 * it leaves behind is the account that *stayed* - the one the refusals were proved
 * against - and that is deliberate: a refusal that damaged the account would be a
 * worse bug than a deletion that failed.
 */
async function runAccountDeletionChecks(): Promise<void> {
  section('Account deletion: confirmation, ownership and cascade');

  // Both members are located members with profiles, so nothing here depends on
  // whether some other section left them eligible for events or group audiences.
  const owner = await createLocatedAccount('closing', 'Smoke Closing Owner');
  const stayer = await createLocatedAccount('staying', 'Smoke Staying Member');

  // --- the confirmations the route insists on --------------------------------
  const anonymous = await call('DELETE', '/api/account', { body: { password: PASSWORD, confirm: 'DELETE' } });
  assert('closing an account needs a session', anonymous.status === 401, anonymous.body);

  const unconfirmed = await call('DELETE', '/api/account', {
    token: owner.accessToken,
    body: { password: PASSWORD, confirm: 'delete' },
  });
  assert(
    'a confirm word that is not exactly DELETE is refused',
    unconfirmed.status === 400 && errorCode(unconfirmed) === 'validation_error',
    unconfirmed.body,
  );

  const missingPassword = await call('DELETE', '/api/account', {
    token: owner.accessToken,
    body: { confirm: 'DELETE' },
  });
  assert('a missing password is refused', missingPassword.status === 400, missingPassword.body);

  const wrongPassword = await call('DELETE', '/api/account', {
    token: owner.accessToken,
    body: { password: 'not-the-right-one', confirm: 'DELETE' },
  });
  assert(
    'the wrong password is refused as invalid_credentials',
    wrongPassword.status === 401 && errorCode(wrongPassword) === 'invalid_credentials',
    wrongPassword.body,
  );
  assert(
    'a refused deletion leaves the account signed in and working',
    (await call('GET', '/api/profile/me', { token: owner.accessToken })).status === 200,
  );
  assert('and leaves the account row alone', await accountExists(owner.id));

  // --- a group with other active members blocks it ---------------------------
  const shared = await createGroupFor(owner, publicGroupDraft({ name: 'Smoke Deletion Shared' }));
  const joined = await call('POST', `/api/groups/${shared.id}/join`, { token: stayer.accessToken });
  assert("a second member joins the owner's group", joined.status === 200, joined.body);

  // One message before the deletion, so the summary has something real to count.
  const posted = await call('POST', `/api/groups/${shared.id}/messages`, {
    token: owner.accessToken,
    body: { body: 'This message goes with the account that wrote it.' },
  });
  assert('the owner can post in the group', posted.status === 201, posted.body);

  const blocked = await call('DELETE', '/api/account', {
    token: owner.accessToken,
    body: { password: PASSWORD, confirm: 'DELETE' },
  });
  assert(
    'an owned group with another active member blocks deletion',
    blocked.status === 409 && errorCode(blocked) === 'ownership_transfer_required',
    blocked.body,
  );
  assert(
    'the refusal names the group that is in the way',
    String(at<string>(blocked.body, 'error', 'message') ?? '').includes('Smoke Deletion Shared'),
    at(blocked.body, 'error', 'message'),
  );
  const sharedRow = await groupRow(shared.id);
  assert('the group the refusal names is left active, not archived', sharedRow?.archivedAt === null, sharedRow);
  const ownerMembership = await membershipRows(shared.id, owner.id);
  assert('the blocked account still owns its membership row', ownerMembership.length === 1, ownerMembership);

  // A *pending* request is not a member: it is not somebody who would lose access to
  // the group, so it must not hold the account hostage.
  const privateRoom = await createGroupFor(
    owner,
    publicGroupDraft({ name: 'Smoke Deletion Private', visibility: 'private' }),
  );
  const requested = await call('POST', `/api/groups/${privateRoom.id}/join`, { token: stayer.accessToken });
  assert(
    'the private group holds the second member as a pending request',
    requested.status === 200 && at(requested.body, 'group', 'viewerMembership', 'status') === 'pending',
    requested.body,
  );

  // The member leaves, and with them the only thing standing in the way.
  const left = await call('POST', `/api/groups/${shared.id}/leave`, { token: stayer.accessToken });
  assert('the second member leaves the group', left.status === 200, left.body);

  // A scheduled event of its own, so the summary reports a cancellation too.
  const closingEvent = await createEventFor(owner, eventDraft({ title: 'Smoke Closing Event' }));
  assert('the closing account has a scheduled event', closingEvent.response.status === 201, closingEvent.response.body);

  // --- everything else goes, in one transaction ------------------------------
  const deleted = await call('DELETE', '/api/account', {
    token: owner.accessToken,
    body: { password: PASSWORD, confirm: 'DELETE' },
  });
  assert('closing the account answers 200 once nothing blocks it', deleted.status === 200, deleted.body);
  assert('the answer says the account was deleted', at(deleted.body, 'deleted') === true, deleted.body);
  assert(
    'both groups it owned were archived on the way out',
    at(deleted.body, 'archivedGroups') === 2,
    at(deleted.body, 'archivedGroups'),
  );
  assert(
    'the scheduled event was cancelled before it went',
    at(deleted.body, 'cancelledEvents') === 1,
    at(deleted.body, 'cancelledEvents'),
  );
  assert(
    'the messages it sent went with it',
    at(deleted.body, 'removedMessages') === 1,
    at(deleted.body, 'removedMessages'),
  );

  // --- and nothing of it is left in the database -----------------------------
  assert('the account row is gone', (await accountExists(owner.id)) === false);
  assert('every session row of the account is gone', (await sessionCount(owner.id)) === 0);
  assert('its memberships are gone', (await membershipRows(shared.id, owner.id)).length === 0);
  assert('the event it created is gone', (await eventRowsFor(closingEvent.id)).length === 0);
  assert('the groups it owned are gone with it', (await groupRow(shared.id)) === undefined);

  // --- the session and the number follow the account -------------------------
  const afterDeletion = await call('GET', '/api/profile/me', { token: owner.accessToken });
  assert(
    'the deleted account cannot use its old access token',
    afterDeletion.status === 401 && errorCode(afterDeletion) === 'session_expired',
    afterDeletion.body,
  );
  const signInAgain = await loginUser(owner.email);
  assert('signing in as the deleted account fails', signInAgain.status === 401, signInAgain.body);

  // The address is free again: the same person can start over with it, which is what
  // "your number is released" has to mean for the member.
  const startAgain = await registerUser(owner.email, { displayName: 'Smoke Closing Owner Again' });
  assert('the address can be registered again', startAgain.status === 201, startAgain.body);
  const startAgainId = at<string>(startAgain.body, 'user', 'id') ?? '';
  if (startAgainId) created.push(startAgainId);

  // --- an account with no password cannot be closed by typing one ------------
  const phone = makePhone('closing');
  const otpRequested = await requestOtpFor(phone);
  assert('a code is sent to the phone-only account', otpRequested.status === 202, otpRequested.body);

  const phoneSession = await verifyOtpFor(phone, await readLatestOtp(phone));
  const phoneToken = at<string>(phoneSession.body, 'accessToken') ?? '';
  const phoneId = at<string>(phoneSession.body, 'user', 'id') ?? '';
  if (phoneId) created.push(phoneId);
  assert(
    'the phone-only account is signed in with a token',
    phoneSession.status === 200 && phoneToken.length > 0,
    phoneSession.body,
  );

  const noPasswordSet = await call('DELETE', '/api/account', {
    token: phoneToken,
    body: { password: PASSWORD, confirm: 'DELETE' },
  });
  assert(
    'an account with no password is refused as password_not_set',
    noPasswordSet.status === 409 && errorCode(noPasswordSet) === 'password_not_set',
    noPasswordSet.body,
  );
  assert(
    'and that account is left signed in rather than half-deleted',
    (await call('GET', '/api/profile/me', { token: phoneToken })).status === 200,
  );
}

async function cleanup(): Promise<void> {
  if (created.length === 0) {
    console.log('cleanup: nothing to remove');
    return;
  }

  try {
    await deleteAccounts(created);
    console.log(`cleanup: removed ${created.length} smoke account(s), with their profiles, locations, sessions and tokens`);
  } catch (error) {
    console.log(
      `cleanup: FAILED - ${error instanceof Error ? error.message : String(error)}. Delete the smoke-${RUN_ID}-*@unihood.invalid accounts by hand, or run "npm run smoke -- --clean".`,
    );
  }
}

/**
 * `npm run smoke -- --clean`.
 *
 * The runner deletes the accounts it created, but a run stopped with Ctrl+C - or
 * a machine that loses power mid-run - cannot. This is the escape hatch. It only
 * ever matches the reserved `.invalid` domain and the `smoke-` prefix, so a real
 * member's address cannot be caught by it, and the cascade removes their
 * profiles, locations, sessions and tokens along with them.
 */
async function cleanStaleAccounts(): Promise<void> {
  const [result] = await pool.query<import('mysql2/promise').ResultSetHeader>(
    "DELETE FROM users WHERE email LIKE 'smoke-%@unihood.invalid' OR phone_e164 LIKE '+999%'",
  );

  console.log(`Removed ${result.affectedRows} smoke account(s) left behind by earlier runs.`);
  await pool.end();
}

function report(): void {
  const total = passed + failed;
  console.log(`\n${'-'.repeat(72)}`);
  console.log(`  ${passed}/${total} checks passed${failed === 0 ? ' - the API behaves as specified.' : ` - ${failed} FAILED.`}`);

  if (rateLimited > 0) {
    console.log(`\n  note: ${rateLimited} request(s) came back 429. Raise AUTH_RATE_LIMIT_MAX_REQUESTS`);
    console.log('        (or wait out RATE_LIMIT_WINDOW_MINUTES) and run again - a rate-limited');
    console.log('        check proves nothing either way.');
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--clean')) {
    await cleanStaleAccounts();
    return;
  }

  console.log('Unihood API smoke test');
  console.log(`  base url  ${BASE_URL}`);
  console.log(`  run id    ${RUN_ID}`);
  console.log('  accounts  smoke-<run id>-*@unihood.invalid - created below, deleted on the way out');

  try {
    requireDevelopmentSettings();
    await requireReachable();

    await runHealthChecks();
    await runRegistrationChecks();

    const webMember = await runEmailLinkChecks();
    const apiMember = await runVerifyApiChecks();

    await runSignInGuardChecks();
    await runProfileChecks(webMember);
    await runInterestChecks(webMember);

    await runLocationChecks(webMember);
    await runPersistentLocationChecks();

    const { accountB, accountC, bDistance } = await runDiscoveryChecks(webMember);
    await runNearbyChecks(webMember, accountB, accountC);
    await runPersonDetailChecks(webMember, accountB, bDistance);
    await runConsentChecks(webMember, accountB, accountC);

    await runGroupChecks(webMember);
    await runInterestMatchChecks(webMember);
    await runEventChecks(webMember);

    // Phase 7. Both sections create their own accounts and groups, so nothing above
    // depends on what they left behind (and one of them deliberately revokes a
    // session and archives a group). The budget section spends one fresh member's
    // whole message allowance, which is why it has accounts of its own.
    await runChatChecks();
    await runMessageBudgetChecks();
    await runEventResponseChecks();

    await runSessionChecks(apiMember);
    await runPasswordResetChecks();
    await runDisabledAccountChecks();

    // Section 9. Creates the accounts it closes, so it has to run after every check
    // that expects the members above to be exactly as they were made.
    await runAccountDeletionChecks();

    // Phase 5. Runs last because it attaches a phone number to `webMember` (the
    // documented legacy bridge), and every earlier section should see that account
    // exactly as it was created.
    await runOtpChecks();
    await runOtpGuardChecks(webMember);

    // The credential the app asks for today. Runs after the code checks because it
    // creates a phone-only account of its own to prove what happens to one.
    await runPhonePasswordChecks();
  } catch (error) {
    failed += 1;
    console.log(`\n  ABORTED  ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.log(`  ${error.stack.split('\n').slice(0, 3).join('\n  ')}`);
    }
  } finally {
    console.log('\nCleaning up');
    await cleanup();
    await pool.end();
  }

  report();
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();

/**
 * Events: persistence, discovery, RSVPs, capacity and the access rules.
 *
 * Everything here is asserted through the HTTP surface, except the claims about
 * what is *stored* (a real row, a rounded anchor, an RSVP preserved after access is
 * lost) which are read from MySQL through the same pool the server uses.
 *
 * Declared after `main` on purpose: every function here hoists, and keeping the
 * section at the end of the file keeps the Phase 1-3 narrative above it intact.
 */
async function runEventChecks(accountA: Account): Promise<void> {
  section('Events: creation, discovery and RSVPs');

  // Fresh accounts, because this section must not depend on what the group checks
  // did to account A - and the private-group cases need a member who is *not* in
  // the group as well as one who is.
  const organiser = await createLocatedAccount('event-host', 'Smoke Event Host', 'man');
  const neighbour = await createLocatedAccount('event-guest', 'Smoke Event Guest');
  const outsider = await createLocatedAccount('event-outsider', 'Smoke Event Outsider');
  const other = await createLocatedAccount('event-other', 'Smoke Event Other', 'another');
  const eligible = await createLocatedAccount('event-eligible', 'Smoke Eligible Guest', 'man');

  // Account A anchors the nearby searches below; an earlier section may have
  // withdrawn consent or cleared the row.
  const profileA = await putProfile(accountA, {
    displayName: 'Smoke Member A',
    isDiscoverable: true,
    nearbyDiscoveryEnabled: true,
  });
  assert('the events section can turn nearby discovery on for member A', profileA.status === 200, profileA.body);
  assert('member A stores the fix the event checks measure from', (await putLocation(accountA, DELHI)).status === 200);

  const anonymous = await call('GET', '/api/events');
  assert('the event directory requires a session', anonymous.status === 401, anonymous.body);

  const draft = eventDraft();
  const created = await createEventFor(organiser, draft);
  const standaloneId = created.id;
  assert('POST /api/events answers 201 with the new event', created.response.status === 201, created.response.body);
  assert('the creator is recorded as the creator', at(created.response.body, 'event', 'viewerIsCreator') === true);
  assert('the creator can manage the event', at(created.response.body, 'event', 'viewerCanManage') === true);
  assert(
    'a new event starts scheduled with nobody going',
    at(created.response.body, 'event', 'status') === 'scheduled' &&
      at(created.response.body, 'event', 'goingCount') === 0 &&
      at(created.response.body, 'event', 'viewerRsvpStatus') === null,
  );
  assert('the event reports its geographic anchor', at(created.response.body, 'event', 'hasLocation') === true);
  assert(
    'a standalone event has no group association',
    at(created.response.body, 'event', 'groupId') === null && at(created.response.body, 'event', 'groupName') === null,
  );
  assert(
    'an event response carries no coordinate of any spelling',
    hasNoCoordinates(at<Json>(created.response.body, 'event')),
    at(created.response.body, 'event'),
  );
  assert(
    'timestamps come back as ISO 8601 UTC',
    typeof at<string>(created.response.body, 'event', 'startAt') === 'string' &&
      String(at<string>(created.response.body, 'event', 'startAt')).endsWith('Z'),
    at(created.response.body, 'event', 'startAt'),
  );

  const storedEvents = await eventRowsFor(standaloneId);
  assert(
    'the event is a real row in MySQL, owned by the caller',
    storedEvents.length === 1 && storedEvents[0]?.createdBy === organiser.id && storedEvents[0]?.status === 'scheduled',
    storedEvents,
  );
  assert(
    'the stored start is the same UTC instant that was sent',
    Math.abs(new Date(String(storedEvents[0]?.startAt)).getTime() - new Date(String(draft.startAt)).getTime()) < 2000,
    storedEvents[0]?.startAt,
  );

  const [eventLocationRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT ST_X(location) AS longitude, ST_Y(location) AS latitude FROM event_locations WHERE event_id = ?',
    [standaloneId],
  );
  assert(
    'the anchor is stored longitude-first (as migration 0003 measured it)',
    eventLocationRows[0] !== undefined &&
      Math.abs(Number(eventLocationRows[0].longitude) - DELHI.longitude) < 0.001 &&
      Math.abs(Number(eventLocationRows[0].latitude) - DELHI.latitude) < 0.001,
    eventLocationRows[0],
  );

  const past = await call('POST', '/api/events', {
    token: organiser.accessToken,
    body: eventDraft({ title: 'Smoke Past Event', startAt: instantFromNow(-120), endAt: instantFromNow(60) }),
  });
  assert('an event that starts in the past is refused', past.status === 400 && errorCode(past) === 'validation_error', past.body);

  const backwards = await call('POST', '/api/events', {
    token: organiser.accessToken,
    body: eventDraft({ title: 'Smoke Backwards Event', startAt: instantFromNow(240), endAt: instantFromNow(120) }),
  });
  assert('an event that ends before it starts is refused', backwards.status === 400, backwards.body);

  const shortTitle = await call('POST', '/api/events', { token: organiser.accessToken, body: eventDraft({ title: 'x' }) });
  assert('a too-short title is refused', shortTitle.status === 400, shortTitle.body);

  const noDescription = await call('POST', '/api/events', {
    token: organiser.accessToken,
    body: eventDraft({ description: '   ' }),
  });
  assert('an empty description is refused', noDescription.status === 400, noDescription.body);

  const zeroCapacity = await call('POST', '/api/events', {
    token: organiser.accessToken,
    body: eventDraft({ maxParticipants: 0 }),
  });
  assert('a participant limit of zero is refused', zeroCapacity.status === 400, zeroCapacity.body);

  const badCategory = await call('POST', '/api/events', {
    token: organiser.accessToken,
    body: eventDraft({ category: 'quidditch' }),
  });
  assert('an unknown category is refused', badCategory.status === 400, badCategory.body);

  const badInstant = await call('POST', '/api/events', {
    token: organiser.accessToken,
    body: eventDraft({ startAt: 'next tuesday' }),
  });
  assert('an unreadable timestamp is refused', badInstant.status === 400, badInstant.body);

  const halfLocation = await call('POST', '/api/events', {
    token: organiser.accessToken,
    body: eventDraft({ title: 'Smoke Half Location', latitude: DELHI.latitude, longitude: null }),
  });
  assert('a half-supplied location is refused', halfLocation.status === 400, halfLocation.body);

  const unknownGroup = await call('POST', '/api/events', {
    token: organiser.accessToken,
    body: eventDraft({ title: 'Smoke Unknown Group', groupId: '00000000-0000-4000-8000-000000000000' }),
  });
  assert(
    'an unknown group is refused without leaking any SQL',
    unknownGroup.status === 400 && !/select |insert |from events|sql/i.test(JSON.stringify(unknownGroup.body)),
    unknownGroup.body,
  );

  const spoofed = await call('POST', '/api/events', {
    token: neighbour.accessToken,
    body: { ...eventDraft({ title: 'Smoke Spoofed Creator' }), createdBy: organiser.id, creatorId: organiser.id },
  });
  assert(
    'a client-supplied creator id cannot change who created the event',
    spoofed.status === 201 && String(at(spoofed.body, 'event', 'creatorId')) === neighbour.id,
    at(spoofed.body, 'event', 'creatorId'),
  );

  // ---- nearby discovery -----------------------------------------------------

  const nearby = await call('GET', '/api/events/nearby?radius=5000&limit=50', { token: neighbour.accessToken });
  assert('GET /api/events/nearby answers 200', nearby.status === 200, nearby.body);

  const selfNearby = eventById(nearby.body, standaloneId);
  assert('a standalone event inside 5 km is nearby', selfNearby !== undefined);
  assert(
    'the nearby distance is in metres and rounded to 50 m',
    eventDistance(selfNearby) !== null && (eventDistance(selfNearby) ?? -1) % 50 === 0,
    eventDistance(selfNearby),
  );
  assert('a nearby event exposes no raw coordinates', hasNoCoordinates(selfNearby), selfNearby);

  const seenByAnyone = await call('GET', `/api/events/${standaloneId}`, { token: other.accessToken });
  assert('any authenticated member can open a standalone event', seenByAnyone.status === 200, seenByAnyone.body);

  const far = await createEventFor(
    organiser,
    eventDraft({ title: 'Smoke Far Event', latitude: MUMBAI.latitude, longitude: MUMBAI.longitude }),
  );
  const nearbyTenKm = await call('GET', '/api/events/nearby?radius=10000&limit=50', { token: neighbour.accessToken });
  assert('an event outside the radius is not a nearby result', eventById(nearbyTenKm.body, far.id) === undefined);
  assert(
    'the non-geographic listing is not distance limited',
    eventById((await call('GET', '/api/events?limit=50', { token: neighbour.accessToken })).body, far.id) !== undefined,
  );

  const unlocated = await createEventFor(
    organiser,
    eventDraft({ title: 'Smoke Unlocated Event', latitude: null, longitude: null, locationLabel: 'Somewhere on campus' }),
  );
  assert(
    'an unlocated event is never presented as confirmed nearby',
    eventById(
      (await call('GET', '/api/events/nearby?radius=5000&limit=50', { token: neighbour.accessToken })).body,
      unlocated.id,
    ) === undefined,
  );
  assert(
    'an unlocated event is still listed without geography',
    eventById((await call('GET', '/api/events?limit=50', { token: neighbour.accessToken })).body, unlocated.id) !== undefined,
  );

  const noFix = await createVerifiedAccount('event-nofix', 'Smoke No Fix');
  await putProfile(noFix, { displayName: 'Smoke No Fix', isDiscoverable: true, nearbyDiscoveryEnabled: true });
  const noLocation = await call('GET', '/api/events/nearby', { token: noFix.accessToken });
  assert(
    'nearby without a stored fix is a location_required error',
    noLocation.status === 409 && errorCode(noLocation) === 'location_required',
    noLocation.body,
  );
  assert(
    'a member with no location can still browse events',
    (await call('GET', '/api/events?limit=5', { token: noFix.accessToken })).status === 200,
  );
  assert(
    "a member with no location can still read their groups' events",
    (await call('GET', '/api/events/mine?limit=5', { token: noFix.accessToken })).status === 200,
  );

  // ---- RSVPs ----------------------------------------------------------------

  const rsvp = await call('POST', `/api/events/${standaloneId}/rsvp`, { token: neighbour.accessToken });
  assert('RSVP answers 200 with the refreshed event', rsvp.status === 200, rsvp.body);
  assert(
    'the RSVP is reflected in the response',
    at(rsvp.body, 'event', 'viewerIsGoing') === true && at(rsvp.body, 'event', 'goingCount') === 1,
    at(rsvp.body, 'event', 'goingCount'),
  );
  const rsvpRow = (await rsvpRows(standaloneId, neighbour.id))[0];
  assert(
    'the RSVP is exactly one real row in MySQL',
    (await rsvpRows(standaloneId, neighbour.id)).length === 1 && rsvpRow?.status === 'going',
    rsvpRow,
  );

  const again = await call('POST', `/api/events/${standaloneId}/rsvp`, { token: neighbour.accessToken });
  assert(
    'a repeated RSVP does not inflate the count or duplicate the row',
    at(again.body, 'event', 'goingCount') === 1 && (await rsvpRows(standaloneId, neighbour.id)).length === 1,
    at(again.body, 'event', 'goingCount'),
  );

  const attendees = await call('GET', `/api/events/${standaloneId}/attendees`, { token: outsider.accessToken });
  assert('the guest list of a public event is readable', attendees.status === 200, attendees.body);
  assert(
    'the guest list names the member who said yes',
    (at<Json[]>(attendees.body, 'page', 'attendees') ?? []).some(
      (entry) => entry.userId === neighbour.id && entry.isYou === false,
    ),
  );
  assert(
    'the guest list carries no email, coordinate or eligibility',
    !/email|latitude|longitude|eligibility/i.test(JSON.stringify(attendees.body)),
    attendees.body,
  );

  const going = await call('GET', '/api/events/going?limit=50', { token: neighbour.accessToken });
  assert('Going returns the event the member said yes to', eventById(going.body, standaloneId) !== undefined);
  assert(
    "Going does not contain another member's RSVPs",
    eventById((await call('GET', '/api/events/going?limit=50', { token: outsider.accessToken })).body, standaloneId) ===
      undefined,
  );

  const cancelRsvpResponse = await call('DELETE', `/api/events/${standaloneId}/rsvp`, { token: neighbour.accessToken });
  assert(
    'cancelling an RSVP reports the member as not going',
    cancelRsvpResponse.status === 200 &&
      at(cancelRsvpResponse.body, 'event', 'viewerIsGoing') === false &&
      at(cancelRsvpResponse.body, 'event', 'goingCount') === 0,
    cancelRsvpResponse.body,
  );
  const cancelledRow = (await rsvpRows(standaloneId, neighbour.id))[0];
  assert(
    'the cancelled RSVP row is kept, not deleted',
    cancelledRow !== undefined && cancelledRow.status === 'cancelled' && cancelledRow.cancelledAt !== null,
    cancelledRow,
  );

  const cancelAgain = await call('DELETE', `/api/events/${standaloneId}/rsvp`, { token: neighbour.accessToken });
  assert(
    'cancelling twice is a safe, consistent no-op',
    cancelAgain.status === 200 && at(cancelAgain.body, 'event', 'goingCount') === 0,
    cancelAgain.body,
  );

  const reRsvp = await call('POST', `/api/events/${standaloneId}/rsvp`, { token: neighbour.accessToken });
  assert(
    're-joining after a cancellation reuses the same row',
    reRsvp.status === 200 &&
      at(reRsvp.body, 'event', 'goingCount') === 1 &&
      (await rsvpRows(standaloneId, neighbour.id)).length === 1,
    reRsvp.body,
  );

  // ---- capacity, including under concurrency --------------------------------

  const onePlace = await createEventFor(organiser, eventDraft({ title: 'Smoke One Place', maxParticipants: 1 }));
  const firstPlace = await call('POST', `/api/events/${onePlace.id}/rsvp`, { token: neighbour.accessToken });
  assert(
    'the first RSVP takes the only place and the event reports itself full',
    firstPlace.status === 200 &&
      at(firstPlace.body, 'event', 'goingCount') === 1 &&
      at(firstPlace.body, 'event', 'isFull') === true &&
      at(firstPlace.body, 'event', 'spotsLeft') === 0,
    firstPlace.body,
  );
  const noPlace = await call('POST', `/api/events/${onePlace.id}/rsvp`, { token: outsider.accessToken });
  assert('a full event refuses another RSVP with event_full', noPlace.status === 409 && errorCode(noPlace) === 'event_full', noPlace.body);
  assert('the refused RSVP created no row', (await rsvpRows(onePlace.id, outsider.id)).length === 0);
  assert(
    'the full event still counts exactly one place taken',
    at<Json>((await call('GET', `/api/events/${onePlace.id}`, { token: outsider.accessToken })).body, 'event')?.goingCount === 1,
  );

  const twoPlaces = await createEventFor(organiser, eventDraft({ title: 'Smoke Two Places', maxParticipants: 2 }));
  const racers = await Promise.all([
    call('POST', `/api/events/${twoPlaces.id}/rsvp`, { token: neighbour.accessToken }),
    call('POST', `/api/events/${twoPlaces.id}/rsvp`, { token: outsider.accessToken }),
    call('POST', `/api/events/${twoPlaces.id}/rsvp`, { token: other.accessToken }),
  ]);
  const accepted = racers.filter((response) => response.status === 200).length;
  const full = racers.filter((response) => errorCode(response) === 'event_full').length;
  const [goingCountRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    "SELECT COUNT(*) AS going FROM event_rsvps WHERE event_id = ? AND status = 'going'",
    [twoPlaces.id],
  );
  assert(
    'three simultaneous RSVPs for two places accept exactly two',
    accepted === 2 && full === 1,
    { accepted, full },
  );
  assert(
    'the database agrees the capacity was never exceeded',
    Number(goingCountRows[0]?.going ?? -1) === 2,
    goingCountRows[0],
  );

  // ---- a private group's events ---------------------------------------------

  const privateGroup = await createGroupFor(
    organiser,
    publicGroupDraft({ name: 'Smoke Private Event Group', visibility: 'private' }),
  );
  const privateEvent = await createEventFor(
    organiser,
    eventDraft({ title: 'Smoke Private Group Event', groupId: privateGroup.id }),
  );

  assert(
    "a group event reports its group and the group's visibility",
    at(privateEvent.response.body, 'event', 'groupId') === privateGroup.id &&
      at(privateEvent.response.body, 'event', 'groupVisibility') === 'private' &&
      at(privateEvent.response.body, 'event', 'groupName') === 'Smoke Private Event Group',
    at(privateEvent.response.body, 'event', 'groupName'),
  );
  assert(
    'the organiser can read their own private group event',
    (await call('GET', `/api/events/${privateEvent.id}`, { token: organiser.accessToken })).status === 200,
  );
  assert(
    'the owner can manage an event attached to their group',
    at(privateEvent.response.body, 'event', 'viewerCanManage') === true,
  );

  const guessed = await call('GET', `/api/events/${privateEvent.id}`, { token: outsider.accessToken });
  assert(
    'a non-member cannot fetch a private group event by guessing its id',
    guessed.status === 404 && errorCode(guessed) === 'not_found',
    guessed.body,
  );
  assert(
    'a private group event is not discovered nearby',
    eventById(
      (await call('GET', '/api/events/nearby?radius=5000&limit=50', { token: outsider.accessToken })).body,
      privateEvent.id,
    ) === undefined,
  );
  assert(
    'a private group event is not in the generic listing',
    eventById((await call('GET', '/api/events?limit=50', { token: outsider.accessToken })).body, privateEvent.id) ===
      undefined,
  );
  assert(
    "a private group event is not in a non-member's My groups",
    eventById((await call('GET', '/api/events/mine?limit=50', { token: outsider.accessToken })).body, privateEvent.id) ===
      undefined,
  );
  assert(
    "the group filter does not reveal a private group's events",
    eventById(
      (await call('GET', `/api/events?groupId=${privateGroup.id}&limit=50`, { token: outsider.accessToken })).body,
      privateEvent.id,
    ) === undefined,
  );
  assert(
    'My groups contains the group event for the owner',
    eventById((await call('GET', '/api/events/mine?limit=50', { token: organiser.accessToken })).body, privateEvent.id) !==
      undefined,
  );
  assert(
    'a non-member cannot read a private guest list',
    (await call('GET', `/api/events/${privateEvent.id}/attendees`, { token: outsider.accessToken })).status === 404,
  );
  const rsvpBlocked = await call('POST', `/api/events/${privateEvent.id}/rsvp`, { token: outsider.accessToken });
  assert('a non-member cannot RSVP to a private event', rsvpBlocked.status === 404, rsvpBlocked.body);

  const requested = await call('POST', `/api/groups/${privateGroup.id}/join`, { token: outsider.accessToken });
  assert(
    'a private-group join request is pending',
    at(requested.body, 'group', 'viewerMembership', 'status') === 'pending',
    at(requested.body, 'group', 'viewerMembership'),
  );
  assert(
    'a pending membership still grants nothing on the private event',
    (await call('GET', `/api/events/${privateEvent.id}`, { token: outsider.accessToken })).status === 404,
  );

  const approved = await call('POST', `/api/groups/${privateGroup.id}/join-requests/${outsider.id}/approve`, {
    token: organiser.accessToken,
  });
  assert('the owner approves the request', approved.status === 200, approved.body);
  assert(
    'an active member can read the private group event',
    (await call('GET', `/api/events/${privateEvent.id}`, { token: outsider.accessToken })).status === 200,
  );
  assert(
    "the member's My groups now contains the private event",
    eventById((await call('GET', '/api/events/mine?limit=50', { token: outsider.accessToken })).body, privateEvent.id) !==
      undefined,
  );
  const memberRsvp = await call('POST', `/api/events/${privateEvent.id}/rsvp`, { token: outsider.accessToken });
  assert(
    'the member can RSVP to the private event',
    memberRsvp.status === 200 && at(memberRsvp.body, 'event', 'goingCount') === 1,
    memberRsvp.body,
  );
  assert(
    'the member Going list contains the private event',
    eventById((await call('GET', '/api/events/going?limit=50', { token: outsider.accessToken })).body, privateEvent.id) !==
      undefined,
  );
  assert(
    'the member can read the private guest list',
    (await call('GET', `/api/events/${privateEvent.id}/attendees`, { token: outsider.accessToken })).status === 200,
  );

  const removed = await call('DELETE', `/api/groups/${privateGroup.id}/members/${outsider.id}`, {
    token: organiser.accessToken,
  });
  assert('the owner removes the member', removed.status === 204, removed.body);
  assert(
    'a removed member cannot read the private event any more',
    (await call('GET', `/api/events/${privateEvent.id}`, { token: outsider.accessToken })).status === 404,
  );
  assert(
    'the historical RSVP row survives the removal',
    (await rsvpRows(privateEvent.id, outsider.id))[0]?.status === 'going',
    await rsvpRows(privateEvent.id, outsider.id),
  );
  assert(
    "the removed member's Going list no longer contains it",
    eventById((await call('GET', '/api/events/going?limit=50', { token: outsider.accessToken })).body, privateEvent.id) ===
      undefined,
  );
  assert(
    'the removed member cannot cancel an RSVP they can no longer read',
    (await call('DELETE', `/api/events/${privateEvent.id}/rsvp`, { token: outsider.accessToken })).status === 404,
  );
  assert(
    'the organiser still sees the retained attendance count',
    at<Json>((await call('GET', `/api/events/${privateEvent.id}`, { token: organiser.accessToken })).body, 'event')
      ?.goingCount === 1,
  );

  const hostileAttach = await call('POST', '/api/events', {
    token: outsider.accessToken,
    body: eventDraft({ title: 'Smoke Hostile Attach', groupId: privateGroup.id }),
  });
  assert('a non-member cannot attach an event to a group', hostileAttach.status === 403, hostileAttach.body);

  // ---- audience restrictions ------------------------------------------------

  const restrictedGroup = await createGroupFor(
    organiser,
    publicGroupDraft({ name: 'Smoke Men Only Events', audience: 'men_only' }),
  );
  const restrictedEvent = await createEventFor(
    organiser,
    eventDraft({ title: 'Smoke Men Only Event', groupId: restrictedGroup.id }),
  );

  const ineligibleRead = await call('GET', `/api/events/${restrictedEvent.id}`, { token: other.accessToken });
  assert(
    'an ineligible member cannot read a restricted group event',
    ineligibleRead.status === 404,
    ineligibleRead.body,
  );
  assert(
    'a restricted group event is absent from an ineligible nearby search',
    eventById(
      (await call('GET', '/api/events/nearby?radius=5000&limit=50', { token: other.accessToken })).body,
      restrictedEvent.id,
    ) === undefined,
  );
  const ineligibleRsvp = await call('POST', `/api/events/${restrictedEvent.id}/rsvp`, { token: other.accessToken });
  assert(
    'an ineligible RSVP is refused with audience_not_eligible',
    ineligibleRsvp.status === 403 && errorCode(ineligibleRsvp) === 'audience_not_eligible',
    ineligibleRsvp.body,
  );

  assert(
    'an eligible non-member can read a public restricted group event',
    (await call('GET', `/api/events/${restrictedEvent.id}`, { token: eligible.accessToken })).status === 200,
  );
  const eligibleRsvp = await call('POST', `/api/events/${restrictedEvent.id}/rsvp`, { token: eligible.accessToken });
  assert(
    'an eligible non-member can RSVP to a public restricted group event',
    eligibleRsvp.status === 200 && at(eligibleRsvp.body, 'event', 'goingCount') === 1,
    eligibleRsvp.body,
  );
  assert(
    "a group's own event list answers 200 and contains its event",
    eventById(
      (await call('GET', `/api/events?groupId=${restrictedGroup.id}&limit=50`, { token: eligible.accessToken })).body,
      restrictedEvent.id,
    ) !== undefined,
  );

  // ---- permissions, editing and cancellation ---------------------------------

  const hostilePatch = await call('PATCH', `/api/events/${standaloneId}`, {
    token: outsider.accessToken,
    body: { title: 'Hijacked' },
  });
  assert(
    'a member who did not create an event cannot edit it',
    hostilePatch.status === 403 && errorCode(hostilePatch) === 'forbidden',
    hostilePatch.body,
  );
  assert(
    'a member who did not create an event cannot cancel it',
    (await call('DELETE', `/api/events/${standaloneId}`, { token: outsider.accessToken })).status === 403,
  );

  const patched = await call('PATCH', `/api/events/${standaloneId}`, {
    token: organiser.accessToken,
    body: { title: 'Smoke Plaza Meetup (edited)', category: 'coding', maxParticipants: 12 },
  });
  assert(
    'the creator can edit their event',
    patched.status === 200 &&
      at(patched.body, 'event', 'title') === 'Smoke Plaza Meetup (edited)' &&
      at(patched.body, 'event', 'category') === 'coding' &&
      at(patched.body, 'event', 'maxParticipants') === 12,
    patched.body,
  );
  assert(
    'the edit is persisted',
    (await eventRowsFor(standaloneId))[0]?.title === 'Smoke Plaza Meetup (edited)' &&
      Number((await eventRowsFor(standaloneId))[0]?.maxParticipants) === 12,
    await eventRowsFor(standaloneId),
  );
  const lazyRename = await call('PATCH', `/api/events/${standaloneId}`, {
    token: organiser.accessToken,
    body: { description: 'The description changed without touching the times.' },
  });
  assert('a field-level patch leaves the other fields alone', lazyRename.status === 200, lazyRename.body);

  const moved = await call('PATCH', `/api/events/${standaloneId}`, {
    token: organiser.accessToken,
    body: { latitude: DELHI_EAST.latitude, longitude: DELHI_EAST.longitude },
  });
  assert(
    'the creator can move the anchor to a new point',
    moved.status === 200 && at(moved.body, 'event', 'hasLocation') === true,
    moved.body,
  );
  const [movedRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT latitude, longitude FROM event_locations WHERE event_id = ?',
    [standaloneId],
  );
  assert(
    'the stored anchor moved with it',
    movedRows[0] !== undefined && Math.abs(Number(movedRows[0].longitude) - DELHI_EAST.longitude) < 0.001,
    movedRows[0],
  );

  const cleared = await call('PATCH', `/api/events/${standaloneId}`, {
    token: organiser.accessToken,
    body: { removeLocation: true },
  });
  assert(
    'the creator can remove the anchor',
    cleared.status === 200 && at(cleared.body, 'event', 'hasLocation') === false,
    cleared.body,
  );
  const [clearedRows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT COUNT(*) AS rows_left FROM event_locations WHERE event_id = ?',
    [standaloneId],
  );
  assert('removing the anchor deletes the row rather than blanking it', Number(clearedRows[0]?.rows_left ?? -1) === 0);

  const retarget = await call('PATCH', `/api/events/${standaloneId}`, {
    token: organiser.accessToken,
    body: { groupId: restrictedGroup.id },
  });
  assert(
    'a patch cannot re-target an event at another group',
    retarget.status === 200 && at(retarget.body, 'event', 'groupId') === null,
    at(retarget.body, 'event', 'groupId'),
  );

  const capacityBelowAttendance = await call('PATCH', `/api/events/${standaloneId}`, {
    token: organiser.accessToken,
    body: { maxParticipants: 0 },
  });
  assert('an invalid capacity is refused on an edit', capacityBelowAttendance.status === 400, capacityBelowAttendance.body);

  // ---- cancellation ---------------------------------------------------------

  const cancelled = await call('DELETE', `/api/events/${standaloneId}`, { token: organiser.accessToken });
  assert(
    'cancelling returns the event marked cancelled',
    cancelled.status === 200 &&
      at(cancelled.body, 'event', 'status') === 'cancelled' &&
      typeof at<string>(cancelled.body, 'event', 'cancelledAt') === 'string',
    at(cancelled.body, 'event', 'status'),
  );
  assert(
    'cancelling keeps the attendance history',
    (await rsvpRows(standaloneId, neighbour.id))[0]?.status === 'going' &&
      (await eventRowsFor(standaloneId))[0]?.status === 'cancelled',
    await rsvpRows(standaloneId, neighbour.id),
  );
  assert(
    'a cancelled event leaves Nearby',
    eventById(
      (await call('GET', '/api/events/nearby?radius=5000&limit=50', { token: neighbour.accessToken })).body,
      standaloneId,
    ) === undefined,
  );
  assert(
    'a cancelled event leaves the generic listing',
    eventById((await call('GET', '/api/events?limit=50', { token: neighbour.accessToken })).body, standaloneId) ===
      undefined,
  );
  assert(
    "a cancelled event leaves a participant's Going list",
    eventById((await call('GET', '/api/events/going?limit=50', { token: neighbour.accessToken })).body, standaloneId) ===
      undefined,
  );
  assert(
    'the detail page still says it was cancelled',
    at<Json>((await call('GET', `/api/events/${standaloneId}`, { token: neighbour.accessToken })).body, 'event')?.status ===
      'cancelled',
  );
  const rsvpCancelledEvent = await call('POST', `/api/events/${standaloneId}/rsvp`, { token: eligible.accessToken });
  assert(
    'a cancelled event refuses new RSVPs',
    rsvpCancelledEvent.status === 409 && errorCode(rsvpCancelledEvent) === 'event_cancelled',
    rsvpCancelledEvent.body,
  );
  const editCancelledEvent = await call('PATCH', `/api/events/${standaloneId}`, {
    token: organiser.accessToken,
    body: { title: 'After the cancel' },
  });
  assert(
    'a cancelled event cannot be edited back to life',
    editCancelledEvent.status === 409 && errorCode(editCancelledEvent) === 'event_cancelled',
    editCancelledEvent.body,
  );
  const cancelTwice = await call('DELETE', `/api/events/${standaloneId}`, { token: organiser.accessToken });
  assert(
    'cancelling twice is a safe no-op',
    cancelTwice.status === 200 && at(cancelTwice.body, 'event', 'status') === 'cancelled',
    cancelTwice.body,
  );

  // ---- an already-finished event --------------------------------------------

  const ended = await createEventFor(organiser, eventDraft({ title: 'Smoke Already Ended' }));
  await pool.query(
    'UPDATE events SET start_at = DATE_SUB(NOW(3), INTERVAL 3 HOUR), end_at = DATE_SUB(NOW(3), INTERVAL 2 HOUR) WHERE id = ?',
    [ended.id],
  );
  assert(
    'an ended event leaves Nearby',
    eventById(
      (await call('GET', '/api/events/nearby?radius=5000&limit=50', { token: neighbour.accessToken })).body,
      ended.id,
    ) === undefined,
  );
  assert(
    'an ended event leaves the generic listing',
    eventById((await call('GET', '/api/events?limit=50', { token: neighbour.accessToken })).body, ended.id) === undefined,
  );
  const rsvpEndedEvent = await call('POST', `/api/events/${ended.id}/rsvp`, { token: neighbour.accessToken });
  assert(
    'an ended event refuses new RSVPs',
    rsvpEndedEvent.status === 409 && errorCode(rsvpEndedEvent) === 'event_ended',
    rsvpEndedEvent.body,
  );

  // ---- an archived group ----------------------------------------------------

  const archivedGroup = await createGroupFor(organiser, publicGroupDraft({ name: 'Smoke Archived Events' }));
  const archivedEvent = await createEventFor(
    organiser,
    eventDraft({ title: 'Smoke Archived Group Event', groupId: archivedGroup.id }),
  );
  assert(
    'a group event is discoverable while the group is live',
    (await call('GET', `/api/events/${archivedEvent.id}`, { token: neighbour.accessToken })).status === 200,
  );
  assert(
    'the owner archives the group',
    (await call('DELETE', `/api/groups/${archivedGroup.id}`, { token: organiser.accessToken })).status === 204,
  );
  assert(
    'an archived group event leaves the generic listing',
    eventById((await call('GET', '/api/events?limit=50', { token: neighbour.accessToken })).body, archivedEvent.id) ===
      undefined,
  );
  assert(
    'an archived group event leaves Nearby',
    eventById(
      (await call('GET', '/api/events/nearby?radius=5000&limit=50', { token: neighbour.accessToken })).body,
      archivedEvent.id,
    ) === undefined,
  );
  const rsvpArchivedOutsider = await call('POST', `/api/events/${archivedEvent.id}/rsvp`, {
    token: neighbour.accessToken,
  });
  assert(
    'an archived group event is a 404 for a non-member, not a confirmation it exists',
    rsvpArchivedOutsider.status === 404 && errorCode(rsvpArchivedOutsider) === 'not_found',
    rsvpArchivedOutsider.body,
  );
  const rsvpArchivedMember = await call('POST', `/api/events/${archivedEvent.id}/rsvp`, {
    token: organiser.accessToken,
  });
  assert(
    'a member of an archived group is told the event is closed',
    rsvpArchivedMember.status === 409 && errorCode(rsvpArchivedMember) === 'group_archived',
    rsvpArchivedMember.body,
  );
  assert(
    'the archived group event is still readable by its owner',
    (await call('GET', `/api/events/${archivedEvent.id}`, { token: organiser.accessToken })).status === 200,
  );

  // ---- paging, and the last unauthenticated checks ---------------------------

  const firstPage = await call('GET', '/api/events?limit=2&offset=0', { token: organiser.accessToken });
  const firstPageEvents = at<Json[]>(firstPage.body, 'page', 'events') ?? [];
  assert(
    'a small page is exactly the requested size and reports more',
    firstPageEvents.length === 2 && at(firstPage.body, 'page', 'hasMore') === true,
    { length: firstPageEvents.length, hasMore: at(firstPage.body, 'page', 'hasMore') },
  );
  const nextOffset = at<number>(firstPage.body, 'page', 'nextOffset') ?? 0;
  const secondPage = await call('GET', `/api/events?limit=2&offset=${nextOffset}`, { token: organiser.accessToken });
  const secondPageEvents = at<Json[]>(secondPage.body, 'page', 'events') ?? [];
  assert(
    'the second page does not repeat a row from the first',
    secondPageEvents.length > 0 && !secondPageEvents.some((event) => event.id === firstPageEvents[0]?.id),
    secondPageEvents.map((event) => event.id),
  );
  assert(
    'an over-large page size is refused by validation',
    (await call('GET', '/api/events?limit=9999', { token: organiser.accessToken })).status === 400,
  );
  assert(
    'an absurd radius is refused by validation',
    (await call('GET', '/api/events/nearby?radius=9999999', { token: organiser.accessToken })).status === 400,
  );
  assert('an anonymous create is refused', (await call('POST', '/api/events', { body: eventDraft() })).status === 401);
  assert(
    'an anonymous RSVP is refused',
    (await call('POST', `/api/events/${restrictedEvent.id}/rsvp`)).status === 401,
  );
  assert('an anonymous cancel is refused', (await call('DELETE', `/api/events/${restrictedEvent.id}`)).status === 401);
  assert(
    'an anonymous guest list is refused',
    (await call('GET', `/api/events/${restrictedEvent.id}/attendees`)).status === 401,
  );
  assert(
    'an unknown event id is a clean 404',
    (await call('GET', '/api/events/00000000-0000-4000-8000-000000000000', { token: organiser.accessToken })).status ===
      404,
  );
  assert(
    'a malformed event id is a validation error',
    (await call('GET', '/api/events/not-a-uuid', { token: organiser.accessToken })).status === 400,
  );
}

// -----------------------------------------------------------------------------
// Group chat (Phase 7)
// -----------------------------------------------------------------------------

/** The stored rows of one group's chat, read straight from MySQL. */
async function chatRows(groupId: string): Promise<Json[]> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    `SELECT id, group_id, sender_id, body, client_message_id, created_at
       FROM group_messages
      WHERE group_id = ?
      ORDER BY created_at ASC, id ASC`,
    [groupId],
  );

  return rows.map((row) => ({
    id: String(row.id),
    groupId: String(row.group_id),
    senderId: String(row.sender_id),
    body: String(row.body),
    clientMessageId: row.client_message_id === null ? null : String(row.client_message_id),
    createdAt: row.created_at,
  }));
}

/** How many members the database says are going to an event. */
async function goingCountFor(eventId: string): Promise<number> {
  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    "SELECT COUNT(*) AS going FROM event_rsvps WHERE event_id = ? AND status = 'going'",
    [eventId],
  );

  return Number(rows[0]?.going ?? 0);
}

/** Creates a group and joins the given accounts to it. */
async function chatRoomFor(owner: Account, members: readonly Account[], overrides: Json = {}): Promise<string> {
  const group = await createGroupFor(owner, publicGroupDraft({ name: 'Smoke Chat Room', ...overrides }));

  for (const account of members) {
    const joined = await call('POST', `/api/groups/${group.id}/join`, { token: account.accessToken });
    if (joined.status !== 200) {
      throw new Error(`Smoke setup failed to join the chat group: ${joined.status} ${JSON.stringify(joined.body)}`);
    }
  }

  return group.id;
}

/** POSTs one message and returns the response plus the id the server assigned. */
async function postChatMessage(
  account: Account,
  groupId: string,
  body: string,
  clientMessageId?: string,
): Promise<{ id: string; response: ApiResponse }> {
  const response = await call('POST', `/api/groups/${groupId}/messages`, {
    token: account.accessToken,
    body: clientMessageId === undefined ? { body } : { body, clientMessageId },
  });

  return { id: String(at<string>(response.body, 'message', 'id') ?? ''), response };
}

/** The `remaining` value out of a draft-7 `RateLimit` header, or null when absent. */
function remainingFrom(response: ApiResponse): number | null {
  const match = /remaining=(\d+)/.exec(response.headers.get('ratelimit') ?? '');
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** `error.details.retryAfterSeconds` out of a refusal, or null when it is absent. */
function retryAfterFrom(response: ApiResponse): number | null {
  const value = at<{ retryAfterSeconds?: unknown }>(response.body, 'error', 'details')?.retryAfterSeconds;
  return typeof value === 'number' ? value : null;
}

/** A UUID-shaped id, for the idempotency checks. Not a secret; just needs to be unique. */
function smokeUuid(): string {
  const hex = (length: number): string =>
    Array.from({ length }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)] ?? '0').join('');

  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/**
 * Opens a real Socket.IO connection to the API under test.
 *
 * `reconnection: false` on purpose: every check here is about whether *this*
 * connection was accepted, and an auto-retry would turn a refusal into a wait.
 * A failed handshake returns the server's own error payload, which is what makes
 * "the token was refused" provable rather than inferred from a timeout.
 */
async function connectSocket(token: string): Promise<{ socket: Socket | null; error: Json | null }> {
  const socket = io(BASE_URL, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    reconnection: false,
    timeout: 6_000,
    auth: { token },
  });

  const outcome = await new Promise<{ ok: boolean; error: Json | null }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: { code: 'connect_timeout' } }), 7_000);

    socket.once('connect', () => {
      clearTimeout(timer);
      resolve({ ok: true, error: null });
    });

    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      const data = (error as { data?: Json }).data;
      resolve({ ok: false, error: data ?? { code: 'connect_error', message: error.message } });
    });
  });

  if (!outcome.ok) {
    socket.removeAllListeners();
    socket.disconnect();
    return { socket: null, error: outcome.error };
  }

  return { socket, error: null };
}

function closeSocket(socket: Socket | null): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
}

/** Emits a client -> server event and waits for its acknowledgement. */
function emitAck(socket: Socket, event: string, payload: Json, timeoutMs = 6_000): Promise<Json> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, code: 'ack_timeout' }), timeoutMs);
    socket.emit(event, payload, (response: Json) => {
      clearTimeout(timer);
      resolve(response ?? {});
    });
  });
}

/** Waits for one server -> client event. `null` means it never arrived. */
function waitForSocketEvent(socket: Socket, event: string, timeoutMs = 6_000): Promise<Json | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handler = (payload: Json): void => {
      if (timer) clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload ?? null);
    };

    timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, timeoutMs);

    socket.on(event, handler);
  });
}

/**
 * Sends `count` messages over one socket, `chunk` at a time, and returns how many
 * were acknowledged as committed.
 *
 * The chunking is what makes this a *concurrency* check rather than a loop: every
 * request in a chunk is in flight at once, and the chunk is deliberately larger than
 * the database connection pool, so the submissions really do overlap inside the
 * server. A counter with a read-modify-write gap would let more than the budget
 * through here - and the bodies are numbered, so "which of these landed" is
 * answerable from the table afterwards.
 */
async function floodSocket(
  socket: Socket,
  groupId: string,
  count: number,
  label: string,
  chunk: number,
): Promise<number> {
  let sent = 0;
  let accepted = 0;

  while (sent < count) {
    const size = Math.min(chunk, count - sent);
    const replies = await Promise.all(
      Array.from({ length: size }, (_unused, index) =>
        emitAck(socket, 'message:send', {
          groupId,
          body: `${label} ${sent + index + 1}`,
          clientMessageId: smokeUuid(),
        }),
      ),
    );

    sent += size;
    accepted += replies.filter((reply) => reply.ok === true).length;
  }

  return accepted;
}

/**
 * Phase 7: group chat.
 *
 * Everything is asserted through the real surfaces - the HTTP endpoints and a real
 * Socket.IO connection - except the claims about what is *stored* (a row exists, the
 * sender is the session's member, a removed member's messages survive), which are
 * read from MySQL through the same pool the server uses.
 */
async function runChatChecks(): Promise<void> {
  section('Group chat: persistence, membership and delivery');

  const owner = await createVerifiedAccount('chat-owner', 'Smoke Chat Owner');
  const member = await createVerifiedAccount('chat-member', 'Smoke Chat Member');
  const other = await createVerifiedAccount('chat-other', 'Smoke Chat Other');
  const outsider = await createVerifiedAccount('chat-outsider', 'Smoke Chat Outsider');
  const applicant = await createVerifiedAccount('chat-applicant', 'Smoke Chat Applicant');

  const room = await chatRoomFor(owner, [member, other]);
  const privateRoom = await createGroupFor(
    owner,
    publicGroupDraft({ name: 'Smoke Private Chat', visibility: 'private' }),
  );

  // A private group leaves the stranger in the pending queue, which is the state the
  // checks below prove grants nothing.
  const requested = await call('POST', `/api/groups/${privateRoom.id}/join`, { token: applicant.accessToken });
  assert(
    'a private group leaves a request pending rather than joining it',
    requested.status === 200 && at(requested.body, 'group', 'viewerMembership', 'status') === 'pending',
    requested.body,
  );

  // ---- authorization ---------------------------------------------------------
  assert('chat history requires a session', (await call('GET', `/api/groups/${room}/messages`)).status === 401);

  const outsiderRead = await call('GET', `/api/groups/${room}/messages`, { token: outsider.accessToken });
  assert(
    "a non-member cannot read a public group's chat",
    outsiderRead.status === 403 && errorCode(outsiderRead) === 'forbidden',
    outsiderRead.body,
  );

  const outsiderWrite = await call('POST', `/api/groups/${room}/messages`, {
    token: outsider.accessToken,
    body: { body: 'Let me in.' },
  });
  assert('a non-member cannot post to a public group', outsiderWrite.status === 403, outsiderWrite.body);

  const pendingRead = await call('GET', `/api/groups/${privateRoom.id}/messages`, { token: applicant.accessToken });
  assert(
    "a pending request grants no access to a private group's chat",
    pendingRead.status === 403 && errorCode(pendingRead) === 'forbidden',
    pendingRead.body,
  );

  assert(
    'an unknown group id is a clean 404',
    (
      await call('GET', '/api/groups/00000000-0000-4000-8000-000000000000/messages', {
        token: member.accessToken,
      })
    ).status === 404,
  );

  // ---- persistence -----------------------------------------------------------
  const first = await postChatMessage(member, room, 'Hello from the smoke run');
  assert('a member posts a message and gets 201', first.response.status === 201, first.response.body);
  assert(
    'the response carries the committed id and body',
    first.id.length === 36 && at(first.response.body, 'message', 'body') === 'Hello from the smoke run',
    first.response.body,
  );
  assert('the sender is the authenticated member', at(first.response.body, 'message', 'senderId') === member.id);
  assert('the author sees their own message marked as theirs', at(first.response.body, 'message', 'isYou') === true);
  assert(
    'the response carries the sender display name',
    at(first.response.body, 'message', 'senderName') === 'Smoke Chat Member',
  );
  assert(
    'timestamps come back as ISO 8601 UTC',
    String(at<string>(first.response.body, 'message', 'createdAt')).endsWith('Z'),
    at(first.response.body, 'message', 'createdAt'),
  );
  assert(
    'a message carries no coordinate of any spelling',
    hasNoCoordinates(at<Json>(first.response.body, 'message')),
    at(first.response.body, 'message'),
  );
  assert(
    'a message carries no email or phone number',
    !('email' in (at<Json>(first.response.body, 'message') ?? {})) &&
      !('phone' in (at<Json>(first.response.body, 'message') ?? {})),
    at(first.response.body, 'message'),
  );

  const storedAfterFirst = await chatRows(room);
  assert(
    'the message is a real row in MySQL, stored against the group',
    storedAfterFirst.length === 1 && storedAfterFirst[0]?.id === first.id && storedAfterFirst[0]?.groupId === room,
    storedAfterFirst,
  );
  assert(
    'the stored sender is the session member, not a request field',
    storedAfterFirst[0]?.senderId === member.id,
    storedAfterFirst[0],
  );

  // The body is never trusted for identity: a crafted `senderId` must be ignored.
  const spoofed = await call('POST', `/api/groups/${room}/messages`, {
    token: member.accessToken,
    body: { body: 'Pretending to be someone else', senderId: outsider.id },
  });
  assert(
    'a client-supplied senderId is ignored',
    spoofed.status === 201 && at(spoofed.body, 'message', 'senderId') === member.id,
    spoofed.body,
  );

  // ---- validation ------------------------------------------------------------
  const empty = await postChatMessage(member, room, '   ');
  assert(
    'a message of whitespace is refused',
    empty.response.status === 400 && errorCode(empty.response) === 'validation_error',
    empty.response.body,
  );

  const tooLong = await postChatMessage(member, room, 'x'.repeat(1001));
  assert('a message past the length limit is refused', tooLong.response.status === 400, tooLong.response.body);

  const badCursor = await call('GET', `/api/groups/${room}/messages?before=${smokeUuid()}`, {
    token: member.accessToken,
  });
  assert(
    'a cursor that is not in this conversation is a validation error, not an empty page',
    badCursor.status === 400 && errorCode(badCursor) === 'validation_error',
    badCursor.body,
  );

  // ---- history and the sender's own view -------------------------------------
  const history = await call('GET', `/api/groups/${room}/messages?limit=50`, { token: other.accessToken });
  const historyMessages = at<Json[]>(history.body, 'page', 'messages') ?? [];
  assert('a member reads the history', history.status === 200, history.body);
  assert(
    'history is oldest-first',
    historyMessages[0]?.id === first.id,
    historyMessages.map((message) => message.id),
  );
  assert(
    "another member's view marks the message as somebody else's",
    historyMessages[0]?.isYou === false,
    historyMessages[0],
  );
  assert(
    'history returns no coordinate and no contact detail',
    historyMessages.every((message) => hasNoCoordinates(message) && !('email' in message) && !('phone' in message)),
    historyMessages[0],
  );

  // ---- pagination ------------------------------------------------------------
  for (let index = 1; index <= 4; index += 1) {
    await postChatMessage(member, room, `Paging message ${index}`);
  }

  const allRows = await chatRows(room);
  const firstPage = await call('GET', `/api/groups/${room}/messages?limit=2`, { token: member.accessToken });
  const firstPageMessages = at<Json[]>(firstPage.body, 'page', 'messages') ?? [];
  const cursor = at<string | null>(firstPage.body, 'page', 'nextCursor');

  assert(
    'a page is exactly the requested size and reports more',
    firstPageMessages.length === 2 && at(firstPage.body, 'page', 'hasMore') === true,
    firstPage.body,
  );
  assert('the page carries a cursor for the next one', typeof cursor === 'string' && cursor.length === 36, cursor);

  const secondPage = await call('GET', `/api/groups/${room}/messages?limit=2&before=${String(cursor)}`, {
    token: member.accessToken,
  });
  const secondPageMessages = at<Json[]>(secondPage.body, 'page', 'messages') ?? [];
  assert(
    'the older page continues exactly where the first stopped',
    secondPageMessages.length === 2 &&
      !secondPageMessages.some((message) => firstPageMessages.some((newer) => newer.id === message.id)),
    secondPageMessages.map((message) => message.id),
  );
  assert(
    'and it is older, not newer',
    String(secondPageMessages[secondPageMessages.length - 1]?.createdAt) <= String(firstPageMessages[0]?.createdAt),
    { olderPageNewest: secondPageMessages[1]?.createdAt, firstPageOldest: firstPageMessages[0]?.createdAt },
  );
  assert(
    'the first page ends at the newest stored message',
    allRows.length === 6 && allRows[allRows.length - 1]?.id === firstPageMessages[1]?.id,
    { stored: allRows.length, head: firstPageMessages[1]?.id },
  );

  // ---- duplicate prevention --------------------------------------------------
  const dedupeKey = smokeUuid();
  const dedupeFirst = await postChatMessage(other, room, 'Sent once', dedupeKey);
  const dedupeSecond = await postChatMessage(other, room, 'Sent once', dedupeKey);

  assert('the first send of a retried message is stored', dedupeFirst.response.status === 201, dedupeFirst.response.body);
  assert(
    'a repeated clientMessageId resolves to the same message',
    dedupeSecond.response.status === 201 && dedupeSecond.id === dedupeFirst.id,
    { first: dedupeFirst.id, second: dedupeSecond.id, status: dedupeSecond.response.status },
  );
  const rowsAfterDedupe = await chatRows(room);
  assert(
    'and only one row was written',
    rowsAfterDedupe.filter((row) => row.body === 'Sent once').length === 1,
    rowsAfterDedupe.length,
  );

  // ---- revocation and the archive --------------------------------------------
  // Separate rooms, because this section removes a member and archives a group: the
  // checks above must not run against a group that has been closed underneath them.
  const removalRoom = await chatRoomFor(owner, [member]);
  const keptMessage = await postChatMessage(member, removalRoom, 'Said before being removed');

  assert(
    'the owner removes the member',
    (await call('DELETE', `/api/groups/${removalRoom}/members/${member.id}`, { token: owner.accessToken })).status === 204,
  );
  assert(
    'a removed member cannot read the history',
    (await call('GET', `/api/groups/${removalRoom}/messages`, { token: member.accessToken })).status === 403,
  );

  const writeAfterRemoval = await postChatMessage(member, removalRoom, 'Said after being removed');
  assert('a removed member cannot post', writeAfterRemoval.response.status === 403, writeAfterRemoval.response.body);

  const rowsAfterRemoval = await chatRows(removalRoom);
  assert(
    "a removed member's messages stay in the group's history",
    rowsAfterRemoval.length === 1 && rowsAfterRemoval[0]?.id === keptMessage.id,
    rowsAfterRemoval,
  );
  assert(
    'and the group can still read them',
    (await call('GET', `/api/groups/${removalRoom}/messages`, { token: owner.accessToken })).status === 200,
  );

  const archiveRoom = await chatRoomFor(owner, [member]);
  await postChatMessage(member, archiveRoom, 'Said before the archive');
  assert(
    'the owner archives the group',
    (await call('DELETE', `/api/groups/${archiveRoom}`, { token: owner.accessToken })).status === 204,
  );

  const readArchived = await call('GET', `/api/groups/${archiveRoom}/messages`, { token: member.accessToken });
  assert(
    'an archived group keeps its history readable to its members',
    readArchived.status === 200 && (at<Json[]>(readArchived.body, 'page', 'messages') ?? []).length === 1,
    readArchived.body,
  );

  const writeArchived = await postChatMessage(member, archiveRoom, 'Said after the archive');
  assert(
    'and refuses new messages with group_archived',
    writeArchived.response.status === 409 && errorCode(writeArchived.response) === 'group_archived',
    writeArchived.response.body,
  );

  // ---- real-time -------------------------------------------------------------
  const liveRoom = await chatRoomFor(owner, [member, other]);
  const listener = await connectSocket(other.accessToken);
  const speaker = await connectSocket(member.accessToken);

  assert('a member can open a real-time connection', listener.socket !== null, listener.error);
  assert('a second member can open one too', speaker.socket !== null, speaker.error);

  if (listener.socket && speaker.socket) {
    const join = await emitAck(listener.socket, 'group:join', { groupId: liveRoom });
    assert('a member joins the group room', join.ok === true && join.groupId === liveRoom, join);

    const eavesdrop = await connectSocket(outsider.accessToken);
    if (eavesdrop.socket) {
      const refused = await emitAck(eavesdrop.socket, 'group:join', { groupId: liveRoom });
      assert(
        'a non-member is refused the room by the server',
        refused.ok === false && refused.code === 'forbidden',
        refused,
      );
    }
    closeSocket(eavesdrop.socket);

    // An archived room is refused even to a member of that group: the history is
    // readable over HTTP, but there is nothing live to listen for.
    const archivedSocket = await connectSocket(member.accessToken);
    if (archivedSocket.socket) {
      const refusedArchived = await emitAck(archivedSocket.socket, 'group:join', { groupId: archiveRoom });
      assert(
        'an archived group cannot be joined as a live room',
        refusedArchived.ok === false && refusedArchived.code === 'group_archived',
        refusedArchived,
      );
    }
    closeSocket(archivedSocket.socket);

    // The listener is already waiting before the message is sent, so the assertion is
    // about the broadcast arriving - not about a race with the write.
    const broadcast = waitForSocketEvent(listener.socket, 'message:created');
    const sent = await emitAck(speaker.socket, 'message:send', {
      groupId: liveRoom,
      body: 'Typed over the socket',
      clientMessageId: smokeUuid(),
    });
    const sentMessage = sent.message as Json | undefined;

    assert(
      'a socket send is acknowledged with the committed message',
      sent.ok === true && String(sentMessage?.id ?? '').length === 36,
      sent,
    );

    const delivered = await broadcast;
    assert('and the other member receives it in the room', delivered?.id === sentMessage?.id, { sent, delivered });

    const socketRows = await chatRows(liveRoom);
    assert(
      'the socket message was persisted before it was delivered',
      socketRows.length === 1 && socketRows[0]?.body === 'Typed over the socket',
      socketRows,
    );

    const spoofedSocket = await emitAck(speaker.socket, 'message:send', {
      groupId: liveRoom,
      body: 'Socket spoof',
      senderId: owner.id,
    });
    assert(
      'the socket path ignores a client-supplied senderId too',
      spoofedSocket.ok === true && (spoofedSocket.message as Json | undefined)?.senderId === member.id,
      spoofedSocket,
    );

    // Session expiry: signing the device out revokes the session the socket was
    // authorized with, and the very next send must be refused rather than written.
    assert(
      'the member signs out',
      (await call('POST', '/api/auth/logout', { body: { refreshToken: member.refreshToken } })).status === 204,
    );

    const afterSignOut = await emitAck(speaker.socket, 'message:send', {
      groupId: liveRoom,
      body: 'Sent after signing out',
      clientMessageId: smokeUuid(),
    });
    assert(
      'a socket send on a revoked session is refused',
      afterSignOut.ok === false && afterSignOut.code === 'session_expired',
      afterSignOut,
    );

    const rowsAfterSignOut = await chatRows(liveRoom);
    assert(
      'and nothing was written for it',
      rowsAfterSignOut.every((row) => row.body !== 'Sent after signing out'),
      rowsAfterSignOut.length,
    );
  }

  closeSocket(speaker.socket);
  closeSocket(listener.socket);
}

/**
 * Phase 7 hardening: one message budget per member, spent by both transports.
 *
 * The write used to carry an address-based bucket on the HTTP route alone, which
 * meant the same member could keep typing past the ceiling over the socket. This
 * section asserts the property that replaced it, in the order a client meets it: the
 * allowance is reported on the wire, both transports spend the *same* one, a
 * parallel burst cannot buy extra, a refusal is the API's own error on both
 * transports, the connection survives it - and nothing refused is stored.
 *
 * The ceiling and the window are read from the same `backend/.env` the server read
 * (see the note at the top of this file), so the burst below is a real few hundred
 * messages rather than a formality; a run is sized for the documented development
 * values.
 */
async function runMessageBudgetChecks(): Promise<void> {
  section('Group chat: one message budget for HTTP and Socket.IO');

  const limit = env.rateLimit.messageMax;
  const windowSeconds = Math.round(env.rateLimit.messageWindowMs / 1000);
  /** Wider than the connection pool, so every submission in a chunk really is in flight. */
  const chunk = 20;

  const author = await createVerifiedAccount('budget-author', 'Smoke Budget Author');
  const peer = await createVerifiedAccount('budget-peer', 'Smoke Budget Peer');
  const room = await chatRoomFor(author, [peer]);

  // ---- the allowance, as a client reads it -----------------------------------
  const first = await postChatMessage(author, room, 'Budget 1');
  assert('a member may post while the budget lasts', first.response.status === 201, first.response.body);
  assert(
    "the response reports the member's remaining budget in the draft-7 RateLimit headers",
    remainingFrom(first.response) === limit - 1,
    { rateLimit: first.response.headers.get('ratelimit'), limit },
  );

  const speaker = await connectSocket(author.accessToken);
  const listener = await connectSocket(peer.accessToken);
  const speakerSocket = speaker.socket;
  const listenerSocket = listener.socket;

  // Without two live sockets nothing below would mean anything, so this aborts the
  // run loudly rather than reporting passes with no connection behind them.
  if (!speakerSocket || !listenerSocket) {
    closeSocket(speakerSocket);
    closeSocket(listenerSocket);
    throw new Error(`Smoke setup failed to open a chat socket: ${JSON.stringify(speaker.error ?? listener.error)}`);
  }

  const joined = await emitAck(listenerSocket, 'group:join', { groupId: room });
  assert('the other member is in the room before the burst', joined.ok === true, joined);
  await emitAck(speakerSocket, 'group:join', { groupId: room });

  // ---- the socket spends the same allowance ----------------------------------
  const delivered = waitForSocketEvent(listenerSocket, 'message:created');
  const twoOverSocket = await Promise.all(
    ['Budget 2', 'Budget 3'].map((body) =>
      emitAck(speakerSocket, 'message:send', { groupId: room, body, clientMessageId: smokeUuid() }),
    ),
  );
  assert(
    'socket sends are committed while the budget lasts',
    twoOverSocket.every((reply) => reply.ok === true),
    twoOverSocket,
  );
  assert('and the other member receives them live', (await delivered)?.id !== undefined);

  const afterSocket = await postChatMessage(author, room, 'Budget 4');
  assert(
    'the HTTP write draws on the same allowance the socket spent',
    remainingFrom(afterSocket.response) === limit - 4,
    { rateLimit: afterSocket.response.headers.get('ratelimit'), limit },
  );

  // ---- a parallel burst cannot buy extra -------------------------------------
  //
  // `limit - 4` is exactly what is left after the four sends above, and every one of
  // them must land: the count is asserted precisely rather than as "about the
  // ceiling", so a counter that loses an increment under parallelism fails here.
  const budgetLeft = limit - 4;
  const accepted = await floodSocket(speakerSocket, room, budgetLeft, 'Burst', chunk);
  assert(
    `every one of the ${budgetLeft} submissions inside the budget was committed, ${chunk} at a time`,
    accepted === budgetLeft,
    { accepted, budgetLeft },
  );

  // One *more* parallel chunk than the budget allows: all of it must be refused.
  const overflow = await Promise.all(
    Array.from({ length: chunk }, (_unused, index) =>
      emitAck(speakerSocket, 'message:send', {
        groupId: room,
        body: `Overflow ${index + 1}`,
        clientMessageId: smokeUuid(),
      }),
    ),
  );
  assert(
    'a parallel burst past the ceiling is refused in full, not partially',
    overflow.every((reply) => reply.ok === false),
    { allowed: overflow.filter((reply) => reply.ok === true).length, chunk },
  );

  // ---- the refusal, on both transports ---------------------------------------
  // The one 429 this run provokes on purpose - so it declares itself, and the
  // summary does not report a bucket that ran out mid-run.
  const refusedHttp = await call('POST', `/api/groups/${room}/messages`, {
    token: author.accessToken,
    body: { body: 'One too many, over HTTP' },
    expectRateLimit: true,
  });
  assert(
    "the HTTP write is refused with the API's own code",
    refusedHttp.status === 429 && errorCode(refusedHttp) === 'rate_limited',
    refusedHttp.body,
  );

  const httpDelay = retryAfterFrom(refusedHttp);
  assert(
    'the refusal says how long to wait, inside the window, and sets Retry-After',
    httpDelay !== null &&
      httpDelay >= 1 &&
      httpDelay <= windowSeconds &&
      refusedHttp.headers.get('retry-after') === String(httpDelay),
    { delay: httpDelay, retryAfter: refusedHttp.headers.get('retry-after'), windowSeconds },
  );
  assert(
    'and the budget headers report nothing left',
    remainingFrom(refusedHttp) === 0,
    refusedHttp.headers.get('ratelimit'),
  );

  const refusedSocket = await emitAck(speakerSocket, 'message:send', {
    groupId: room,
    body: 'One too many, over the socket',
    clientMessageId: smokeUuid(),
  });
  assert(
    'the socket send is refused with the same code and the same wait',
    refusedSocket.ok === false &&
      refusedSocket.code === 'rate_limited' &&
      typeof refusedSocket.retryAfterSeconds === 'number',
    refusedSocket,
  );
  assert(
    'both transports refuse with the same sentence',
    String(at<string>(refusedHttp.body, 'error', 'message')) === refusedSocket.message,
    { http: at(refusedHttp.body, 'error', 'message'), socket: refusedSocket.message },
  );

  // ---- nothing refused was stored --------------------------------------------
  const rows = await chatRows(room);
  assert(
    'exactly the accepted messages are in MySQL - a refused submission writes nothing',
    rows.length === limit,
    { rows: rows.length, limit },
  );
  assert(
    'and no refused body reached the table',
    rows.every((row) => !String(row.body).startsWith('One too many') && !String(row.body).startsWith('Overflow')),
    rows.filter((row) => String(row.body).startsWith('Overflow')).map((row) => row.body),
  );

  // ---- a refusal is not a disconnect -----------------------------------------
  const stillInRoom = await emitAck(speakerSocket, 'group:join', { groupId: room });
  assert(
    'a refused sender keeps the connection and the room',
    stillInRoom.ok === true && stillInRoom.groupId === room,
    stillInRoom,
  );

  // ---- the budget belongs to the member, not to the room ---------------------
  const peerPost = await postChatMessage(peer, room, 'The other member may still talk');
  assert(
    "one member's exhausted budget does not mute the others",
    peerPost.response.status === 201,
    peerPost.response.body,
  );
  assert(
    'and the other member has a whole allowance of their own',
    remainingFrom(peerPost.response) === limit - 1,
    { rateLimit: peerPost.response.headers.get('ratelimit'), limit },
  );

  closeSocket(speakerSocket);
  closeSocket(listenerSocket);
}

/** One feed request, with the response filter as the API spells it. */
async function feedFor(account: Account, response: string): Promise<ApiResponse> {
  return call('GET', `/api/events/feed?response=${response}&limit=50`, { token: account.accessToken });
}

/**
 * Phase 7: the unified group-event feed and the Going / Not going responses.
 *
 * The feed replaced the three Events views (Nearby / My groups / Going). What is
 * asserted here is the boundary rather than the sorting: who may see an event at all
 * (an active member of its group, and nobody else), and what each response state
 * means - including the two that are easy to conflate, an explicit decline and a
 * withdrawn answer.
 */
async function runEventResponseChecks(): Promise<void> {
  section('Group events: the unified feed and Going / Not going');

  const owner = await createVerifiedAccount('feed-owner', 'Smoke Feed Owner');
  const member = await createVerifiedAccount('feed-member', 'Smoke Feed Member');
  const second = await createVerifiedAccount('feed-second', 'Smoke Feed Second');
  const outsider = await createVerifiedAccount('feed-outsider', 'Smoke Feed Outsider');
  const applicant = await createVerifiedAccount('feed-applicant', 'Smoke Feed Applicant');

  const groupId = await chatRoomFor(owner, [member, second], { name: 'Smoke Feed Group' });
  const privateGroup = await createGroupFor(
    owner,
    publicGroupDraft({ name: 'Smoke Feed Private', visibility: 'private' }),
  );
  // A pending request is not a membership, which the access checks below rely on.
  await call('POST', `/api/groups/${privateGroup.id}/join`, { token: applicant.accessToken });

  const openEvent = await createEventFor(owner, eventDraft({ title: 'Smoke Feed Open', groupId }));

  assert('the feed requires a session', (await call('GET', '/api/events/feed')).status === 401);
  assert(
    'an unknown response filter is a validation error',
    (await call('GET', '/api/events/feed?response=maybe', { token: member.accessToken })).status === 400,
  );

  // ---- the feed is the member's own groups' calendar --------------------------
  const feed = await feedFor(member, 'upcoming');
  assert('the feed answers 200', feed.status === 200, feed.body);
  const inFeed = eventById(feed.body, openEvent.id);
  assert('the feed includes an event from a group the member is in', inFeed !== undefined, feed.body);
  assert('the event reports no answer yet', inFeed?.viewerRsvpStatus === null, inFeed);
  assert(
    'every feed row carries the group it came from',
    (at<Json[]>(feed.body, 'page', 'events') ?? []).every((event) => event.groupId === groupId),
    at<Json[]>(feed.body, 'page', 'events'),
  );

  assert(
    'an unanswered event is in Needs response',
    eventById((await feedFor(member, 'needs_response')).body, openEvent.id) !== undefined,
  );
  assert('and is not in Going', eventById((await feedFor(member, 'going')).body, openEvent.id) === undefined);

  // ---- Not going is an answer ------------------------------------------------
  const declined = await call('PUT', `/api/events/${openEvent.id}/rsvp`, {
    token: member.accessToken,
    body: { status: 'not_going' },
  });
  assert(
    'PUT /rsvp records Not going and answers with the new state',
    declined.status === 200 && at(declined.body, 'event', 'viewerRsvpStatus') === 'not_going',
    declined.body,
  );
  assert(
    'declining does not count as attending',
    at(declined.body, 'event', 'goingCount') === 0 && at(declined.body, 'event', 'viewerIsGoing') === false,
    declined.body,
  );

  const declinedRows = await rsvpRows(openEvent.id, member.id);
  assert(
    'the stored row is not_going with no cancellation timestamp',
    declinedRows.length === 1 && declinedRows[0]?.status === 'not_going' && declinedRows[0]?.cancelledAt === null,
    declinedRows,
  );

  assert(
    'the event leaves Needs response',
    eventById((await feedFor(member, 'needs_response')).body, openEvent.id) === undefined,
  );
  assert(
    'and appears under Not going',
    eventById((await feedFor(member, 'not_going')).body, openEvent.id) !== undefined,
  );
  assert('and is absent from Going', eventById((await feedFor(member, 'going')).body, openEvent.id) === undefined);
  assert(
    'and is still in All upcoming',
    eventById((await feedFor(member, 'upcoming')).body, openEvent.id) !== undefined,
  );

  // ---- changing the answer ---------------------------------------------------
  const accepted = await call('PUT', `/api/events/${openEvent.id}/rsvp`, {
    token: member.accessToken,
    body: { status: 'going' },
  });
  assert(
    'changing to Going answers with the new state',
    accepted.status === 200 && at(accepted.body, 'event', 'viewerRsvpStatus') === 'going',
    accepted.body,
  );
  assert(
    'Going counts as attendance',
    at(accepted.body, 'event', 'goingCount') === 1 && at(accepted.body, 'event', 'viewerIsGoing') === true,
    accepted.body,
  );

  const acceptedRows = await rsvpRows(openEvent.id, member.id);
  assert(
    'the same row changed state rather than a second one being added',
    acceptedRows.length === 1 && acceptedRows[0]?.status === 'going' && acceptedRows[0]?.cancelledAt === null,
    acceptedRows,
  );
  assert('the event appears under Going', eventById((await feedFor(member, 'going')).body, openEvent.id) !== undefined);
  assert(
    'and leaves Not going',
    eventById((await feedFor(member, 'not_going')).body, openEvent.id) === undefined,
  );

  const repeated = await call('PUT', `/api/events/${openEvent.id}/rsvp`, {
    token: member.accessToken,
    body: { status: 'going' },
  });
  assert(
    'answering Going twice is idempotent',
    repeated.status === 200 &&
      at(repeated.body, 'event', 'goingCount') === 1 &&
      (await rsvpRows(openEvent.id, member.id)).length === 1,
    repeated.body,
  );

  // ---- withdrawing is not declining ------------------------------------------
  const withdrawn = await call('DELETE', `/api/events/${openEvent.id}/rsvp`, { token: member.accessToken });
  assert('withdrawing an RSVP answers 200', withdrawn.status === 200, withdrawn.body);
  assert(
    'a withdrawn RSVP is reported as cancelled - no answer',
    at(withdrawn.body, 'event', 'viewerRsvpStatus') === 'cancelled',
    withdrawn.body,
  );
  assert('and it frees the place', at(withdrawn.body, 'event', 'goingCount') === 0, withdrawn.body);
  assert(
    'the withdrawn event returns to Needs response',
    eventById((await feedFor(member, 'needs_response')).body, openEvent.id) !== undefined,
  );
  assert(
    'and is not listed as Not going',
    eventById((await feedFor(member, 'not_going')).body, openEvent.id) === undefined,
  );

  // ---- what a response may be ------------------------------------------------
  const notAnAnswer = await call('PUT', `/api/events/${openEvent.id}/rsvp`, {
    token: member.accessToken,
    body: { status: 'cancelled' },
  });
  assert(
    'withdrawing is not an answer the API will accept on this endpoint',
    notAnAnswer.status === 400 && errorCode(notAnAnswer) === 'validation_error',
    notAnAnswer.body,
  );

  const nonsense = await call('PUT', `/api/events/${openEvent.id}/rsvp`, {
    token: member.accessToken,
    body: { status: 'maybe' },
  });
  assert('an unknown status is a validation error', nonsense.status === 400, nonsense.body);

  // ---- capacity: only Going takes a place ------------------------------------
  const limited = await createEventFor(
    owner,
    eventDraft({ title: 'Smoke Feed Limited', groupId, maxParticipants: 1 }),
  );
  assert(
    'the first member takes the only place',
    (
      await call('PUT', `/api/events/${limited.id}/rsvp`, {
        token: member.accessToken,
        body: { status: 'going' },
      })
    ).status === 200,
  );

  const declinedSecond = await call('PUT', `/api/events/${limited.id}/rsvp`, {
    token: second.accessToken,
    body: { status: 'not_going' },
  });
  assert(
    'declining does not consume the remaining capacity',
    declinedSecond.status === 200 &&
      at(declinedSecond.body, 'event', 'goingCount') === 1 &&
      at(declinedSecond.body, 'event', 'isFull') === true,
    declinedSecond.body,
  );

  const upgradeRefused = await call('PUT', `/api/events/${limited.id}/rsvp`, {
    token: second.accessToken,
    body: { status: 'going' },
  });
  assert(
    'moving from Not going to Going on a full event is refused',
    upgradeRefused.status === 409 && errorCode(upgradeRefused) === 'event_full',
    upgradeRefused.body,
  );

  const secondRows = await rsvpRows(limited.id, second.id);
  assert(
    'and the refusal leaves the previous answer in place',
    secondRows.length === 1 && secondRows[0]?.status === 'not_going',
    secondRows,
  );
  assert(
    'the attendance count is the database count, not a client value',
    (await goingCountFor(limited.id)) === 1 && at(declinedSecond.body, 'event', 'goingCount') === 1,
    { stored: await goingCountFor(limited.id) },
  );
  assert(
    'a declined event still appears under Not going for its owner',
    eventById((await feedFor(second, 'not_going')).body, limited.id) !== undefined,
  );

  // ---- who can see what ------------------------------------------------------
  const privateEvent = await createEventFor(
    owner,
    eventDraft({ title: 'Smoke Feed Private Event', groupId: privateGroup.id }),
  );
  assert(
    'a non-member cannot read a private group event',
    (await call('GET', `/api/events/${privateEvent.id}`, { token: outsider.accessToken })).status === 404,
  );
  assert(
    'a pending applicant cannot read it either',
    (await call('GET', `/api/events/${privateEvent.id}`, { token: applicant.accessToken })).status === 404,
  );
  assert(
    'a non-member cannot answer it',
    (
      await call('PUT', `/api/events/${privateEvent.id}/rsvp`, {
        token: outsider.accessToken,
        body: { status: 'going' },
      })
    ).status === 404,
  );

  const outsiderFeed = await feedFor(outsider, 'upcoming');
  assert(
    'a member of no group gets an empty feed rather than a filtered one',
    (at<Json[]>(outsiderFeed.body, 'page', 'events') ?? []).length === 0,
    outsiderFeed.body,
  );
  const applicantFeed = await feedFor(applicant, 'upcoming');
  assert(
    'and a pending request does not reveal a private calendar',
    eventById(applicantFeed.body, privateEvent.id) === undefined,
  );
  assert(
    'the group owner sees their own private event in the feed',
    eventById((await feedFor(owner, 'upcoming')).body, privateEvent.id) !== undefined,
  );

  // ---- legacy standalone events ----------------------------------------------
  const standalone = await createEventFor(owner, eventDraft({ title: 'Smoke Feed Standalone' }));
  assert(
    'a standalone event is still created and readable by id',
    (await call('GET', `/api/events/${standalone.id}`, { token: owner.accessToken })).status === 200,
  );
  assert(
    'but it is not part of the group feed',
    eventById((await feedFor(owner, 'upcoming')).body, standalone.id) === undefined,
  );

  // ---- cancelled and ended events leave the active feed ----------------------
  const toCancel = await createEventFor(owner, eventDraft({ title: 'Smoke Feed Cancelled', groupId }));
  assert(
    'the event starts in the feed',
    eventById((await feedFor(member, 'upcoming')).body, toCancel.id) !== undefined,
  );
  assert(
    'the owner cancels it',
    (await call('DELETE', `/api/events/${toCancel.id}`, { token: owner.accessToken })).status === 200,
  );
  assert(
    'a cancelled event leaves the feed',
    eventById((await feedFor(member, 'upcoming')).body, toCancel.id) === undefined,
  );
  assert(
    'and leaves the group own upcoming list',
    eventById(
      (await call('GET', `/api/events?groupId=${groupId}&limit=50`, { token: member.accessToken })).body,
      toCancel.id,
    ) === undefined,
  );
  assert(
    'and cannot be answered',
    (
      await call('PUT', `/api/events/${toCancel.id}/rsvp`, {
        token: member.accessToken,
        body: { status: 'going' },
      })
    ).status === 409,
  );

  const ended = await createEventFor(owner, eventDraft({ title: 'Smoke Feed Ended', groupId }));
  await pool.query(
    'UPDATE events SET start_at = DATE_SUB(NOW(3), INTERVAL 3 HOUR), end_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = ?',
    [ended.id],
  );
  assert(
    'an ended event leaves the feed',
    eventById((await feedFor(member, 'upcoming')).body, ended.id) === undefined,
  );
  const answerEnded = await call('PUT', `/api/events/${ended.id}/rsvp`, {
    token: member.accessToken,
    body: { status: 'going' },
  });
  assert(
    'and refuses a response with event_ended',
    answerEnded.status === 409 && errorCode(answerEnded) === 'event_ended',
    answerEnded.body,
  );

  // ---- any active member may host --------------------------------------------
  const memberEvent = await createEventFor(
    member,
    eventDraft({ title: 'Smoke Feed Member Event', groupId }),
  );
  assert(
    'an ordinary active member may host for their group',
    memberEvent.response.status === 201,
    memberEvent.response.body,
  );
  assert(
    'and the feed carries it for the other members',
    eventById((await feedFor(second, 'upcoming')).body, memberEvent.id) !== undefined,
  );

  const outsiderHosts = await call('POST', '/api/events', {
    token: outsider.accessToken,
    body: eventDraft({ title: 'Smoke Feed Outsider Event', groupId }),
  });
  assert('a non-member cannot host for the group', outsiderHosts.status === 403, outsiderHosts.body);
}








