/**
 * The one HTTP client.
 *
 * Everything the app reads or writes goes through this module, for the same
 * reason the Supabase build had a single client: the session, the base URL and
 * the error contract are decided in exactly one place, and no screen has to know
 * how a token is attached or when it is renewed.
 *
 * What it owns:
 *
 *   * **the base URL** - `EXPO_PUBLIC_API_BASE_URL`, with a
 *     `BackendNotConfiguredError` when it is missing, so the app shows the
 *     configuration screen instead of failing obscurely;
 *   * **the persisted session** - the access token, the renewal token and the
 *     member, in AsyncStorage under `unihood.auth.session`, mirrored in memory so
 *     a cold start resumes the account without showing the welcome screen again;
 *   * **renewal** - a token close to expiry is renewed *before* a request rather
 *     than after a 401, and a 401 that survives a renewal clears the session.
 *     Renewal is single-flight: ten parallel requests that all notice an expiring
 *     token still trigger one `POST /api/auth/refresh`, because the server
 *     rotates the token and a second use of it is treated as theft;
 *   * **the error contract** - a non-2xx response becomes an `ApiError` carrying
 *     the server's `code`; a request that never left the device becomes a
 *     `NetworkError`. Screens call `describeError` on either.
 *
 * Nothing here performs I/O at import time, so the module is safe to import from
 * anywhere, including the root layout.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { env } from './env';
import { ApiError, BackendNotConfiguredError, NetworkError, isApiError } from './errors';

/** Where the persisted session lives in AsyncStorage. */
export const AUTH_STORAGE_KEY = 'unihood.auth.session';

/** How long before expiry an access token is considered due for renewal. */
const REFRESH_SKEW_MS = 30_000;

/** The signed-in member, as the API describes them. */
export interface SessionUser {
  id: string;
  /**
   * The number the member signed in with, in E.164, or `null` for an account
   * created before phone sign-in existed.
   */
  phone: string | null;
  /** `null` for an account that has only ever given a phone number. */
  email: string | null;
  displayName: string;
  emailVerified: boolean;
  phoneVerified: boolean;
}

/** A signed-in session: the access token, its renewal token, and the member. */
export interface AuthSession {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: SessionUser;
}

type SessionListener = (session: AuthSession | null) => void;

const listeners = new Set<SessionListener>();

/**
 * Notified whenever the stored session is written or cleared - including when
 * the client itself clears it because a renewal was refused. This is what lets
 * `AuthProvider` learn that "signed out on another device" has happened without
 * polling.
 */
export function subscribeToSession(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(session: AuthSession | null): void {
  for (const listener of [...listeners]) {
    try {
      listener(session);
    } catch {
      // A misbehaving listener must not break the client or the request that
      // triggered the change.
    }
  }
}

let cached: AuthSession | null = null;
let cacheLoaded = false;

/**
 * Parses a stored or server-supplied session.
 *
 * Validation rather than a cast: the value comes from AsyncStorage (which
 * survives app upgrades) or from the network, and a session with a missing token
 * would otherwise turn every later request into a confusing 401.
 */
function toSession(value: unknown): AuthSession | null {
  if (value === null || typeof value !== 'object') return null;

  const candidate = value as Partial<AuthSession> & { user?: Partial<SessionUser> };
  const user = candidate.user;

  const hasTokens =
    typeof candidate.accessToken === 'string' &&
    candidate.accessToken.length > 0 &&
    typeof candidate.refreshToken === 'string' &&
    candidate.refreshToken.length > 0;
  const hasExpiries =
    typeof candidate.accessTokenExpiresAt === 'string' && typeof candidate.refreshTokenExpiresAt === 'string';

  // An identity is an id plus *something* to recognise the member by. Since Phase
  // 5 that is normally a phone number, and an email is optional - so the guard is
  // "not both missing" rather than "an email is present", and a session stored by
  // an older build (which always had a good email) still restores.
  const hasIdentity =
    Boolean(user) &&
    typeof user?.id === 'string' &&
    (typeof user?.phone === 'string' || typeof user?.email === 'string');

  if (!hasTokens || !hasExpiries || !hasIdentity || !user) {
    return null;
  }

  return {
    accessToken: candidate.accessToken as string,
    refreshToken: candidate.refreshToken as string,
    accessTokenExpiresAt: candidate.accessTokenExpiresAt as string,
    refreshTokenExpiresAt: candidate.refreshTokenExpiresAt as string,
    user: {
      id: user.id,
      phone: typeof user.phone === 'string' ? user.phone : null,
      email: typeof user.email === 'string' ? user.email : null,
      displayName: typeof user.displayName === 'string' ? user.displayName : '',
      emailVerified: user.emailVerified === true,
      phoneVerified: user.phoneVerified === true,
    },
  };
}

/** The session restored from a previous run, or `null` when signed out. */
export async function readSession(): Promise<AuthSession | null> {
  if (cacheLoaded) return cached;

  try {
    const raw = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
    cached = raw === null ? null : toSession(JSON.parse(raw));
  } catch {
    // Unreadable or non-JSON: treat it as "no session" rather than crashing the
    // launch. The next sign-in overwrites it.
    cached = null;
  }

  cacheLoaded = true;
  return cached;
}

/**
 * Stores a session and tells every listener about it.
 *
 * Throws when the payload is not a session at all: silently keeping an unusable
 * session would surface later as a 401 in a place that has no idea why.
 */
export async function saveSession(input: unknown): Promise<AuthSession> {
  const session = toSession(input);
  if (!session) {
    throw new ApiError('internal_error', 500, 'That sign-in could not be stored. Try again.');
  }

  cached = session;
  cacheLoaded = true;

  try {
    await AsyncStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // The in-memory copy still carries this launch; the member signs in again
    // after a restart, which is a better outcome than refusing the sign-in.
  }

  publish(session);
  return session;
}

/** Clears the stored session. Safe to call when there is nothing stored. */
export async function clearSession(): Promise<void> {
  const had = cached !== null || !cacheLoaded;
  cached = null;
  cacheLoaded = true;

  try {
    await AsyncStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // Nothing else to do: the in-memory copy is already gone.
  }

  if (had) publish(null);
}

// -----------------------------------------------------------------------------
// Transport
// -----------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiRequestOptions {
  method?: HttpMethod;
  /** JSON body. `undefined` sends none. */
  body?: unknown;
  /** Query parameters; `null`, `undefined` and empty strings are dropped. */
  query?: Record<string, string | number | boolean | null | undefined>;
  /**
   * `'required'` (the default) attaches the caller's access token, renewing it
   * first if it is about to expire. `'none'` is for the auth endpoints, which are
   * the only calls that must work without a session.
   */
  auth?: 'required' | 'none';
}

function baseUrl(): string {
  if (!env.apiBaseUrl) throw new BackendNotConfiguredError();
  return env.apiBaseUrl;
}

/** Builds the URL by hand: React Native's `URL` is only partly implemented. */
function buildUrl(path: string, query?: ApiRequestOptions['query']): string {
  const search = query
    ? Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&')
    : '';

  return `${baseUrl()}${path}${search ? `?${search}` : ''}`;
}

function toApiError(status: number, payload: unknown): ApiError {
  const envelope = (payload as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;

  const code = typeof envelope?.code === 'string' ? envelope.code : 'internal_error';
  const message = typeof envelope?.message === 'string' ? envelope.message : '';
  return new ApiError(code, status, message, envelope?.details);
}

async function send(path: string, options: ApiRequestOptions, accessToken: string | null): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      // A non-JSON body (a proxy's error page, for instance) is not worth
      // guessing at; the status below is the answer.
      payload = null;
    }
  }

  if (!response.ok) throw toApiError(response.status, payload);
  return payload;
}

/** A 401 that means "this token is no longer good", not "this action failed". */
function isSessionRejection(caught: unknown): boolean {
  return isApiError(caught) && (caught.code === 'session_expired' || caught.code === 'unauthorized');
}

function isExpiring(session: AuthSession): boolean {
  const expiresAt = Date.parse(session.accessTokenExpiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - Date.now() <= REFRESH_SKEW_MS;
}

function isRefreshUsable(session: AuthSession): boolean {
  const expiresAt = Date.parse(session.refreshTokenExpiresAt);
  // An unparseable expiry is treated as usable: the server decides, and refusing
  // to try would sign the member out over a formatting quirk.
  return !Number.isFinite(expiresAt) || expiresAt > Date.now();
}

async function performRenewal(force: boolean): Promise<AuthSession | null> {
  const current = await readSession();
  if (!current) return null;

  if (!force && !isExpiring(current)) return current;
  if (!isRefreshUsable(current)) {
    await clearSession();
    return null;
  }

  try {
    const payload = await send(
      '/api/auth/refresh',
      { method: 'POST', auth: 'none', body: { refreshToken: current.refreshToken } },
      null,
    );
    return await saveSession(payload);
  } catch (caught) {
    // A refused renewal is final: the token was rotated, revoked, expired, or the
    // account was switched off. Keeping it would only repeat the failure, so the
    // session is cleared and the member signs in again.
    if (isApiError(caught) && (caught.status === 401 || caught.status === 403)) {
      await clearSession();
      return null;
    }

    // A network failure says nothing about the session, so it is kept and the
    // error is passed to whoever asked for the renewal.
    throw caught;
  }
}

let renewal: Promise<AuthSession | null> | null = null;

/**
 * Exchanges the refresh token for a new pair, or returns the current session.
 *
 * Single-flight on purpose: the refresh token rotates on every use, so two
 * concurrent renewals would make the second one look like a replayed token - and
 * the server answers a replay by revoking every session on the account.
 */
export function renewSession(force = false): Promise<AuthSession | null> {
  if (!renewal) {
    renewal = performRenewal(force).finally(() => {
      renewal = null;
    });
  }

  return renewal;
}

/**
 * The session to attach to a request, renewed first when it is due.
 * `null` means "signed out" - the caller should not retry.
 */
async function sessionForRequest(): Promise<AuthSession | null> {
  const current = await readSession();
  if (!current) return null;
  if (isExpiring(current)) return renewSession();
  return current;
}

/**
 * One API call.
 *
 * Authenticated by default. On a 401/`session_expired` it renews once and retries
 * the request exactly once, so a token that expired between the check above and
 * the server's answer costs a round trip rather than an error; if the retry is
 * refused too, the session is cleared and the failure is thrown so the UI can
 * send the member to sign-in.
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  if (options.auth === 'none') {
    return (await send(path, options, null)) as T;
  }

  const session = await sessionForRequest();
  if (!session) {
    throw new ApiError('session_expired', 401, 'Your session has expired. Sign in again to continue.');
  }

  try {
    return (await send(path, options, session.accessToken)) as T;
  } catch (caught) {
    if (!isSessionRejection(caught)) throw caught;

    const renewed = await renewSession(true);
    if (!renewed) throw caught;

    try {
      return (await send(path, options, renewed.accessToken)) as T;
    } catch (retried) {
      if (isSessionRejection(retried)) await clearSession();
      throw retried;
    }
  }
}
