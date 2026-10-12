-- =============================================================================
-- Unihood migration 0004 - revocable refresh sessions and single-use tokens
--
-- Everything here replaces a Supabase Auth feature, so there is no Phase 2 SQL
-- counterpart to port; the mapping to the old behaviour is documented instead.
--   * access token  -> short-lived HS256 JWT, never stored (mirrors the
--                      Supabase access token: stateless, ~15 minutes).
--   * refresh token -> an opaque random value stored ONLY as a SHA-256 hash.
--                      A database read therefore yields no usable credential,
--                      and a session stays individually revocable - which a
--                      signed token cannot be.
--   * email confirmation / recovery links -> single-use, hashed, expiring rows,
--                      so a leaked table cannot be replayed and an old link
--                      cannot be used twice.
--
-- Why SHA-256 and not a password hash for these columns: these are 256-bit
-- random values, not low-entropy secrets. There is nothing to brute force, and
-- a fast hash keeps lookup a single indexed equality test. Passwords are the
-- opposite case and use scrypt (see `src/lib/password.ts`).
--
-- `CHAR(64) CHARACTER SET ascii COLLATE ascii_bin` on every hash column: the
-- value is exactly 64 hex characters, and a binary collation makes the lookup an
-- exact byte comparison instead of a case-insensitive one.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- One row per signed-in device. Rotating on every refresh means a stolen refresh
-- token is usable at most once, and re-use of an already-rotated token is
-- detectable - see `authService.refresh`.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_sessions (
  id             CHAR(36)    NOT NULL,
  user_id        CHAR(36)    NOT NULL,
  token_hash     CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at     DATETIME(3) NOT NULL,
  revoked_at     DATETIME(3) NULL DEFAULT NULL,
  revoked_reason VARCHAR(40) NULL DEFAULT NULL,
  last_used_at   DATETIME(3) NULL DEFAULT NULL,
  user_agent     VARCHAR(255) NULL DEFAULT NULL,
  ip_address     VARCHAR(45) NULL DEFAULT NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY refresh_sessions_token_hash_key (token_hash),
  -- "revoke every session for this user" and "how many are active" are both
  -- answered from this index.
  KEY refresh_sessions_user_idx (user_id, revoked_at, expires_at),
  CONSTRAINT refresh_sessions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Email-address confirmation.
--
-- `redirect_to` is the deep link the link in the email bounces through, exactly
-- as `emailRedirectTo` was passed to Supabase's `signUp`. It is stored per token
-- rather than taken from the request at click time, so the redirect target
-- cannot be influenced by whoever opens the link.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          CHAR(36)    NOT NULL,
  user_id     CHAR(36)    NOT NULL,
  token_hash  CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  redirect_to VARCHAR(255) NULL DEFAULT NULL,
  expires_at  DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL DEFAULT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY email_verification_tokens_token_hash_key (token_hash),
  KEY email_verification_tokens_user_idx (user_id, consumed_at, expires_at),
  CONSTRAINT email_verification_tokens_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Password recovery. A successful reset consumes the token, sets the new hash
-- and revokes every refresh session for the account in one transaction, so a
-- password change really does sign other devices out.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          CHAR(36)    NOT NULL,
  user_id     CHAR(36)    NOT NULL,
  token_hash  CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  redirect_to VARCHAR(255) NULL DEFAULT NULL,
  expires_at  DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL DEFAULT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY password_reset_tokens_token_hash_key (token_hash),
  KEY password_reset_tokens_user_idx (user_id, consumed_at, expires_at),
  CONSTRAINT password_reset_tokens_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
