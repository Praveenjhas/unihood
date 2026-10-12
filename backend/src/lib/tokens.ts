/**
 * Identifiers and single-use tokens.
 *
 * Two shapes exist, and the difference is deliberate:
 *
 *   * **Opaque tokens** (`createOpaqueToken`) are 256 bits of CSPRNG output,
 *     base64url-encoded. They are the whole credential, so they are never
 *     stored: `hashToken` reduces them to a SHA-256 hex digest and only the
 *     digest reaches the database. A read of `refresh_sessions` or
 *     `password_reset_tokens` therefore yields nothing that can be replayed.
 *
 *   * **Ids** (`newId`) are UUIDs. They appear in URLs and responses and carry no
 *     authority of their own - every endpoint re-derives the caller from the
 *     access token, never from a body or a path id.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** A fresh UUID v4, used as a primary key. */
export const newId = (): string => randomUUID();

/** A 256-bit opaque token. 43 base64url characters, no padding. */
export const createOpaqueToken = (): string => randomBytes(32).toString('base64url');

/**
 * SHA-256 of a token, as 64 lowercase hex characters - exactly the width of the
 * `CHAR(64) COLLATE ascii_bin` columns the migrations declare.
 *
 * SHA-256 (not scrypt) is correct here: the input is already 256 bits of random
 * data, so there is no guessing to slow down, and a fast hash keeps lookup a
 * single indexed equality test.
 */
export const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
