-- =============================================================================
-- Unihood migration 0010 - a group's single primary interest (Phase 6).
--
-- Phase 6 asks discovery to be *interest-matched* as well as location-based: the
-- Nearby listings rank a group that shares an interest with the viewer above one
-- that is merely closer, and the mobile form lets the owner say what the group is
-- about in the same vocabulary the members picked their own interests from.
--
-- One column, and three deliberate choices behind it:
--
--   * **Nullable, no default value.** NULL is "the owner picked no interest", not
--     "general": a group with no interest stays visible in every listing and is
--     simply ranked after the matching ones. Making it required would have made
--     `0006`'s existing rows - and every group created before this migration -
--     suddenly invalid, which is exactly the drift a migration must not cause.
--
--   * **`VARCHAR(40)`, matching `interests.id` exactly** (migration 0002 declares
--     it `VARCHAR(40)` with a format CHECK). A foreign key requires the two sides
--     to agree on length and collation, so this is not a style choice - a mismatch
--     is `ER_FK_INCOMPATIBLE_COLUMNS`.
--
--   * **A real foreign key rather than a CHECK.** The catalogue is the authority
--     on which interests exist, and an FK is the only constraint that says so
--     without restating the list: the API still validates against
--     `interests` (`activeInterestIds`) so a bad value gets a sentence, but the
--     database refuses to hold an interest that the catalogue does not have.
--     `ON DELETE SET NULL` because retiring an interest from the catalogue must
--     never fail (or silently take a group with it); the row would simply become
--     "no interest", which is a state the product already handles.
--
--   * **`groups_interest_idx (interest_id, archived_at)`** serves the new filter
--     (`WHERE interest_id IN (...) AND archived_at IS NULL`), which is the shape
--     the interest-filtered Nearby query uses.
--
-- MySQL 8.0 has no `ADD COLUMN IF NOT EXISTS`, so this file is not idempotent by
-- itself; `schema_migrations` is what keeps it from running twice.
-- =============================================================================

ALTER TABLE `groups`
  ADD COLUMN interest_id VARCHAR(40) NULL DEFAULT NULL AFTER category,
  ADD KEY groups_interest_idx (interest_id, archived_at),
  ADD CONSTRAINT groups_interest_fk
    FOREIGN KEY (interest_id) REFERENCES interests (id)
    ON DELETE SET NULL;
