-- =============================================================================
-- Unihood migration 0002 - interests and the profile_interests join table
--
-- Ported from supabase/migrations/20261010120100_phase2_interests.sql.
--
-- Interests stay a server-owned vocabulary: the API exposes a read-only
-- `GET /api/interests` and never an insert. Unknown, inactive or duplicated ids
-- are rejected on write, so a member cannot invent a filter or attach a category
-- that does not exist.
--
-- The ids are identical to the Phase 1 client vocabulary in
-- `src/types/interest.ts` (plus fitness / reading / photography), so the mock
-- Groups and Events catalogs and the live People filters keep speaking the same
-- language.
-- =============================================================================

CREATE TABLE IF NOT EXISTS interests (
  id         VARCHAR(40) NOT NULL,
  name       VARCHAR(40) NOT NULL,
  is_active  TINYINT(1)  NOT NULL DEFAULT 1,
  sort_order INT         NOT NULL DEFAULT 100,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY interests_name_key (name),
  -- `id` arrives from clients as a filter or a selection, so its shape is
  -- constrained here rather than trusted.
  CONSTRAINT interests_id_format_chk CHECK (id REGEXP '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT interests_name_length_chk CHECK (CHAR_LENGTH(TRIM(name)) BETWEEN 2 AND 40),
  CONSTRAINT interests_is_active_chk CHECK (is_active IN (0, 1))
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- Idempotent seed: re-running refreshes labels and ordering without deleting a
-- row that a profile still references.
INSERT INTO interests (id, name, sort_order, is_active) VALUES
  ('sports', 'Sports', 10, 1),
  ('coding', 'Coding', 20, 1),
  ('music', 'Music', 30, 1),
  ('movies', 'Film & TV', 40, 1),
  ('study', 'Study', 50, 1),
  ('art', 'Art & Design', 60, 1),
  ('food', 'Food', 70, 1),
  ('gaming', 'Gaming', 80, 1),
  ('travel', 'Travel', 90, 1),
  ('volunteering', 'Volunteering', 100, 1),
  ('fitness', 'Fitness', 110, 1),
  ('reading', 'Reading', 120, 1),
  ('photography', 'Photography', 130, 1)
AS seed
ON DUPLICATE KEY UPDATE
  name       = seed.name,
  sort_order = seed.sort_order,
  is_active  = seed.is_active;

CREATE TABLE IF NOT EXISTS profile_interests (
  user_id     CHAR(36)    NOT NULL,
  interest_id VARCHAR(40) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- The composite primary key makes a duplicate selection impossible.
  PRIMARY KEY (user_id, interest_id),
  -- The reverse direction ("who picked `music`?") is what discovery filters on,
  -- so it needs its own index; the primary key only serves the forward direction.
  KEY profile_interests_interest_idx (interest_id, user_id),
  CONSTRAINT profile_interests_user_fk
    FOREIGN KEY (user_id) REFERENCES profiles (user_id) ON DELETE CASCADE,
  CONSTRAINT profile_interests_interest_fk
    FOREIGN KEY (interest_id) REFERENCES interests (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
