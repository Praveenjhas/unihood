-- =============================================================================
-- Unihood migration 0003 - private per-member location fix
--
-- Ported from supabase/migrations/20261010120200_phase2_locations.sql, where it
-- was PostGIS `geography(Point,4326)` + `ST_DWithin` + a GiST index.
--
-- MySQL 8.0.35 replacement, verified on this machine before this file was
-- written (see README -> "Spatial query design"):
--
--   * Column type    `POINT NOT NULL SRID 0`.
--                    The `SRID 0` attribute is not cosmetic: EXPLAIN shows the
--                    optimizer uses the SPATIAL index for the bounding-box
--                    predicate only when the column carries it. On a plain
--                    `POINT` column the same predicate degrades to `type=ALL`.
--                    SRID 0 is used rather than 4326 because both were verified
--                    to make `ST_Distance_Sphere` interpret the first coordinate
--                    as longitude, while SRID 0 keeps the bounding box plainly
--                    planar in degrees (see the design note in the README).
--   * Coordinate order POINT(longitude, latitude) - x = longitude, y = latitude.
--                    Verified: `ST_X(ST_GeomFromText('POINT(77.2 28.6)', 4326))`
--                    returns 77.2, and Delhi -> Noida measures 16827.8 m
--                    (true great-circle distance ~16.83 km) with longitude first.
--   * Short-range filter
--                    `MBRContains(envelope, location)` uses the spatial index
--                    (`type=range`, `key=user_locations_location_sx`), then the
--                    exact `ST_Distance_Sphere(...) <= radius` discards the
--                    corners of the box. The radius predicate on its own was
--                    verified to be a full scan, which is why the box exists.
--
-- Privacy
--   The row is never returned to anyone but its owner, and the owner never reads
--   it back either: the API answers with `locationUpdatedAt` only. Distances of
--   *other* members are computed server-side and rounded before they leave.
--
-- Consent
--   Supabase enforced consent with a trigger on `profiles`. Here the deletion is
--   part of the same transaction as the profile update in `profileService`, plus
--   `setMyLocation` refuses to write without consent - the same two-layer model,
--   without needing a TRIGGER privilege for the application account.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_locations (
  user_id             CHAR(36)     NOT NULL,
  -- Denormalised, rounded copies of the point. They are what the bounding box
  -- and the cheap numeric prefilter are computed from, and they make the stored
  -- precision auditable (4 decimal places ~= 11 m) without decoding the geometry.
  latitude            DECIMAL(8,4) NOT NULL,
  longitude           DECIMAL(8,4) NOT NULL,
  -- WGS84 degrees, longitude first.
  location            POINT        NOT NULL SRID 0,
  location_updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  SPATIAL KEY user_locations_location_sx (location),
  -- Every discovery query ignores fixes older than 24 h, so the freshness test
  -- should not require reading the geometry.
  KEY user_locations_freshness_idx (location_updated_at),
  CONSTRAINT user_locations_user_fk
    FOREIGN KEY (user_id) REFERENCES profiles (user_id) ON DELETE CASCADE,
  -- Mirrors `set_my_location`'s server-side bounds: finite, in range, and not
  -- the (0, 0) "no fix" default that a dead GPS hands out.
  CONSTRAINT user_locations_latitude_chk
    CHECK (latitude BETWEEN -90 AND 90 AND latitude <> 0),
  CONSTRAINT user_locations_longitude_chk
    CHECK (longitude BETWEEN -180 AND 180 AND longitude <> 0)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;
