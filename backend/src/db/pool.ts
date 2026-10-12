/**
 * The single MySQL connection pool.
 *
 * Design notes that matter to correctness rather than taste:
 *
 *   * **`timezone: 'Z'` plus an explicit session time zone.** Every timestamp
 *     column is `DATETIME(3)`, which stores no zone at all. Left alone, the
 *     server's `time_zone` would be `SYSTEM` (local time on this machine) while
 *     the driver formatted incoming values as UTC - two different clocks in one
 *     table. The `connection` hook below pins each connection to `+00:00` before
 *     it is handed out, and `assertUtcSession` (used by `db:check` and the health
 *     endpoint) proves it actually took effect instead of assuming it did.
 *
 *   * **`decimalNumbers: true`.** `latitude` / `longitude` are `DECIMAL(8,4)`.
 *     Without this they arrive as strings, and `"77.2090" * 1` silently works
 *     while `"77.2090" + 1` concatenates. Numbers are the only useful shape here.
 *
 *   * **Parameterised queries everywhere.** There is no string-built SQL in this
 *     codebase except for `IN (?, ?, ?)` placeholder lists whose *values* are
 *     still bound, and `LIMIT ? OFFSET ?` which mysql2 supports with numbers.
 *
 * `mysql2/promise`'s pool is lazy: nothing connects until the first query, so
 * importing this module never performs I/O.
 */
import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';

import { env } from '../config/env';

export type { PoolConnection, ResultSetHeader, RowDataPacket };

export const pool: Pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,

  waitForConnections: true,
  connectionLimit: env.db.connectionLimit,
  queueLimit: 0,

  charset: 'utf8mb4_0900_ai_ci',
  timezone: 'Z',
  decimalNumbers: true,
  supportBigNumbers: true,
  enableKeepAlive: true,
  // Named placeholders stay off: `?` positional binding is what every query in
  // `src/services` is written against, and mixing the two is a bug factory.
  namedPlaceholders: false,
});

/**
 * Pins every new connection to UTC.
 *
 * `connection` fires before the connection joins the pool's free list, so the
 * `SET` is queued ahead of whatever query the pool hands this connection next -
 * there is no window in which a caller can observe the server's local clock.
 */
pool.on('connection', (connection: PoolConnection) => {
  connection.query("SET SESSION time_zone = '+00:00'");
});

/** Reads and writes that must not be split across a failure. */
export async function withTransaction<T>(run: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    try {
      const result = await run(connection);
      await connection.commit();
      return result;
    } catch (caught) {
      await connection.rollback().catch(() => undefined);
      throw caught;
    }
  } finally {
    connection.release();
  }
}

export interface DatabaseProbe {
  connected: boolean;
  serverVersion: string;
  database: string;
  /** `@@session.time_zone` on a pooled connection - must be `+00:00`. */
  sessionTimeZone: string;
  latencyMs: number;
}

/**
 * Connectivity check for the health endpoint and `npm run db:check`.
 *
 * Deliberately returns only non-sensitive facts: the server version, the schema
 * name, the session time zone and a round-trip time. Credentials, hosts and
 * connection strings are never part of the result, so this is safe to expose.
 */
export async function probeDatabase(): Promise<DatabaseProbe> {
  const startedAt = Date.now();
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT VERSION() AS server_version, DATABASE() AS database_name, @@session.time_zone AS session_time_zone',
  );

  const row = rows[0];
  return {
    connected: true,
    serverVersion: String(row?.server_version ?? 'unknown'),
    database: String(row?.database_name ?? 'unknown'),
    sessionTimeZone: String(row?.session_time_zone ?? 'unknown'),
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Asserts the UTC pin actually stuck. Called from `db:check` and the server's
 * startup so the assumption is verified on the real server rather than trusted.
 */
export async function assertUtcSession(): Promise<void> {
  const probe = await probeDatabase();
  if (probe.sessionTimeZone !== '+00:00') {
    throw new Error(
      `Expected the MySQL session time zone to be '+00:00' but found '${probe.sessionTimeZone}'. ` +
        'Timestamps would be stored in two different clocks. Check the pool connection hook in src/db/pool.ts.',
    );
  }
}

/** Every table the migrations create. Startup refuses to run without them. */
const REQUIRED_TABLES = [
  'users',
  'profiles',
  'interests',
  'profile_interests',
  'user_locations',
  'refresh_sessions',
  'email_verification_tokens',
  'password_reset_tokens',
  'schema_migrations',
  // Phase 3. `groups` is a reserved word, but this list is only ever compared
  // against `information_schema.tables`, so no quoting is needed here.
  'groups',
  'group_locations',
  'group_memberships',
  // Phase 4-5 tables, and Phase 7's chat. Kept in one list so a checkout that has
  // not migrated fails at startup with the file to run rather than at the endpoint.
  'events',
  'event_locations',
  'event_rsvps',
  'otp_challenges',
  'group_messages',
] as const;

/**
 * Fails with an actionable message when the migrations have not been applied.
 *
 * Without this the API would start happily and then answer every request with a
 * 500 about a missing table - which reads like a code bug rather than a setup
 * step. Table names are read from `information_schema`, and the comparison is
 * lower-cased because this server runs with `lower_case_table_names=1`.
 */
export async function assertSchemaReady(): Promise<void> {
  const placeholders = REQUIRED_TABLES.map(() => '?').join(', ');
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT table_name AS name
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN (${placeholders})`,
    [...REQUIRED_TABLES],
  );

  const present = new Set(rows.map((row) => String(row.name).toLowerCase()));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));

  if (missing.length > 0) {
    throw new Error(
      `The "${env.db.database}" schema is missing: ${missing.join(', ')}.\n` +
        'Run "npm run db:migrate" in the backend directory, then start the API again.',
    );
  }

  await assertColumnsReady();
}

/**
 * The columns a compiled build actually selects.
 *
 * A missing *table* is loud and obvious; a missing *column* is not - MySQL
 * reports it only when the query runs, so it surfaces as a 500 on the one
 * endpoint that reads it. That is exactly what happened when
 * `users.disabled_at` was absent from migration 0001: registration failed with
 * "Unknown column", and it took a server log to see why. The list below is the
 * read-critical set for authentication and location, and the check is one
 * `information_schema` query at startup - the cost is paid once, in exchange for
 * a first-class error message instead of a mystery 500.
 */
const REQUIRED_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['users', 'email'],
  ['users', 'password_hash'],
  ['users', 'display_name'],
  ['users', 'email_verified_at'],
  ['users', 'disabled_at'],
  ['users', 'last_login_at'],
  // Phase 5 - phone sign-in. `password_hash` is checked above even though it is
  // nullable now: the column still has to exist for the legacy email endpoints.
  ['users', 'phone_e164'],
  ['users', 'phone_verified_at'],
  ['profiles', 'display_name'],
  ['profiles', 'is_discoverable'],
  ['profiles', 'nearby_discovery_enabled'],
  ['profiles', 'group_eligibility_gender'],
  ['profiles', 'profile_completed'],
  ['profile_interests', 'interest_id'],
  ['interests', 'category'],
  ['user_locations', 'latitude'],
  ['user_locations', 'longitude'],
  ['user_locations', 'location'],
  ['user_locations', 'location_updated_at'],
  ['refresh_sessions', 'token_hash'],
  ['refresh_sessions', 'expires_at'],
  ['refresh_sessions', 'revoked_at'],
  ['refresh_sessions', 'revoked_reason'],
  ['refresh_sessions', 'last_used_at'],
  ['email_verification_tokens', 'token_hash'],
  ['email_verification_tokens', 'consumed_at'],
  ['email_verification_tokens', 'redirect_to'],
  ['password_reset_tokens', 'token_hash'],
  ['password_reset_tokens', 'consumed_at'],
  // Phase 3 - the columns `groupService` selects on every group request.
  ['groups', 'name'],
  ['groups', 'description'],
  ['groups', 'category'],
  // Phase 6 - the group's single primary interest (migration 0010). NULL means
  // "the owner picked none", which is a legitimate answer, so the guard checks
  // that the column exists rather than that it is filled.
  ['groups', 'interest_id'],
  ['groups', 'visibility'],
  ['groups', 'audience'],
  ['groups', 'location_label'],
  ['groups', 'created_by'],
  ['groups', 'archived_at'],
  ['group_locations', 'latitude'],
  ['group_locations', 'longitude'],
  ['group_locations', 'location'],
  ['group_memberships', 'group_id'],
  ['group_memberships', 'user_id'],
  ['group_memberships', 'role'],
  ['group_memberships', 'status'],
  ['group_memberships', 'joined_at'],
  // Phase 4 - the columns `eventService` selects on every event request.
  ['events', 'title'],
  ['events', 'description'],
  ['events', 'category'],
  ['events', 'start_at'],
  ['events', 'end_at'],
  ['events', 'location_label'],
  ['events', 'created_by'],
  ['events', 'group_id'],
  ['events', 'max_participants'],
  ['events', 'status'],
  ['events', 'cancelled_at'],
  ['event_locations', 'latitude'],
  ['event_locations', 'longitude'],
  ['event_locations', 'location'],
  ['event_rsvps', 'event_id'],
  ['event_rsvps', 'user_id'],
  ['event_rsvps', 'status'],
  ['event_rsvps', 'rsvped_at'],
  // Phase 5 - the columns `otpService` reads and writes on every code.
  ['otp_challenges', 'phone_e164'],
  ['otp_challenges', 'code_hash'],
  ['otp_challenges', 'attempts'],
  ['otp_challenges', 'max_attempts'],
  ['otp_challenges', 'expires_at'],
  ['otp_challenges', 'consumed_at'],
  ['otp_challenges', 'superseded_at'],
  ['otp_challenges', 'requested_ip'],
  // Phase 7 - the columns `chatService` reads and writes on every message.
  // `group_messages` is a new table and a *read-critical* one: a missing column
  // there would surface as a 500 on the chat screen rather than as a setup error.
  ['group_messages', 'group_id'],
  ['group_messages', 'sender_id'],
  ['group_messages', 'body'],
  ['group_messages', 'client_message_id'],
  ['group_messages', 'created_at'],
];

async function assertColumnsReady(): Promise<void> {
  const tables = [...new Set(REQUIRED_COLUMNS.map(([table]) => table))];
  const placeholders = tables.map(() => '?').join(', ');

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT table_name AS tableName, column_name AS columnName
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name IN (${placeholders})`,
    [...tables],
  );

  const present = new Set(
    rows.map((row) => `${String(row.tableName).toLowerCase()}.${String(row.columnName).toLowerCase()}`),
  );
  const missing = REQUIRED_COLUMNS.filter(([table, column]) => !present.has(`${table}.${column}`));

  if (missing.length > 0) {
    throw new Error(
      `The "${env.db.database}" schema is missing ${missing.length} column(s) the API reads: ` +
        `${missing.map(([table, column]) => `${table}.${column}`).join(', ')}.\n` +
        'Run "npm run db:migrate" in the backend directory, then start the API again.',
    );
  }
}
