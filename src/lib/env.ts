/**
 * Runtime configuration.
 *
 * Only `EXPO_PUBLIC_*` variables are read here (see `.env.example`). They are
 * inlined by Expo at bundle time, so they must be read as static property
 * accesses — never dynamically.
 *
 * Phase 3 talks to the Unihood API (Node/Express + MySQL, see `backend/`) for
 * authentication, profiles, interests, location and nearby discovery. When the
 * URL below is missing the app does **not** pretend to work:
 * `isBackendConfigured` is false, the session provider reports `unconfigured`
 * and the affected screens render an explicit configuration-required state.
 */

function readEnv(value: string | undefined): string {
  return (value ?? '').trim();
}

export const env = {
  appEnv: readEnv(process.env.EXPO_PUBLIC_APP_ENV) || 'development',
  /**
   * Base URL of the Unihood API, without a trailing slash.
   *
   * On a simulator `http://localhost:4000` is the machine running `npm run dev`
   * inside `backend/`. On a physical phone `localhost` is the phone itself, so
   * the machine's LAN address is needed instead (`http://192.168.0.5:4000`).
   */
  apiBaseUrl: readEnv(process.env.EXPO_PUBLIC_API_BASE_URL).replace(/\/+$/, ''),
} as const;

export const isBackendConfigured = Boolean(env.apiBaseUrl);

export type DataSourceKind = 'api' | 'unconfigured';

/**
 * Which data source the app can read from.
 *
 * `unconfigured` means no API URL is present. Groups and Events still render
 * from their in-app mock catalogs in this phase; People discovery and
 * authentication require a configured backend by design.
 */
export const dataSource: DataSourceKind = isBackendConfigured ? 'api' : 'unconfigured';

/** Human-readable reason shown in configuration-required states. */
export const missingBackendMessage =
  'Unihood needs its API address before accounts, profiles and nearby discovery can work.';
