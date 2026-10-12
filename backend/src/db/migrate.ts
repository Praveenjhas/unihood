/**
 * Migration runner.
 *
 *   npm run db:migrate     apply everything that is outstanding
 *   npm run db:status      list applied / pending without changing anything
 *
 * Behaviour worth knowing:
 *
 *   * `schema_migrations` is created on demand (it is not itself a migration)
 *     and records the version, the file name, a **checksum** and the moment it
 *     ran. Editing an already-applied file is therefore caught and refused
 *     rather than silently ignored - the classic way two environments drift.
 *   * Files are applied in filename order, one at a time, while holding a
 *     `GET_LOCK`, so two runners cannot interleave. The lock is explicit because
 *     MySQL DDL implicitly commits: wrapping statements in a transaction would
 *     suggest an atomicity that MySQL does not provide here.
 *   * A migration that fails aborts the run and names the file, so the database
 *     is never left half-way through the *next* file by a swallowed error.
 *
 * The connection used below enables `multipleStatements` so a whole file can be
 * sent at once. That flag belongs to this file's own connection; the API pool
 * never sets it.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';

import { env } from '../config/env';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');
const MIGRATION_FILE_PATTERN = /^(\d{4}_[a-z0-9_]+)\.sql$/;
const ADVISORY_LOCK_NAME = 'unihood_migrations';

const TRACKING_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(64)  NOT NULL,
  name       VARCHAR(191) NOT NULL,
  checksum   CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci
`;

interface MigrationFile {
  version: string;
  name: string;
  fileName: string;
  sql: string;
  checksum: string;
}

/**
 * Normalises line endings before hashing, so the checksum identifies the SQL
 * rather than the checkout: a clone with `core.autocrlf=true` must not look
 * like an edited migration.
 */
function checksumOf(source: string): string {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

async function readMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const files: MigrationFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (!match?.[1]) continue;

    const raw = await readFile(path.join(MIGRATIONS_DIR, entry.name), 'utf8');
    files.push({
      version: match[1],
      name: match[1].replace(/^\d{4}_/, ''),
      fileName: entry.name,
      sql: raw,
      checksum: checksumOf(raw),
    });
  }

  return files.sort((a, b) => a.version.localeCompare(b.version));
}

async function connect(): Promise<Connection> {
  return mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    multipleStatements: true,
    charset: 'utf8mb4_0900_ai_ci',
    timezone: 'Z',
  });
}

async function acquireLock(connection: Connection): Promise<void> {
  const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 30) AS acquired', [ADVISORY_LOCK_NAME]);
  if (Number(rows[0]?.acquired ?? 0) !== 1) {
    throw new Error('Another migration run is in progress (could not acquire the lock within 30 s).');
  }
}

async function appliedVersions(connection: Connection): Promise<Map<string, string>> {
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.map((row) => [String(row.version), String(row.checksum)]));
}

async function releaseLock(connection: Connection): Promise<void> {
  await connection.query('SELECT RELEASE_LOCK(?)', [ADVISORY_LOCK_NAME]).catch(() => undefined);
}

async function apply(connection: Connection, migration: MigrationFile): Promise<void> {
  process.stdout.write(`  applying ${migration.fileName} ... `);
  const startedAt = Date.now();

  await connection.query(migration.sql);
  await connection.query('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)', [
    migration.version,
    migration.name,
    migration.checksum,
  ]);

  process.stdout.write(`ok (${Date.now() - startedAt} ms)\n`);
}

async function run(): Promise<void> {
  const statusOnly = process.argv.includes('--status');
  const files = await readMigrationFiles();

  if (files.length === 0) {
    throw new Error(`No migration files found in ${MIGRATIONS_DIR}.`);
  }

  const connection = await connect();

  try {
    await connection.query(TRACKING_TABLE_SQL);
    const applied = await appliedVersions(connection);

    const pending = files.filter((file) => !applied.has(file.version));
    const edited = files.filter((file) => applied.has(file.version) && applied.get(file.version) !== file.checksum);

    console.log(`Migrations directory: ${MIGRATIONS_DIR}`);
    console.log(`Applied: ${applied.size}   Pending: ${pending.length}   Edited: ${edited.length}`);

    if (statusOnly) {
      for (const file of files) {
        const state = !applied.has(file.version)
          ? 'pending'
          : applied.get(file.version) === file.checksum
            ? 'applied'
            : 'EDITED SINCE APPLYING';
        console.log(`  ${file.version}  ${state.padEnd(20)} ${file.fileName}`);
      }
      return;
    }

    if (edited.length > 0) {
      throw new Error(
        'These migrations changed after they were applied:\n' +
          edited.map((file) => `  - ${file.fileName}`).join('\n') +
          '\nAdd a new migration instead of rewriting an applied one.',
      );
    }

    if (pending.length === 0) {
      console.log('Nothing to do - the schema is up to date.');
      return;
    }

    await acquireLock(connection);
    try {
      for (const migration of pending) {
        try {
          await apply(connection, migration);
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : String(caught);
          throw new Error(`Migration ${migration.fileName} failed: ${message}`);
        }
      }
    } finally {
      await releaseLock(connection);
    }

    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await connection.end();
  }
}

run()
  .then(() => undefined)
  .catch((caught: unknown) => {
    console.error(`\n${caught instanceof Error ? caught.message : String(caught)}`);
    process.exitCode = 1;
  });
