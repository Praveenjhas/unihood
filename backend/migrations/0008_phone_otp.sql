-- =============================================================================
-- Unihood migration 0008 - phone-number sign-in with one-time codes
--
-- Phase 5 replaces email+password as the *user-facing* sign-in with a phone
-- number and a short code. Nothing about the existing security model changes:
-- the session that a verified code produces is exactly the session a password
-- produced (short-lived HS256 access token + a rotating, hashed refresh session).
--
-- What this file does
--   1. `users.email` and `users.password_hash` become NULLABLE, because a member
--      who signs up with a phone number has neither. The unique key on `email`
--      stays: MySQL allows any number of NULLs in a unique index, so "one account
--      per address" still holds for the accounts that have one.
--   2. `users.phone_e164` (normalised, unique) and `users.phone_verified_at` are
--      added. The uniqueness lives in the database, not in application code, so
--      two concurrent verifications cannot both claim a number.
--   3. `otp_challenges` holds one row per requested code. It is deliberately NOT
--      foreign-keyed to `users`: a challenge belongs to a *phone number*, and a
--      code must be requestable (and verifiable) for a number that has no account
--      yet - that is how an account is created. Nothing in this table is ever
--      deleted, which is what makes the hourly request cap a real cap rather than
--      a counter that a caller can reset by requesting again.
--
-- Existing email accounts
--   Untouched, and deliberately left without a phone number. No number is
--   invented or claimed for them, and `npm run phone:link` is the one explicit
--   way to attach one (see README -> "Phone sign-in"). Those accounts keep
--   working through the email endpoints, which remain mounted for exactly this
--   reason.
--
-- Why the code is a *keyed* hash
--   A 6-digit code has ~20 bits of entropy, so an unkeyed SHA-256 of it is
--   brute-forced by anyone who reads the table. `code_hash` is therefore
--   HMAC-SHA256(id + ':' + code) under a server secret held in the environment
--   (`OTP_HASH_SECRET`), which makes a leaked dump useless without that secret.
--   `CHAR(64) ascii_bin` matches the other token columns: exact byte comparison,
--   never case-insensitive.
--
-- MySQL 8.0 has no `ADD COLUMN IF NOT EXISTS`/`ADD CONSTRAINT IF NOT EXISTS`;
-- `schema_migrations` is what keeps this file from running twice.
-- =============================================================================

ALTER TABLE users
  MODIFY COLUMN email         VARCHAR(254) NULL DEFAULT NULL,
  MODIFY COLUMN password_hash VARCHAR(255) NULL DEFAULT NULL,
  ADD COLUMN phone_e164        VARCHAR(16) NULL DEFAULT NULL AFTER email,
  ADD COLUMN phone_verified_at DATETIME(3) NULL DEFAULT NULL AFTER email_verified_at,
  ADD UNIQUE KEY users_phone_e164_key (phone_e164),
  -- E.164 as the whole format: a leading `+`, a non-zero country digit and 8-15
  -- digits in total. The API normalises before it writes, so this is the second
  -- line of defence rather than the parser.
  ADD CONSTRAINT users_phone_e164_format_chk
    CHECK (phone_e164 IS NULL OR phone_e164 REGEXP '^\\+[1-9][0-9]{7,14}$');

-- -----------------------------------------------------------------------------
-- One requested code.
--
-- `superseded_at` rather than overwriting: when a member asks for a new code the
-- previous one stops working (only the newest row is ever accepted), but its row
-- stays visible to the rate limiter. That is the difference between "a repeated
-- request invalidates the old code" and "a repeated request resets the limit".
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS otp_challenges (
  id            CHAR(36)         NOT NULL,
  phone_e164    VARCHAR(16)      NOT NULL,
  code_hash     CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempts      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts  TINYINT UNSIGNED NOT NULL DEFAULT 5,
  expires_at    DATETIME(3)      NOT NULL,
  consumed_at   DATETIME(3)      NULL DEFAULT NULL,
  superseded_at DATETIME(3)      NULL DEFAULT NULL,
  -- Recorded for abuse investigation only; never returned by any endpoint.
  requested_ip  VARCHAR(45)      NULL DEFAULT NULL,
  created_at    DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- Both jobs read this index: "the newest code for this number" (verification)
  -- and "how many codes has this number asked for in the last hour" (the cap).
  KEY otp_challenges_phone_idx (phone_e164, created_at),
  CONSTRAINT otp_challenges_phone_format_chk CHECK (phone_e164 REGEXP '^\\+[1-9][0-9]{7,14}$'),
  CONSTRAINT otp_challenges_code_hash_length_chk CHECK (CHAR_LENGTH(code_hash) = 64),
  CONSTRAINT otp_challenges_attempts_chk CHECK (attempts <= max_attempts)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
