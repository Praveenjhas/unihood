-- =============================================================================
-- Unihood migration 0012 - a saved nearby area is persistent
--
-- The product rule this records: a stored fix is not a cache. It stays exactly
-- where its owner left it until they replace it, switch nearby discovery off
-- (which `profileService` turns into the same delete, inside the transaction that
-- writes the profile) or close the account - where the foreign key cascades.
--
-- `setMyLocation` never filtered on age, and once the old 24-hour freshness rule
-- was removed nothing ordered or filtered by `location_updated_at` at all:
--
--   * the write throttle reads the column through the PRIMARY KEY (`user_id`), so
--     it uses the clustered index, not this one;
--   * every discovery query joins `user_locations` on `user_id`;
--   * both `SELECT`s that read the timestamp are single-row lookups.
--
-- So `user_locations_freshness_idx` (0003) had no reader left, and its comment
-- still described the rule that had been deleted - the one thing in the schema
-- that said a fix expires. It is dropped here rather than by editing 0003,
-- because an applied migration is checksummed and the runner refuses a rewritten
-- file (see README -> Migrations). The *column* stays: it is what the profile
-- answers with (`locationUpdatedAt`, rendered as "Saved 3 days ago"), what the
-- throttle measures, and what a future "update your area" nudge would read.
--
-- Nothing else moves, and nothing else may: no coordinate changes, no
-- `group_locations` or `event_locations` row is read or written, and no
-- membership is touched. A group's geographic anchor belongs to the group and is
-- independent of its owner's area (see README -> Privacy and the location model).
-- =============================================================================

-- MySQL 8 has no `DROP INDEX IF EXISTS`, so the index is looked up first and the
-- DDL is built only when it is still there. That keeps the migration replayable
-- against a database where it was already removed by hand, which is the same
-- property 0003's `CREATE TABLE IF NOT EXISTS` gives the rest of the schema.
SET @drop_freshness_index := (
  SELECT IF(
    COUNT(*) > 0,
    'ALTER TABLE user_locations DROP INDEX user_locations_freshness_idx',
    'SELECT 1'
  )
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'user_locations'
    AND index_name = 'user_locations_freshness_idx'
);

PREPARE drop_freshness_index FROM @drop_freshness_index;
EXECUTE drop_freshness_index;
DEALLOCATE PREPARE drop_freshness_index;
