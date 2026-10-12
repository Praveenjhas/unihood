-- =============================================================================
-- Unihood migration 0007 - persistent events and RSVPs (Phase 4).
--
-- Three tables:
--
--   * `events`          - the event itself: what it is, when it runs, where it
--                         says it is, who created it and the group it may belong
--                         to.
--   * `event_locations` - the geographic anchor, in its own table for exactly the
--                         reasons `group_locations` is (see migration 0006): an
--                         event without coordinates is a *missing row* rather
--                         than an unindexed NULL point, "discoverable near a
--                         point" is an INNER JOIN, and there is no nullable
--                         spatial column whose index behaviour has to be reasoned
--                         about. The same decision is reused here rather than
--                         inventing a second convention.
--   * `event_rsvps`     - who is going, in what state, and when they said so.
--
-- Nothing about users, profiles, groups or geographic membership is duplicated:
-- `events.created_by` points at `users`, `events.group_id` points at `groups`,
-- and every access rule is derived from those rows at request time.
--
-- Group association and visibility
--   An event has an optional `group_id` and NO visibility column of its own. That
--   is deliberate: a group event inherits its group's visibility and audience, so
--   there is no independent flag that could accidentally make a private group's
--   event public. A standalone event (`group_id IS NULL`) is discoverable by any
--   eligible authenticated member. `src/services/eventService.ts` is where the
--   rule lives; the schema simply refuses to hold a second answer.
--
-- Timestamps
--   Every timestamp is `DATETIME(3)` and the API pins each connection to
--   `+00:00` (see `src/db/pool.ts`), so the stored instant is UTC and the wire
--   format is ISO 8601 UTC. The client renders it in the device's own timezone.
--
-- Deletion strategy
--   An event is never DELETE'd, it is *cancelled*: `status = 'cancelled'` with
--   `cancelled_at` set. The RSVP rows survive, so attendance history stays
--   readable while every listing, RSVP and edit path refuses a cancelled event.
--   `events_cancelled_chk` pins the invariant that the two columns agree, so a
--   half-cancelled row cannot exist.
--
-- MySQL 8.0 has no `ADD COLUMN IF NOT EXISTS`, so this migration is not
-- idempotent by itself; `schema_migrations` is what keeps it from running twice.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The event.
--
-- `category` and `status` are VARCHAR + CHECK rather than ENUM, matching
-- `groups`: the vocabulary is owned by the API (`src/domain/events.ts`), a CHECK
-- renders the allowed set directly in the schema, and zod validates it again at
-- the edge so a client can never widen it.
--
-- `max_participants` NULL means "no capacity limit" - a different thing from a
-- limit of zero, which `events_capacity_chk` refuses.
--
-- The three indexes are the reads the API actually makes: upcoming listings
-- (`status`, `start_at`), a group's own upcoming events (`group_id`, `status`),
-- and "events I created" (`created_by`, `start_at`).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id               CHAR(36)     NOT NULL,
  title            VARCHAR(80)  NOT NULL,
  description      VARCHAR(600) NOT NULL,
  category         VARCHAR(32)  NOT NULL,
  start_at         DATETIME(3)  NOT NULL,
  end_at           DATETIME(3)  NOT NULL,
  location_label   VARCHAR(120) NULL DEFAULT NULL,
  created_by       CHAR(36)     NOT NULL,
  group_id         CHAR(36)     NULL DEFAULT NULL,
  max_participants INT UNSIGNED NULL DEFAULT NULL,
  status           VARCHAR(12)  NOT NULL DEFAULT 'scheduled',
  cancelled_at     DATETIME(3)  NULL DEFAULT NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY events_upcoming_idx (status, start_at, end_at),
  KEY events_group_idx (group_id, status, start_at),
  KEY events_creator_idx (created_by, start_at),
  CONSTRAINT events_creator_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT events_group_fk FOREIGN KEY (group_id) REFERENCES `groups` (id) ON DELETE CASCADE,
  CONSTRAINT events_title_length_chk CHECK (CHAR_LENGTH(TRIM(title)) BETWEEN 3 AND 80),
  CONSTRAINT events_description_length_chk CHECK (CHAR_LENGTH(TRIM(description)) BETWEEN 1 AND 600),
  CONSTRAINT events_category_chk
    CHECK (category IN ('sports', 'coding', 'study', 'social', 'music', 'arts', 'gaming', 'travel', 'general')),
  CONSTRAINT events_status_chk CHECK (status IN ('scheduled', 'cancelled')),
  CONSTRAINT events_window_chk CHECK (end_at > start_at),
  CONSTRAINT events_capacity_chk CHECK (max_participants IS NULL OR max_participants BETWEEN 1 AND 10000),
  CONSTRAINT events_location_label_length_chk
    CHECK (location_label IS NULL OR CHAR_LENGTH(TRIM(location_label)) BETWEEN 1 AND 120),
  CONSTRAINT events_cancelled_chk CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- The geographic anchor - exactly the spatial design of `group_locations` and
-- `user_locations` (migration 0003), for the same measured reasons:
--
--   * `POINT NOT NULL SRID 0` with `POINT(longitude, latitude)`. The SRID 0
--     attribute is what makes the optimizer use the SPATIAL index for the
--     bounding-box predicate (`MBRContains`); on a plain `POINT` column the same
--     predicate degrades to `type=ALL`.
--   * the denormalised, rounded `latitude` / `longitude` decimals carry the same
--     4-decimal (~11 m) precision, and make the stored value auditable without
--     decoding the geometry.
--
-- The CHECK rejects only the exact (0, 0) "no fix" reading rather than every
-- zero coordinate: 0 is a real longitude (Greenwich) and a real latitude (the
-- equator) for a *venue*, whereas for a handset it means "no reading at all".
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_locations (
  event_id            CHAR(36)     NOT NULL,
  latitude            DECIMAL(8,4) NOT NULL,
  longitude           DECIMAL(8,4) NOT NULL,
  location            POINT        NOT NULL SRID 0,
  location_updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (event_id),
  SPATIAL KEY event_locations_location_sx (location),
  CONSTRAINT event_locations_event_fk
    FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE,
  CONSTRAINT event_locations_latitude_chk CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT event_locations_longitude_chk CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT event_locations_not_origin_chk CHECK (NOT (latitude = 0 AND longitude = 0))
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- RSVPs: one row per (event, member) pair, forever.
--
-- The UNIQUE key makes a duplicate RSVP structurally impossible, and a state
-- change is an UPDATE of `status`, never a second row and never a DELETE. That
-- choice is documented here because it is load-bearing:
--
--   * "am I going?" is one indexed lookup;
--   * the going count is `SELECT COUNT(*) ... WHERE status = 'going'`, so a
--     cancelled RSVP stops counting immediately;
--   * cancelling and joining a second time updates the *same* row, which is what
--     makes a repeated RSVP request idempotent instead of duplicating a member
--     on the guest list;
--   * when a member loses access to a private group, their row survives - the
--     history is intact - but every read path re-checks membership, so the row is
--     invisible to them and does not appear in their Going list.
--
-- `event_rsvps_cancelled_chk` pins the same two-column invariant as `events`.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_rsvps (
  id           CHAR(36)    NOT NULL,
  event_id     CHAR(36)    NOT NULL,
  user_id      CHAR(36)    NOT NULL,
  status       VARCHAR(10) NOT NULL DEFAULT 'going',
  rsvped_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelled_at DATETIME(3) NULL DEFAULT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY event_rsvps_event_user_key (event_id, user_id),
  KEY event_rsvps_event_status_idx (event_id, status, rsvped_at),
  KEY event_rsvps_user_status_idx (user_id, status, rsvped_at),
  CONSTRAINT event_rsvps_event_fk FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE,
  CONSTRAINT event_rsvps_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT event_rsvps_status_chk CHECK (status IN ('going', 'cancelled')),
  CONSTRAINT event_rsvps_cancelled_chk CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
