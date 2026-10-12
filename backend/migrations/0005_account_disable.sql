-- =============================================================================
-- Unihood migration 0005 - the account disable switch
--
-- `authService` reads `users.disabled_at` on every sign-in and every refresh, and
-- `requireAuth` joins it on every authenticated request. Migration 0001 created
-- `users` without the column, so the very first read failed with
-- ER_BAD_FIELD_ERROR (1054): registration answered 500 and nothing that touches
-- an account could work. This migration adds what the code was written against,
-- and `assertSchemaReady` now checks for it at startup so the same gap can never
-- again appear as a mysterious 500.
--
-- Why a new file rather than a fix to 0001: the runner stores a checksum per
-- applied migration, so editing 0001 in place would report the file as *edited*
-- on every `db:status` and would never be applied to an existing database.
--
-- NULL means "enabled". A timestamp is the whole state - the same shape the
-- other lifecycle columns use (`email_verified_at`, `last_login_at`), so
-- "disabled since when?" is answerable without a second source of truth.
--
-- MySQL 8.0 has no `ADD COLUMN IF NOT EXISTS`, so this migration is not
-- idempotent by itself; `schema_migrations` is what keeps it from running twice.
-- =============================================================================

ALTER TABLE users
  ADD COLUMN disabled_at DATETIME(3) NULL DEFAULT NULL AFTER email_verified_at;
