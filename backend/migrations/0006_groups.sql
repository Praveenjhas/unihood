-- =============================================================================
-- Unihood migration 0006 - persistent groups, memberships and self-declared
-- audience eligibility (Phase 3).
--
-- Three tables and one column:
--
--   * `groups`            - the group itself: public/private, audience, category,
--                           a human-readable location label and an owner.
--   * `group_locations`   - the geographic anchor, in its own table so a group
--                           without coordinates is a *missing row* rather than an
--                           unindexed NULL point (see "Why a separate table").
--   * `group_memberships` - who is in a group, in what role, and in what state
--                           (pending / active / rejected / left / removed).
--   * `profiles.group_eligibility_gender` - the optional, private value that
--                           decides eligibility for men-only / women-only groups.
--
-- Why a separate location table
--   A group may legitimately have no coordinates: a private study crew that never
--   meets in one place is still a group, and the product asks for a location only
--   where one exists. Modelling that as a second table means "discoverable near a
--   point" is an INNER JOIN, an unlocated group is simply absent from that join,
--   and there is no nullable spatial column whose index behaviour has to be
--   reasoned about. The mobile "use my location" button writes this table only -
--   it never reads or copies the creator's `user_locations` row (asserted by the
--   smoke test).
--
-- Why `groups` is written with backticks everywhere
--   Verified on this server (MySQL 8.0.35):
--     SELECT reserved FROM information_schema.keywords WHERE word = 'GROUPS'
--   returns 1. GROUPS became a reserved word in MySQL 8.0.2 for window-function
--   frame clauses, so `CREATE TABLE groups (...)` is a syntax error and every
--   reference has to be quoted. The name is kept because it is the product's own
--   vocabulary; the quoting lives in the SQL of `src/services/groupService.ts`.
--
-- Exactly one owner per group, enforced by the database
--   MySQL has no partial unique index, so "one active owner row per group" is
--   expressed as a generated column that holds the group id only for the owner
--   row and NULL for every other membership. A UNIQUE index on it then permits any
--   number of NULLs but exactly one owner - the shape a partial index would give,
--   without a trigger (the application account has no TRIGGER privilege, by
--   design).
--
--   The column is VIRTUAL, and that is not cosmetic. Measured on this server:
--   a *STORED* generated column in a table makes InnoDB refuse every foreign key
--   on that table with ER_CANNOT_ADD_FOREIGN, even when the FKs are on ordinary
--   columns and their own indexes already exist. A VIRTUAL generated column has no
--   such restriction, and the UNIQUE index materialises it, so the guarantee is
--   enforced by the database exactly as intended.
--
-- Cascades
--   `groups.created_by` cascades from `users`, so deleting an account removes the
--   groups it created (and, through them, their memberships). `group_memberships`
--   cascades from both `groups` and `users`, so a member leaving the platform can
--   never leave a dangling row behind. `group_memberships.decided_by` is
--   `ON DELETE SET NULL`: the *decision* survives the administrator who made it,
--   which matters for the trail but must not block their account deletion.
--
-- MySQL 8.0 has no `ADD COLUMN IF NOT EXISTS`, so this migration is not
-- idempotent by itself; `schema_migrations` is what keeps it from running twice.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Self-declared eligibility, for men-only / women-only groups only.
--
-- NULL is the default and the honest answer for everyone: nothing in registration
-- or onboarding asks for this, and an `everyone` group accepts a member whatever
-- it says. It is read on the server for join / create decisions and is never part
-- of a public projection - `peopleService` does not select it, and the member list
-- endpoint deliberately omits it (both asserted in the smoke test). It is *not*
-- identity verification: it is what the member says about themselves, and no
-- document is ever collected.
--
-- `another` and `prefer_not_to_say` are stored rather than dropped: they are real
-- answers, and keeping them distinguishable from "never asked" (NULL) is what
-- lets the settings screen show the member their own choice back.
-- -----------------------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN group_eligibility_gender VARCHAR(20) NULL DEFAULT NULL AFTER nearby_discovery_enabled;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_group_eligibility_chk
    CHECK (group_eligibility_gender IS NULL
        OR group_eligibility_gender IN ('man', 'woman', 'another', 'prefer_not_to_say'));

-- -----------------------------------------------------------------------------
-- The group.
--
-- `category`, `visibility` and `audience` are VARCHAR + CHECK rather than ENUM:
-- the vocabulary is owned by the API (`src/domain/groups.ts`) and a CHECK renders
-- the allowed set directly in the schema, where an ENUM's member list is far
-- easier to read from `information_schema` than it is to reason about in a
-- migration diff. Every one of them is validated again in zod at the edge, so a
-- client can never widen the set.
--
-- `archived_at` is the deletion strategy: nothing is ever DELETE'd, so a group
-- that is taken down keeps its memberships - and their history - while every
-- discovery query, join and management action refuses it. A timestamp rather than
-- a flag answers "when was it taken down?" without a second source of truth, the
-- same shape `users.disabled_at` uses.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `groups` (
  id             CHAR(36)     NOT NULL,
  name           VARCHAR(60)  NOT NULL,
  description    VARCHAR(280) NOT NULL,
  category       VARCHAR(32)  NOT NULL,
  visibility     VARCHAR(10)  NOT NULL DEFAULT 'public',
  audience       VARCHAR(12)  NOT NULL DEFAULT 'everyone',
  location_label VARCHAR(80)  NULL DEFAULT NULL,
  created_by     CHAR(36)     NOT NULL,
  archived_at    DATETIME(3)  NULL DEFAULT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- Every listing filters "not archived" first, then narrows by category and
  -- visibility; this one index serves the directory and the nearby join.
  KEY groups_listing_idx (archived_at, category, visibility),
  -- "Groups I own" - the owner's own management surface.
  KEY groups_creator_idx (created_by, archived_at),
  CONSTRAINT groups_creator_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT groups_name_length_chk CHECK (CHAR_LENGTH(TRIM(name)) BETWEEN 3 AND 60),
  CONSTRAINT groups_description_length_chk CHECK (CHAR_LENGTH(TRIM(description)) BETWEEN 1 AND 280),
  CONSTRAINT groups_category_chk
    CHECK (category IN ('sports', 'coding', 'study', 'social', 'music', 'arts', 'gaming', 'travel', 'general')),
  CONSTRAINT groups_visibility_chk CHECK (visibility IN ('public', 'private')),
  CONSTRAINT groups_audience_chk CHECK (audience IN ('everyone', 'men_only', 'women_only')),
  CONSTRAINT groups_location_label_length_chk
    CHECK (location_label IS NULL OR CHAR_LENGTH(TRIM(location_label)) BETWEEN 1 AND 80)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- The geographic anchor - exactly the spatial design of `user_locations`
-- (migration 0003), for exactly the same measured reasons:
--
--   * `POINT NOT NULL SRID 0` with `POINT(longitude, latitude)`. The SRID 0
--     attribute is what makes the optimizer use the SPATIAL index for the
--     bounding-box predicate (`MBRContains`); on a plain `POINT` column the same
--     predicate degrades to `type=ALL`.
--   * the denormalised, rounded `latitude` / `longitude` decimals carry the same
--     4-decimal (~11 m) precision as a member's fix (a *place*, not a person),
--     and make the stored value auditable without decoding the geometry.
--
-- One deliberate difference from `user_locations`: the CHECK rejects only the
-- exact (0, 0) "no fix" reading rather than every zero coordinate, because 0 is a
-- real longitude (Greenwich) and a real latitude (the equator) for a place,
-- whereas for a handset it means "no reading at all".
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_locations (
  group_id            CHAR(36)     NOT NULL,
  latitude            DECIMAL(8,4) NOT NULL,
  longitude           DECIMAL(8,4) NOT NULL,
  location            POINT        NOT NULL SRID 0,
  location_updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (group_id),
  SPATIAL KEY group_locations_location_sx (location),
  CONSTRAINT group_locations_group_fk
    FOREIGN KEY (group_id) REFERENCES `groups` (id) ON DELETE CASCADE,
  CONSTRAINT group_locations_latitude_chk CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT group_locations_longitude_chk CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT group_locations_not_origin_chk CHECK (NOT (latitude = 0 AND longitude = 0))
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Membership, requests and the trail of who decided what.
--
-- One row per (group, user) pair, forever: the UNIQUE key makes a duplicate
-- membership structurally impossible rather than something the service has to
-- remember to check. A state change is an UPDATE of `status`, never a second row,
-- which is why a rejected request, a voluntary leave and a removed member are all
-- still visible to an administrator.
--
-- `owner_key` is the generated column described in the header: it holds the group
-- id for the single active owner row and NULL for everything else, so the UNIQUE
-- index turns "exactly one owner" into a database guarantee. An ownership change
-- therefore has to demote the old owner before promoting the new one, inside one
-- transaction - which is the ordering the service uses.
-- `group_memberships_active_joined_chk` pins the other invariant worth stating:
-- an ACTIVE membership always records when it became active. A request has no
-- `joined_at`, and `decided_at` / `decided_by` record the moment and the actor for
-- an approval, a rejection or a removal.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_memberships (
  id         CHAR(36)    NOT NULL,
  group_id   CHAR(36)    NOT NULL,
  user_id    CHAR(36)    NOT NULL,
  role       VARCHAR(10) NOT NULL DEFAULT 'member',
  status     VARCHAR(12) NOT NULL DEFAULT 'pending',
  joined_at  DATETIME(3) NULL DEFAULT NULL,
  decided_at DATETIME(3) NULL DEFAULT NULL,
  decided_by CHAR(36)    NULL DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  -- NULL for every non-owner row; the group id for the one active owner. VIRTUAL
  -- rather than STORED: see the header - a stored generated column would make
  -- InnoDB refuse every foreign key below it.
  owner_key  CHAR(36) GENERATED ALWAYS AS (
    CASE WHEN role = 'owner' AND status = 'active' THEN group_id ELSE NULL END
  ) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY group_memberships_group_user_key (group_id, user_id),
  UNIQUE KEY group_memberships_owner_key (owner_key),
  -- The three reads the management screens and the join path actually make:
  -- "who is active in this group", "the pending queue", "my memberships".
  KEY group_memberships_group_status_idx (group_id, status, role),
  KEY group_memberships_user_status_idx (user_id, status),
  KEY group_memberships_decider_idx (decided_by),
  CONSTRAINT group_memberships_group_fk
    FOREIGN KEY (group_id) REFERENCES `groups` (id) ON DELETE CASCADE,
  CONSTRAINT group_memberships_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT group_memberships_decider_fk
    FOREIGN KEY (decided_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT group_memberships_role_chk CHECK (role IN ('owner', 'admin', 'member')),
  CONSTRAINT group_memberships_status_chk
    CHECK (status IN ('pending', 'active', 'rejected', 'left', 'removed')),
  CONSTRAINT group_memberships_active_joined_chk
    CHECK (status <> 'active' OR joined_at IS NOT NULL)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;


