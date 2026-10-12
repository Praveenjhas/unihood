/**
 * Password hashing.
 *
 * Uses **scrypt from Node's own `crypto`** rather than a third-party package:
 *
 *   * it is a memory-hard KDF (128 * N * r bytes per guess), so it resists GPU
 *     and ASIC cracking in the way bcrypt does and a plain SHA ever could not;
 *   * it ships in the runtime, so there is no native build step - which matters
 *     here, because a `node-gyp` failure would break `npm install` on a machine
 *     with no C++ toolchain, and a build the project cannot reproduce is not a
 *     build it can verify;
 *   * no dependency means nothing extra to keep patched.
 *
 * The stored value is self-describing -
 * `scrypt$N$r$p$<salt-base64url>$<hash-base64url>` - so the cost parameters can
 * be raised later and old hashes still verify. `needsRehash` reports when a
 * stored hash was produced with weaker parameters than the current ones, which
 * is what a login handler would use to upgrade a password in place.
 *
 * The parameters (N=16384, r=8, p=1) are the Node defaults and sit in OWASP's
 * recommended range; N=2^14 keeps one hash around 50-100 ms on this class of
 * hardware, which is the anchor for the whole scheme.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

import { badRequest } from './errors';

/**
 * The shortest password any endpoint accepts.
 *
 * It is the floor for `/api/auth/register` (whichever credential the account is
 * created with) and for `/api/auth/reset-password`, and the client form mirrors
 * it so the two cannot disagree. `/api/auth/login` deliberately accepts any
 * non-empty password: an account created before this minimum existed must still
 * be able to sign in.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

const SCHEME = 'scrypt';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
/** Node's default is 32 MiB; N=16384,r=8 needs ~16 MiB, so give it headroom. */
const MAX_MEMORY = 64 * 1024 * 1024;

/**
 * A deliberately short, high-frequency list. Anything on it is rejected before
 * hashing, because no amount of scrypting rescues `password123`.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890',
  'qwertyui', 'qwerty123', 'iloveyou', 'letmein1', 'welcome1', 'admin123', 'unihood', 'unihood1',
  'changeme', 'football', 'baseball', 'sunshine',
]);

function derive(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

const currentOptions: ScryptOptions = {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: MAX_MEMORY,
};

/**
 * Unicode normalisation before hashing: without it the same visible password
 * typed on two keyboards (composed vs decomposed accents) would produce two
 * different hashes and one inexplicable "wrong password".
 */
const normalize = (password: string): string => password.normalize('NFKC');

/**
 * Rejects a password the account holder can plainly do better than.
 *
 * The rules are about *predictability*, not complexity theatre: length is the
 * only one that reliably helps, and the rest stop the handful of passwords that
 * appear in every credential-stuffing list, plus anything derived from the
 * member's own name or address.
 */
export function assertPasswordAcceptable(
  password: string,
  context: { email?: string | null; phone?: string | null; displayName?: string | null } = {},
): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`Passwords need at least ${MIN_PASSWORD_LENGTH} characters. Pick something a little longer.`, {
      field: 'password',
    });
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    throw badRequest(`Passwords must be ${MAX_PASSWORD_LENGTH} characters or fewer.`, { field: 'password' });
  }

  const lowered = password.toLowerCase();

  if (COMMON_PASSWORDS.has(lowered)) {
    throw badRequest('That password is too easy to guess. Pick something longer and less obvious.', {
      field: 'password',
    });
  }

  if (/^\d+$/.test(password)) {
    throw badRequest('A password of only digits is too easy to guess. Add a letter or a symbol.', {
      field: 'password',
    });
  }

  const email = context.email?.trim().toLowerCase();
  if (email) {
    const localPart = email.split('@')[0] ?? '';
    if (localPart.length >= 3 && lowered.includes(localPart)) {
      throw badRequest('Your password should not contain your email address.', { field: 'password' });
    }
  }

  const displayName = context.displayName?.trim().toLowerCase().replace(/\s+/g, '');
  if (displayName && displayName.length >= 4 && lowered.replace(/\s+/g, '').includes(displayName)) {
    throw badRequest('Your password should not contain your display name.', { field: 'password' });
  }

  /**
   * The number the account signs in with.
   *
   * Since sign-in is a phone number plus a password, a password built out of that
   * number is the same mistake the email rule above guards against - and a worse
   * one, because a number is short, public and frequently the whole secret
   * somewhere else. The last six digits are what a member would actually type, so
   * those are what is looked for.
   */
  const phoneDigits = (context.phone ?? '').replace(/\D+/g, '').slice(-6);
  if (phoneDigits.length === 6 && lowered.replace(/\D+/g, '').includes(phoneDigits)) {
    throw badRequest('Your password should not contain your phone number.', { field: 'password' });
  }
}

/** Hashes a password with a fresh 16-byte salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await derive(normalize(password), salt, KEY_LENGTH, currentOptions);

  return [
    SCHEME,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns `false` - never throws - for a hash it cannot parse, so a malformed
 * row is a failed login rather than a 500 that would confirm the row exists.
 * `timingSafeEqual` keeps the comparison constant-time.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 6) return false;

  const [scheme, n, r, p, saltPart, hashPart] = parts as [string, string, string, string, string, string];
  if (scheme !== SCHEME) return false;

  const N = Number.parseInt(n, 10);
  const rValue = Number.parseInt(r, 10);
  const pValue = Number.parseInt(p, 10);
  if (!Number.isInteger(N) || !Number.isInteger(rValue) || !Number.isInteger(pValue)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltPart, 'base64url');
    expected = Buffer.from(hashPart, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await derive(normalize(password), salt, expected.length, {
      N,
      r: rValue,
      p: pValue,
      maxmem: MAX_MEMORY,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    // A cost the runtime refuses to allocate is a configuration problem, not a
    // valid login; refusing is the safe answer.
    return false;
  }
}

/** True when a stored hash used weaker parameters than the current ones. */
export function needsRehash(storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return true;
  return (
    Number.parseInt(parts[1] ?? '0', 10) < SCRYPT_N ||
    Number.parseInt(parts[2] ?? '0', 10) < SCRYPT_R ||
    Number.parseInt(parts[3] ?? '0', 10) < SCRYPT_P
  );
}
