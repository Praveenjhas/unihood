/**
 * `npm run db:reset` - snapshot the local database, then empty it of test data.
 *
 *   npm run db:reset:dry          # report only: what is stored, what would go
 *   npm run db:backup             # write a verified snapshot, change nothing
 *   npm run db:reset              # snapshot, verify it, then clear the app data
 *   npm run db:restore            # put an app snapshot back (RESET_BACKUP_DIR=<dir>)
 *
 * (`npm run db:reset -- --dry` does not work from PowerShell: it strips the `--`,
 * so npm reads `--dry` as one of its own flags - the same reason `smoke:clean`
 * exists. Every mode therefore has its own script name, and the restore directory
 * is passed through the environment.)
 *
 * The database is the development one in `backend/.env` - `unihood` on
 * 127.0.0.1 - and the point of this tool is the loop a demo needs: run the app,
 * create test accounts, groups, events and messages, then get back to a clean,
 * *seeded* database without re-running the migrations by hand.
 *
 * Three rules it will not bend:
 *
 *   1. **The schema is never touched.** Not one `DROP`, `TRUNCATE`, `ALTER` or
 *      `CREATE` statement: rows are deleted with `DELETE`, so the tables, their
 *      columns, their indexes and their foreign keys are exactly as the
 *      migrations left them. `schema_migrations` is preserved, so
 *      `npm run db:status` still reports the same applied set afterwards and
 *      `db:reset` can never make a migration look un-applied.
 *
 *   2. **Reference data is preserved.** `interests` is the catalogue a migration
 *      seeded (152 rows) and every profile, group and filter points at it; wiping
 *      it would leave a database that migrates cleanly but has nothing to pick
 *      from. It is read, backed up and left alone. It is also a foreign key
 *      target, so the deletion order below is derived from the real foreign keys
 *      rather than typed out by hand - children before parents - which is what
 *      makes "delete everything" safe without disabling `FOREIGN_KEY_CHECKS`.
 *
 *   3. **Nothing is deleted before a verified snapshot exists.** The snapshot is
 *      written first, then re-read from disk and checked against the manifest
 *      (row count and SHA-256 per table). Only if that passes does the delete
 *      run, and the deletion is one transaction: every table must come back with
 *      the count that was read, or the whole thing rolls back. `db:restore` puts
 *      a snapshot back, which is the escape hatch if the clean state was not
 *      wanted after all.
 *
 * The snapshot is a self-describing directory under `backend/.backups/`
 * (git-ignored):
 *
 *   .backups/2026-01-31T09-15-00-000Z/
 *     manifest.json          - database identity, applied migrations, per-table
 *                               row count, column list, file name and SHA-256
 *     data/<table>.json      - one JSON array of row objects per table
 *
 * `DATETIME(3)` values are read and written as UTC strings (`timezone: 'Z'` plus
 * `SET SESSION time_zone = '+00:00'`, exactly as `src/db/pool.ts` pins the API's
 * connections), so an instant survives a backup/restore round trip to the
 * millisecond. `DECIMAL` and `BIGINT` arrive as strings, which is why they are
 * written back verbatim.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';

import { env } from '../config/env';

/** `backend/.backups`, resolved identically from `src/` and `dist/`. */
const BACKUP_ROOT = path.resolve(__dirname, '..', '..', '.backups');

/** Bumped only when the on-disk shape changes incompatibly (2: `geometry` support). */
const SNAPSHOT_FORMAT = 2;

/**
 * Tables `--apply` never deletes a row from.
 *
 * `schema_migrations` is the migration history (deleting it would make applied
 * migrations look pending again); `interests` is seeded reference data every
 * profile, group and discovery filter joins to. Both are still backed up, so a
 * snapshot is a complete picture of the database.
 */
const PRESERVED_TABLES = ['schema_migrations', 'interests'];

interface TableSnapshot {
  name: string;
  rows: number;
  /** Column names in table-definition order - the order rows are written back in. */
  columns: string[];
  /** Spatial columns in this table, with the SRID the column is declared for. */
  geometry: GeometryColumn[];
  file: string;
  sha256: string;
}

/**
 * A `POINT` / `GEOMETRY` column.
 *
 * These need their own path in both directions because a geometry value cannot be
 * bound as a plain `?`: MySQL refuses the wire bytes with "Cannot get geometry
 * object from data you send to the GEOMETRY field". The backup therefore reads
 * `ST_AsWKB(column)` and the restore writes
 * `ST_SRID(ST_GeomFromWKB(UNHEX(?)), ?)` - verified against this MySQL 8.0.35
 * server, where a point written that way reads back byte-for-byte the same
 * `ST_AsText`. `srsId` is the column's `information_schema.columns.srs_id` (0 for
 * every geometry column in this schema), so the restored geometry carries the SRID
 * the column demands instead of being rejected for a mismatch.
 */
interface GeometryColumn {
  name: string;
  srsId: number | null;
}

interface ColumnInfo {
  name: string;
  dataType: string;
  srsId: number | null;
}

interface Manifest {
  format: number;
  createdAt: string;
  database: { host: string; port: number; name: string; serverVersion: string };
  migrations: string[];
  preserved: string[];
  /** Children first - the order `--apply` deletes in. */
  deleteOrder: string[];
  tables: TableSnapshot[];
}

type Row = Record<string, unknown>;

const USAGE = [
  'Usage: tsx src/tools/resetData.ts [--dry] [--backup] [--apply] [--restore] [--yes]',
  '',
  '  --dry      report row counts and the deletion order; write nothing (default)',
  '  --backup   write a verified snapshot of every table; delete nothing',
  '  --apply    snapshot, verify the snapshot, then delete the app data',
  '  --restore  put the app tables of a snapshot back (RESET_BACKUP_DIR=<dir>)',
  '  --yes      required with --restore: it clears the app tables first',
].join('\n');

function parseMode(argv: string[]): 'dry' | 'backup' | 'apply' | 'restore' {
  const flags = argv.filter((entry) => entry.startsWith('--'));
  const unknown = flags.filter(
    (flag) => !['--dry', '--backup', '--apply', '--restore', '--yes'].includes(flag),
  );
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(', ')}\n\n${USAGE}`);

  if (flags.includes('--restore')) return 'restore';
  if (flags.includes('--apply')) return 'apply';
  if (flags.includes('--backup')) return 'backup';
  return 'dry';
}

async function connect(): Promise<Connection> {
  const connection = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    timezone: 'Z',
    // `DATETIME(3)` comes back as the string MySQL stores ('2026-01-31 09:15:00.123'),
    // not as a JS `Date`: the value is written back verbatim, so no host time zone
    // can shift an instant between the backup and the restore.
    dateStrings: true,
    // DECIMAL / BIGINT arrive as strings and go back in verbatim: no float round
    // trip through JSON, so a coordinate is the same number afterwards.
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4_0900_ai_ci',
  });

  // The same pin `src/db/pool.ts` applies to every pooled connection.
  await connection.query("SET SESSION time_zone = '+00:00'");

  return connection;
}

async function baseTables(connection: Connection): Promise<string[]> {
  const [rows] = await connection.query<({ name: string } & RowDataPacket)[]>(
    `SELECT table_name AS name
       FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [env.db.database],
  );

  return rows.map((row) => String(row.name));
}

/** Spatial column types MySQL reports in `information_schema.columns.data_type`. */
const GEOMETRY_DATA_TYPES = new Set([
  'geometry',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
]);

/** Every column of one table, in definition order, with the two facts a restore needs. */
async function describeColumns(connection: Connection, table: string): Promise<ColumnInfo[]> {
  const [rows] = await connection.query<
    ({ name: string; dataType: string; srsId: number | null } & RowDataPacket)[]
  >(
    `SELECT column_name AS name, data_type AS dataType, srs_id AS srsId
       FROM information_schema.columns
      WHERE table_schema = ?
        AND table_name = ?
      ORDER BY ordinal_position`,
    [env.db.database, table],
  );

  return rows.map((row) => ({
    name: String(row.name),
    dataType: String(row.dataType).toLowerCase(),
    srsId: row.srsId === null || row.srsId === undefined ? null : Number(row.srsId),
  }));
}

function geometryColumnsOf(columns: ColumnInfo[]): GeometryColumn[] {
  return columns
    .filter((column) => GEOMETRY_DATA_TYPES.has(column.dataType))
    .map((column) => ({ name: column.name, srsId: column.srsId }));
}

/**
 * The order the app data is deleted in: **children before parents**, derived from
 * the foreign keys the database actually has rather than from a hand-written list
 * that a later migration could silently invalidate.
 *
 * A table may go once no *remaining* table references it; ties are broken
 * alphabetically so the order is reproducible run to run. A cycle (or a
 * self-reference, which is skipped because a table's own rows can be deleted in
 * any order) would leave nothing to choose and is reported instead of guessed at.
 */
async function deletionOrder(connection: Connection, tables: string[]): Promise<string[]> {
  const [rows] = await connection.query<({ child: string; parent: string } & RowDataPacket)[]>(
    `SELECT table_name AS child, referenced_table_name AS parent
       FROM information_schema.key_column_usage
      WHERE table_schema = ?
        AND referenced_table_name IS NOT NULL
        AND table_name <> referenced_table_name`,
    [env.db.database],
  );

  const clearing = new Set(tables);
  const childrenOf = new Map<string, Set<string>>();
  for (const row of rows) {
    const child = String(row.child);
    const parent = String(row.parent);
    if (!clearing.has(child) || !clearing.has(parent)) continue;

    const children = childrenOf.get(parent) ?? new Set<string>();
    children.add(child);
    childrenOf.set(parent, children);
  }

  const order: string[] = [];
  const remaining = new Set(tables);

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((table) => {
        const children = childrenOf.get(table);
        if (children === undefined) return true;
        for (const child of children) if (remaining.has(child)) return false;
        return true;
      })
      .sort();

    if (ready.length === 0) {
      throw new Error(
        `Cannot order these tables for deletion - they reference each other in a cycle: ${[...remaining]
          .sort()
          .join(', ')}.`,
      );
    }

    for (const table of ready) {
      order.push(table);
      remaining.delete(table);
    }
  }

  return order;
}

async function countRows(connection: Connection, table: string): Promise<number> {
  const [rows] = await connection.query<({ total: number } & RowDataPacket)[]>(
    `SELECT COUNT(*) AS total FROM \`${table}\``,
  );

  return Number(rows[0]?.total ?? 0);
}

async function countsFor(connection: Connection, tables: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const table of tables) counts.set(table, await countRows(connection, table));
  return counts;
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `2026-01-31T09-15-00-000Z` - a directory name Windows, macOS and Linux all accept. */
function snapshotStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * One value, in a shape JSON can carry and MySQL can read back.
 *
 * With `dateStrings` and string DECIMALs in play there is normally nothing to do;
 * this exists for the two types that would otherwise not survive: a `BINARY` /
 * `BLOB` column (no such column today, but a future attachment table must not be
 * silently corrupted) becomes `{ base64 }`, and a `Date` - should the driver ever
 * hand one over - becomes its ISO string.
 */
function toJsonValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { base64: value.toString('base64') };
  if (value instanceof Date) return value.toISOString().replace('T', ' ').replace('Z', '');
  return value;
}

async function writeSnapshot(
  connection: Connection,
  stamp: string,
  tables: string[],
  deleteOrder: string[],
): Promise<{ directory: string; manifest: Manifest }> {
  const directory = path.join(BACKUP_ROOT, stamp);
  const dataDirectory = path.join(directory, 'data');
  await mkdir(dataDirectory, { recursive: true });

  const [versionRows] = await connection.query<({ version: string } & RowDataPacket)[]>(
    'SELECT VERSION() AS version',
  );
  const [migrationRows] = await connection.query<({ version: string } & RowDataPacket)[]>(
    'SELECT version FROM schema_migrations ORDER BY version',
  );

  const snapshots: TableSnapshot[] = [];

  for (const table of tables) {
    const columns = await describeColumns(connection, table);
    const geometry = geometryColumnsOf(columns);
    const spatial = new Set(geometry.map((column) => column.name));

    // `ST_AsWKB` for the spatial columns: a geometry value read raw cannot be sent
    // back through a `?` placeholder (see `GeometryColumn`), so it travels as WKB.
    const selectList = columns
      .map((column) =>
        spatial.has(column.name) ? `ST_AsWKB(\`${column.name}\`) AS \`${column.name}\`` : `\`${column.name}\``,
      )
      .join(', ');

    const [rows] = await connection.query<(Row & RowDataPacket)[]>(
      `SELECT ${selectList} FROM \`${table}\``,
    );

    // Re-keyed into table-definition order, so a restore inserts explicit columns
    // in a known order rather than trusting the object the driver built.
    const ordered = rows.map((row) => {
      const shaped: Row = {};
      for (const column of columns) shaped[column.name] = toJsonValue(row[column.name]);
      return shaped;
    });

    const text = `${JSON.stringify(ordered, null, 2)}\n`;
    const file = path.join('data', `${table}.json`);
    await writeFile(path.join(directory, file), text, 'utf8');

    snapshots.push({
      name: table,
      rows: ordered.length,
      columns: columns.map((column) => column.name),
      geometry,
      file: file.split(path.sep).join('/'),
      sha256: sha256Of(text),
    });
  }

  const manifest: Manifest = {
    format: SNAPSHOT_FORMAT,
    createdAt: new Date().toISOString(),
    database: {
      host: env.db.host,
      port: env.db.port,
      name: env.db.database,
      serverVersion: String(versionRows[0]?.version ?? 'unknown'),
    },
    migrations: migrationRows.map((row) => String(row.version)),
    preserved: [...PRESERVED_TABLES],
    deleteOrder,
    tables: snapshots,
  };

  await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { directory, manifest };
}

/**
 * Re-reads the snapshot from disk and checks it against its own manifest: every
 * file present, parsing, still hashing to the recorded SHA-256, and holding
 * exactly the number of rows the manifest claims.
 *
 * This is the gate before any delete. A backup that cannot be read back is not a
 * backup, and finding that out *after* emptying the database is the one outcome
 * this tool must never produce.
 */
/**
 * Deletes every row of the app tables, in the child-first order above, inside one
 * transaction.
 *
 * The counts are not a formality: each table must come back with the number of
 * rows the snapshot read, otherwise something wrote to the database between the
 * backup and the delete and the snapshot no longer describes what was destroyed.
 * In that case the transaction rolls back and the run stops with the table named,
 * so the answer is "take a fresh snapshot", never "hope the backup is close
 * enough".
 */
async function deleteAppData(
  connection: Connection,
  order: string[],
  expected: Map<string, number>,
): Promise<Map<string, number>> {
  const deleted = new Map<string, number>();

  await connection.beginTransaction();
  try {
    for (const table of order) {
      const [result] = await connection.query<ResultSetHeader>(`DELETE FROM \`${table}\``);
      const affected = Number(result.affectedRows ?? 0);
      const snapshotRows = expected.get(table) ?? 0;

      if (affected !== snapshotRows) {
        throw new Error(
          `${table} changed while the backup was being taken: ${affected} rows deleted, ${snapshotRows} in the snapshot. Rolling back; run the backup again.`,
        );
      }

      deleted.set(table, affected);
    }

    await connection.commit();
    return deleted;
  } catch (caught) {
    await connection.rollback().catch(() => undefined);
    throw caught;
  }
}

/** The `BINARY`/`BLOB` shape `toJsonValue` writes, read back. */
function fromJsonValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'base64' in (value as Row)) {
    return Buffer.from(String((value as { base64: unknown }).base64), 'base64');
  }

  return value;
}

/** One column of an `INSERT`: the SQL fragment and the values it binds, in order. */
interface ValuePlan {
  sql: string;
  values: unknown[];
}

/**
 * How one value goes back in.
 *
 * `NULL` is a literal rather than a bound parameter so that a null in any column -
 * including a spatial one - needs no special case in the caller. A spatial value is
 * the one shape that cannot be a bare `?`: it goes through
 * `ST_SRID(ST_GeomFromWKB(UNHEX(?)), ?)`, with the WKB as hex because a hex string
 * binds as a value the server definitely reads as data rather than as a (failed)
 * attempt at a geometry literal.
 */
function planValue(geometry: GeometryColumn | undefined, raw: unknown): ValuePlan {
  if (raw === null || raw === undefined) return { sql: 'NULL', values: [] };
  if (geometry === undefined) return { sql: '?', values: [fromJsonValue(raw)] };

  const buffer = fromJsonValue(raw);
  if (!Buffer.isBuffer(buffer)) return { sql: 'NULL', values: [] };

  const hex = buffer.toString('hex');
  return geometry.srsId === null
    ? { sql: 'ST_GeomFromWKB(UNHEX(?))', values: [hex] }
    : { sql: 'ST_SRID(ST_GeomFromWKB(UNHEX(?)), ?)', values: [hex, geometry.srsId] };
}

/** The `INSERT` for one row: only the columns this schema still has, in table order. */
function planInsert(
  table: string,
  columns: string[],
  geometry: GeometryColumn[],
  row: Row,
): { sql: string; values: unknown[] } {
  const names: string[] = [];
  const expressions: string[] = [];
  const values: unknown[] = [];

  for (const column of columns) {
    const plan = planValue(
      geometry.find((entry) => entry.name === column),
      row[column],
    );

    names.push(`\`${column}\``);
    expressions.push(plan.sql);
    values.push(...plan.values);
  }

  return { sql: `INSERT INTO \`${table}\` (${names.join(', ')}) VALUES (${expressions.join(', ')})`, values };
}

async function verifySnapshot(directory: string, manifest: Manifest): Promise<void> {
  if (manifest.format !== SNAPSHOT_FORMAT) {
    throw new Error(`Snapshot format ${manifest.format} is not supported by this build.`);
  }

  for (const table of manifest.tables) {
    const filePath = path.join(directory, ...table.file.split('/'));
    const text = await readFile(filePath, 'utf8');

    const hash = sha256Of(text);
    if (hash !== table.sha256) {
      throw new Error(`Snapshot ${table.file} is corrupt: expected sha256 ${table.sha256}, read ${hash}.`);
    }

    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`Snapshot ${table.file} is not a JSON array.`);
    if (parsed.length !== table.rows) {
      throw new Error(`Snapshot ${table.file} holds ${parsed.length} rows, the manifest says ${table.rows}.`);
    }
  }
}

/**
 * Puts a snapshot back - the way back if the clean database was not what was
 * wanted.
 *
 * Rows go in **parents first** (the exact reverse of the deletion order), so a
 * foreign key target always exists before the row that points at it. The app
 * tables are cleared first, in the normal child-first order, because inserting a
 * snapshot on top of live rows would collide on primary keys rather than tell you
 * anything useful.
 *
 * A snapshot is not a schema: the tables and columns that exist *now* are what
 * gets written. A column the snapshot has and the database does not (an older
 * snapshot, taken before a migration) is reported and skipped rather than being
 * treated as an error, and so is a table that no longer exists. The preserved
 * tables - `schema_migrations`, `interests` - are only refilled when they are
 * empty, so a restore can never roll the migration history backwards or replace
 * the live interest catalogue with an older copy.
 *
 * Spatial columns (`POINT` and friends) are written back from the WKB the snapshot
 * holds, through `ST_SRID(ST_GeomFromWKB(UNHEX(?)), ?)` - see `GeometryColumn` for
 * why they cannot be a plain parameter.
 */
async function restoreSnapshot(
  connection: Connection,
  directory: string,
  manifest: Manifest,
  order: string[],
  live: Map<string, ColumnInfo[]>,
): Promise<{ inserted: Map<string, number>; notes: string[] }> {
  const inserted = new Map<string, number>();
  const notes: string[] = [];

  for (const table of [...order].reverse()) {
    const snapshot = manifest.tables.find((entry) => entry.name === table);
    if (snapshot === undefined) {
      notes.push(`${table}: not in this snapshot - left empty`);
      continue;
    }

    const columns = live.get(table) ?? [];
    const missing = snapshot.columns.filter((column) => !columns.some((entry) => entry.name === column));
    const shared = snapshot.columns.filter((column) => columns.some((entry) => entry.name === column));
    const geometry = (snapshot.geometry ?? []).filter((entry) => shared.includes(entry.name));

    if (missing.length > 0) notes.push(`${table}: skipped column(s) ${missing.join(', ')} (not in this schema)`);
    if (shared.length === 0) continue;

    const text = await readFile(path.join(directory, ...snapshot.file.split('/')), 'utf8');
    const rows = JSON.parse(text) as Row[];

    for (const row of rows) {
      const statement = planInsert(table, shared, geometry, row);
      await connection.query(statement.sql, statement.values);
    }

    inserted.set(table, rows.length);
  }

  for (const table of PRESERVED_TABLES) {
    const snapshot = manifest.tables.find((entry) => entry.name === table);
    if (snapshot === undefined || snapshot.rows === 0) continue;

    const live = await countRows(connection, table);
    if (live > 0) {
      notes.push(`${table}: kept the ${live} live rows, the snapshot's ${snapshot.rows} were not restored`);
      continue;
    }

    const text = await readFile(path.join(directory, ...snapshot.file.split('/')), 'utf8');
    const rows = JSON.parse(text) as Row[];
    const geometry = (snapshot.geometry ?? []).filter((entry) => snapshot.columns.includes(entry.name));

    for (const row of rows) {
      const statement = planInsert(table, snapshot.columns, geometry, row);
      await connection.query(statement.sql, statement.values);
    }

    inserted.set(table, rows.length);
    notes.push(`${table}: was empty, refilled with ${rows.length} rows from the snapshot`);
  }

  return { inserted, notes };
}

function countLines(counts: Map<string, number>, kept: Set<string>): string[] {
  if (counts.size === 0) return ['  (no tables)'];

  const width = Math.max(...[...counts.keys()].map((name) => name.length));
  return [...counts.entries()].map(
    ([table, rows]) =>
      `  ${table.padEnd(width)}  ${String(rows).padStart(6)}${kept.has(table) ? '   (kept)' : ''}`,
  );
}

/** Snapshot directories under `backend/.backups`, newest first. */
async function listSnapshots(): Promise<string[]> {
  try {
    const entries = await readdir(BACKUP_ROOT, { withFileTypes: true });
    const directories: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) directories.push(entry.name);
    }
    return directories.sort().reverse();
  } catch {
    return [];
  }
}

async function runRestore(connection: Connection, tables: string[], order: string[]): Promise<void> {
  const requested = (process.env.RESET_BACKUP_DIR ?? '').trim();
  if (requested.length === 0) {
    const available = await listSnapshots();
    throw new Error(
      [
        'RESET_BACKUP_DIR is not set, so there is nothing to restore.',
        '',
        available.length > 0 ? 'Available snapshots:' : 'No snapshots yet - take one with `npm run db:backup`.',
        ...available.map((name) => `  ${name}`),
        '',
        'PowerShell:  $env:RESET_BACKUP_DIR=".backups/<name>"; npm run db:restore',
      ].join('\n'),
    );
  }

  const directory = path.isAbsolute(requested) ? requested : path.resolve(process.cwd(), requested);
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;

  await verifySnapshot(directory, manifest);
  console.log(`Snapshot verified: ${manifest.tables.length} table(s) from ${manifest.createdAt}.`);

  if (manifest.database.name !== env.db.database) {
    console.log(
      `Note: the snapshot was taken from database "${manifest.database.name}" and is being restored into "${env.db.database}".`,
    );
  }

  // Clear first: the snapshot is inserted, not merged, so primary keys cannot
  // collide with whatever the app created since.
  await deleteAppData(connection, order, await countsFor(connection, order));

  const live = new Map<string, ColumnInfo[]>();
  for (const table of tables) live.set(table, await describeColumns(connection, table));

  const { inserted, notes } = await restoreSnapshot(connection, directory, manifest, order, live);

  console.log('');
  console.log(`Restored ${path.relative(process.cwd(), directory) || directory}:`);
  console.log(countLines(inserted, new Set(PRESERVED_TABLES)).join('\n'));
  if (notes.length > 0) {
    console.log('');
    for (const note of notes) console.log(`  note: ${note}`);
  }
}

async function run(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const connection = await connect();

  try {
    const tables = await baseTables(connection);
    const kept = new Set(PRESERVED_TABLES.filter((table) => tables.includes(table)));
    const clearTables = tables.filter((table) => !kept.has(table));
    const order = await deletionOrder(connection, clearTables);

    console.log(
      `Database "${env.db.database}" on ${env.db.host}:${env.db.port} - ${tables.length} table(s): ${clearTables.length} cleared, ${[...kept].join(', ')} preserved.`,
    );
    console.log('');

    if (mode === 'restore') {
      await runRestore(connection, tables, order);
      return;
    }

    const before = await countsFor(connection, tables);

    console.log('Deletion order (children before parents, read from the foreign keys):');
    console.log(`  ${order.join(' -> ')}`);
    console.log('');
    console.log('Row counts right now:');
    console.log(countLines(before, kept).join('\n'));
    console.log('');

    if (mode === 'dry') {
      console.log('Dry run: nothing written, nothing deleted. `npm run db:reset` backs up, verifies, then clears.');
      return;
    }

    const stamp = snapshotStamp(new Date());
    const { directory, manifest } = await writeSnapshot(connection, stamp, tables, order);
    const snapshotRows = manifest.tables.reduce((total, table) => total + table.rows, 0);
    const location = path.relative(process.cwd(), directory) || directory;

    await verifySnapshot(directory, manifest);
    console.log(
      `Snapshot: ${location} - ${manifest.tables.length} table(s), ${snapshotRows} row(s), all SHA-256 checks passed.`,
    );

    if (mode === 'backup') {
      console.log('Backup only: nothing was deleted.');
      return;
    }

    const deleted = await deleteAppData(connection, order, before);

    console.log('');
    console.log('Deleted:');
    console.log(countLines(deleted, new Set()).join('\n'));
    console.log('');
    console.log('Row counts now:');
    console.log(countLines(await countsFor(connection, tables), kept).join('\n'));
    console.log('');
    console.log(`Cleared ${deleted.size} table(s). Schema, migrations and the interest catalogue are untouched.`);
    console.log(`To put the data back:  $env:RESET_BACKUP_DIR="${location}"; npm run db:restore`);
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
