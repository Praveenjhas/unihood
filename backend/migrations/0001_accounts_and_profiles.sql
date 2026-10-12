-- =============================================================================
-- Unihood migration 0001 - accounts and profiles
--
-- Ported from supabase/migrations/20261010120000_phase2_profiles.sql.
--
-- What replaced what
--   * `auth.users` (Supabase-managed)          -> `users` (owned by this app).
--   * `public.profiles`                        -> `profiles`.
--   * the `handle_new_user` auth trigger       -> an INSERT in
--     `authService.register`, inside the same transaction as the account, so an
--     account still cannot exist without a profile.
--   * the `profiles_before_update` trigger     -> `ON UPDATE CURRENT_TIMESTAMP(3)`
--     (no stored procedures, so the app account needs no TRIGGER privilege).
--   * row level security                       -> the HTTP API, which is the only
--     process that holds a MySQL connection at all. There is no client-facing
--     database path, so "who may read this row" is decided in one place:
--     `src/services` (see README -> "Security model").
--
-- Deliberately absent, as in the original: no university, campus, academic year
-- or student-email columns. Unihood is a general location-based app.
--
-- MySQL notes (server 8.0.35 on this machine)
--   * utf8mb4 / utf8mb4_0900_ai_ci explicitly, rather than relying on the server
--     default, so a differently configured server produces the same schema.
--   * `email` is stored already lower-cased and is guarded by a CHECK, because
--     the collation is accent- and case-insensitive: the uniqueness rule should
--     be visible in the data, not only implied by the collation.
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id                CHAR(36)     NOT NULL,
  email             VARCHAR(254) NOT NULL,
  password_hash     VARCHAR(255) NOT NULL,
  display_name      VARCHAR(60)  NOT NULL,
  email_verified_at DATETIME(3)  NULL DEFAULT NULL,
  last_login_at     DATETIME(3)  NULL DEFAULT NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY users_email_key (email),
  CONSTRAINT users_email_lowercase_chk CHECK (email = LOWER(email)),
  CONSTRAINT users_email_shape_chk CHECK (email LIKE '%_@_%._%'),
  CONSTRAINT users_display_name_length_chk CHECK (CHAR_LENGTH(TRIM(display_name)) BETWEEN 1 AND 60),
  CONSTRAINT users_email_length_chk CHECK (CHAR_LENGTH(email) BETWEEN 3 AND 254)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- The public half of an account: everything another member may ever see.
--
-- `nearby_discovery_enabled` is the consent switch for storing a location fix;
-- the CHECK below mirrors the original constraint so a consent-less row can
-- never be written even by a future code path that forgets to check.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  user_id                  CHAR(36)     NOT NULL,
  display_name             VARCHAR(60)  NOT NULL DEFAULT 'New member',
  bio                      VARCHAR(280) NULL DEFAULT NULL,
  avatar_path              VARCHAR(512) NULL DEFAULT NULL,
  location_label           VARCHAR(80)  NULL DEFAULT NULL,
  is_discoverable          TINYINT(1)   NOT NULL DEFAULT 1,
  nearby_discovery_enabled TINYINT(1)   NOT NULL DEFAULT 0,
  profile_completed        TINYINT(1)   NOT NULL DEFAULT 0,
  created_at               DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  -- Discovery always filters on these two flags; without the index every search
  -- would read every profile.
  KEY profiles_discovery_idx (is_discoverable, nearby_discovery_enabled),
  CONSTRAINT profiles_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT profiles_display_name_length_chk
    CHECK (CHAR_LENGTH(TRIM(display_name)) BETWEEN 1 AND 60),
  CONSTRAINT profiles_location_label_length_chk
    CHECK (location_label IS NULL OR CHAR_LENGTH(TRIM(location_label)) BETWEEN 1 AND 80),
  CONSTRAINT profiles_flags_chk
    CHECK (is_discoverable IN (0, 1) AND nearby_discovery_enabled IN (0, 1) AND profile_completed IN (0, 1)),
  CONSTRAINT profiles_nearby_requires_discoverable_chk
    CHECK (nearby_discovery_enabled = 0 OR is_discoverable = 1),
  -- A storage *path*, never a URL: rejecting a scheme here means a crafted
  -- request can never make the client render an off-platform image.
  CONSTRAINT profiles_avatar_path_no_scheme_chk
    CHECK (avatar_path IS NULL OR LOCATE('://', avatar_path) = 0)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
