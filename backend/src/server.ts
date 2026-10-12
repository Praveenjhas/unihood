/**
 * The process entry point.
 *
 * Startup is deliberately loud and strict:
 *
 *   1. configuration is validated at import time (`config/env.ts`);
 *   2. the database must answer (`probeDatabase`);
 *   3. the session time zone must be UTC (`assertUtcSession`) - otherwise every
 *      timestamp in the schema would be written to a different clock than it is
 *      read from;
 *   4. the migrations must have been applied (`assertSchemaReady`).
 *
 * Failing at step 2-4 instead of starting is the point: an API that boots and
 * then 500s on every request hides a setup problem behind a code problem.
 *
 * Since Phase 7 the same HTTP server also carries the Socket.IO endpoint
 * (`/realtime`) group chat uses. That is the *only* place it is attached, so every
 * service and script that imports `chatService` works without a socket server, and
 * `realtime/hub.ts` treats an unattached hub as "nothing to broadcast".
 *
 * A `SIGINT`/`SIGTERM` handler closes the sockets, then the HTTP server, then the
 * pool, so a restart does not leave MySQL connections - or WebSocket frames -
 * dangling.
 */
import { createApp } from './app';
import { env } from './config/env';
import { assertSchemaReady, assertUtcSession, pool, probeDatabase } from './db/pool';
import { REALTIME_PATH } from './domain/chat';
import { attachRealtime } from './realtime/socket';

async function start(): Promise<void> {
  const probe = await probeDatabase();
  await assertUtcSession();
  await assertSchemaReady();

  const app = createApp();

  const server = app.listen(env.api.port, env.api.host, () => {
    console.log(`Unihood API (${env.nodeEnv}) listening on http://${env.api.host}:${env.api.port}`);
    console.log(`  public URL  : ${env.api.publicUrl}`);
    console.log(`  database    : ${probe.database} on MySQL ${probe.serverVersion} (session tz ${probe.sessionTimeZone})`);
    console.log(`  realtime    : Socket.IO on ${REALTIME_PATH} (group chat; token in the handshake)`);
    console.log(
      `  mail        : ${env.mail.transport}${
        env.mail.transport === 'log' ? ' - messages are written to backend/.mail-outbox' : ''
      }`,
    );
    console.log(
      `  otp         : ${env.otp.transport}${
        env.otp.transport === 'log'
          ? ' - one-time codes are written to backend/.otp-outbox (development only)'
          : ` - via ${env.otp.sms.providerUrl}`
      }`,
    );
    if (env.otp.usingFallbackHashSecret) {
      console.log('  otp hash    : OTP_HASH_SECRET is not set - falling back to JWT_ACCESS_SECRET (development only)');
    }
    console.log(`  health      : ${env.api.publicUrl}/health`);
    if (env.exposeDevTokens) {
      console.log('  dev tokens  : single-use links are returned in API responses (development only)');
    }
  });

  const realtime = attachRealtime(server);

  const shutdown = (signal: string): void => {
    console.log(`\n${signal} received - shutting down.`);

    // Sockets hold the listener open, so they go first: without this `server.close`
    // would wait for every WebSocket to time out on its own.
    realtime.disconnectSockets(true);

    server.close(() => {
      void pool
        .end()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });

    // A hung connection must not block the exit forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((caught: unknown) => {
  const message = caught instanceof Error ? caught.message : String(caught);
  console.error(`\nUnihood API could not start.\n${message}\n`);
  process.exitCode = 1;
  void pool.end().catch(() => undefined);
});
