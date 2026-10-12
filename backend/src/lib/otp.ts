/**
 * One-time codes: generating them, and checking them without storing them.
 *
 * Three properties matter, and each is a deliberate choice rather than a default:
 *
 *   1. **The code is unpredictable.** `crypto.randomInt` is the platform CSPRNG
 *      with a rejection-sampled, modulo-bias-free range - a `Math.random()` code
 *      would be guessable from a single observed value.
 *
 *   2. **Only a keyed hash is stored.** A six-digit code has ~20 bits of entropy,
 *      so a plain SHA-256 of it is exhaustive-searchable in well under a second by
 *      anyone who reads the table. The hash is
 *      `HMAC-SHA256(secret, challengeId + ':' + code)`, which is useless without
 *      the server secret and cannot be compared across rows.
 *
 *   3. **Comparison is constant-time.** `timingSafeEqual` on two fixed-width
 *      digests, so a wrong code cannot be narrowed down digit by digit by
 *      measuring how long the refusal took.
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Uniform over `10^length` values, including a leading zero. */
export function createOtpCode(length: number): string {
  const limit = 10 ** length;
  return String(randomInt(0, limit)).padStart(length, '0');
}

/**
 * The stored form of a code.
 *
 * Binding the challenge id into the digest means two identical codes in two
 * different challenges produce different hashes, so a leaked table reveals
 * neither reuse nor an equality between rows.
 */
export function hashOtpCode(code: string, challengeId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${challengeId}:${code}`, 'utf8').digest('hex');
}

/**
 * Compares a candidate code against a stored hash.
 *
 * A length mismatch cannot happen between two HMAC digests, but the guard keeps
 * `timingSafeEqual` from throwing if a malformed value ever reaches here - and a
 * malformed stored hash must fail the check, not crash the request.
 */
export function otpCodeMatches(code: string, challengeId: string, secret: string, storedHash: string): boolean {
  const computed = Buffer.from(hashOtpCode(code, challengeId, secret), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');

  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

/** True when the value is exactly `length` digits - the shape a code input has. */
export function looksLikeOtpCode(value: string, length: number): boolean {
  return new RegExp(`^[0-9]{${length}}$`).test(value.trim());
}
