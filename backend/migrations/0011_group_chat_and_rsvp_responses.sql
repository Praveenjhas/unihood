-- =============================================================================
-- Unihood migration 0011 - persistent group chat and explicit RSVP responses
-- (Phase 7).
--
-- Two changes with one theme: what a member said is now remembered - in a group's
-- own history, and against an event.
--
--   * `group_messages` - the chat: who said what, in which group, and when.
--   * `event_rsvps`    - a third state, `not_going`, beside the existing `going`
--                        and `cancelled`.
--
-- -----------------------------------------------------------------------------
-- Chat
--
-- The table is deliberately tiny: an immutable id, the group, the sender, the
-- body and the moment. Everything else the chat UI shows - the sender's display
-- name, whether a message is the reader's own - is derived at read time from
-- `users` and the caller's id, so no denormalised copy of a name can go stale.
--
-- `group_id` cascades from `groups` and `sender_id` from `users`, so dropping an
-- account or a group can never leave an orphan message. Messages are *not* deleted
-- when a member leaves, and there is no delete endpoint in this phase: membership
-- is re-checked on every read, so a former member's messages stay in the group's
-- history while the former member simply cannot read them any more. An archived
-- group keeps its messages for the same reason - the rows are the record, and the
-- write paths are what refuse new ones.
--
-- `client_message_id` exists for exactly one reason: a double tap on Send, or a
-- retry after a dropped connection, must not create two identical messages. The
-- client attaches a fresh UUID to each message it *intends* to send, and the
-- UNIQUE key below turns a repeat into the same row rather than a second one. It
-- is nullable, and MySQL allows any number of NULLs in a UNIQUE index, so a
-- message sent without one is never rejected.
--
-- The indexes are the two reads the chat actually makes - "the newest N in this
-- group" and "the N before this cursor" - which are the same scan in opposite
-- directions, so one index serves both:
--
--   * `group_messages_group_created_idx (group_id, created_at, id)` - the
--     chronological history, and the keyset page built on `(created_at, id)`.
--     Its `group_id` prefix also satisfies the foreign key to `groups`, which is
--     why that key has no separate index.
--   * `group_messages_sender_idx (sender_id)` - the foreign key to `users`.
--   * `group_messages_sender_client_key (group_id, sender_id, client_message_id)` -
--     the idempotency guarantee described above.
--
-- `body` is `VARCHAR(1000)` with a `CHECK` on its length: 1000 characters is far
-- past a chat message and keeps the column inside InnoDB's row size, and the
-- CHECK states the bound in the schema rather than only in the API.
--
-- -----------------------------------------------------------------------------
-- RSVP responses
--
-- Phase 4 stored `going` and `cancelled`, where `cancelled` meant "the member
-- withdrew - they have no answer right now". Phase 7 adds `not_going`, which is a
-- *different* statement: the member looked at the event and declined. Keeping the
-- two apart is what lets the Events feed offer "Not going" as a filter next to
-- "Needs response", and it is why neither state ever counts towards capacity.
--
-- Only the CHECK constraint changes. **No row is rewritten**: every existing
-- `going` and `cancelled` row keeps exactly the meaning it had, so the response
-- history is untouched and there is nothing to reverse. `event_rsvps_cancelled_chk`
-- is left in place and stays correct for `not_going` - `cancelled_at` is NULL, so
-- both halves of the equivalence are false.
--

-- -----------------------------------------------------------------------------
-- The chat.
--
-- `created_at` defaults to the database's own clock, which the API pins to UTC on
-- every pooled connection (`src/db/pool.ts`), so the stored instant is UTC and the
-- wire format is ISO 8601 UTC - the same convention `events` and
-- `group_memberships` already follow.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS group_messages (
  id                CHAR(36)      NOT NULL,
  group_id          CHAR(36)      NOT NULL,
  sender_id         CHAR(36)      NOT NULL,
  body              VARCHAR(1000) NOT NULL,
  client_message_id CHAR(36)      NULL DEFAULT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY group_messages_sender_client_key (group_id, sender_id, client_message_id),
  KEY group_messages_group_created_idx (group_id, created_at, id),
  KEY group_messages_sender_idx (sender_id),
  CONSTRAINT group_messages_group_fk
    FOREIGN KEY (group_id) REFERENCES `groups` (id) ON DELETE CASCADE,
  CONSTRAINT group_messages_sender_fk
    FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT group_messages_body_chk CHECK (CHAR_LENGTH(body) BETWEEN 1 AND 1000)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- The third RSVP state.
--
-- Two statements because MySQL will not drop and re-add a named CHECK in one
-- `ALTER`. Nothing else about the table changes, and every existing row keeps its
-- meaning exactly as it was.
-- -----------------------------------------------------------------------------
ALTER TABLE event_rsvps
  DROP CHECK event_rsvps_status_chk;

ALTER TABLE event_rsvps
  ADD CONSTRAINT event_rsvps_status_chk CHECK (status IN ('going', 'not_going', 'cancelled'));
