/**
 * `npm run db:check` - a one-shot connectivity report.
 *
 * Prints exactly what the health endpoint would report, plus the two facts that
 * are only useful while setting the project up: the migration state and the
 * session time zone. It reads nothing sensitive and writes nothing.
 *
 * Exits non-zero when the database cannot be reached or the UTC session pin
 * failed to apply, so it can gate a script.
 */
import { probeDatabase, assertUtcSession, pool } from './pool';

async function main(): Promise<void> {
  const probe = await probeDatabase();

  console.log('Database connectivity');
  console.log(`  connected        : ${probe.connected}`);
  console.log(`  server version   : ${probe.serverVersion}`);
  console.log(`  schema           : ${probe.database}`);
  console.log(`  session time zone: ${probe.sessionTimeZone}`);
  console.log(`  round trip       : ${probe.latencyMs} ms`);

  await assertUtcSession();
  console.log('  UTC session pin  : ok (+00:00)');

  const [rows] = await pool.query<import('mysql2/promise').RowDataPacket[]>(
    'SELECT COUNT(*) AS applied FROM schema_migrations',
  );
  console.log(`  migrations applied: ${Number(rows[0]?.applied ?? 0)}`);
}

main()
  .then(() => pool.end())
  .catch(async (caught: unknown) => {
    console.error(`\nDatabase check failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
