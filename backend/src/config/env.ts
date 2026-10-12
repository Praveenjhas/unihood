/**
 * Backend configuration.
 *
 * Every value the server needs is read here, once, and validated before
 * anything else runs. Two rules make the rest of the code simple:
 *
 *   1. **Fail fast.** A missing `JWT_ACCESS_SECRET` or a half-configured SMTP
 *      transport stops the process at startup with a list of exactly which
 *      values are wrong, instead of surfacing as a 500 half an hour later.
 *   2. **No secrets leave this module's shape.** `env` is the only place
 *      `DB_PASSWORD`, `JWT_ACCESS_SECRET` and the SMTP credentials exist, and
 *      nothing here is ever included in an HTTP response - the health endpoint
 *      reports connectivity, never configuration.
 *
 * `.env` is loaded from `backend/.env` relative to this file, which resolves to
 * the same path whether the code runs from `src/` through `tsx` or from the
 * compiled `dist/`.
 */
import path from 'node:path';

import { config as loadEnvFile } from 'dotenv';
import { z } from 'zod';

/** `backend/.env`, resolved identically from `src/config` and `dist/config`. */
export const ENV_FILE_PATH = path.resolve(__dirname, '..', '..', '.env');

loadEnvFile({ path: ENV_FILE_PATH });

/**
 * Accepts `true` / `false` / `1` / `0`. An unset variable arrives as `''`
 * because dotenv has already run, so `''` falls back to the default below.
 */
const booleanFlag = (value: string): boolean => value === 'true' || value === '1';

const booleanField = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .default(fallback)
    .transform(booleanFlag);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),

  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_NAME: z.string().min(1).default('unihood'),
  DB_USER: z.string().min(1, 'DB_USER is required - create the dedicated unihood application account.'),
  // Deliberately not `.min(1)`: a local server may have no password for the account.
  DB_PASSWORD: z.string().default(''),
  DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(100).default(10),

  // A short secret would make every access token forgeable, so it is rejected at
  // startup rather than left to a code review.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters.'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  MAX_ACTIVE_REFRESH_SESSIONS: z.coerce.number().int().min(1).max(100).default(10),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),

  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(10).max(10000).default(400),
  AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(1000).default(40),
  /**
   * Per-IP ceiling for the two OTP endpoints. Sits under `AUTH_RATE_LIMIT_MAX_REQUESTS`
   * because each request here can cost an SMS, and the per-number limits live in
   * `otpService` rather than in this counter.
   */
  OTP_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(1000).default(30),
  /**
   * Per-member ceiling for group-chat message submissions (Phase 7).
   *
   * Its own, tighter bucket because a write is worth more than a read: a runaway
   * client that keeps posting must not be able to spend the whole API budget. Chatty
   * real use is far below this - it is twenty posts a minute - and it is spent by
   * *both* transports from one allowance: `POST /api/groups/:id/messages` and the
   * socket's `message:send` are counted against the same member (see
   * `src/middleware/messageLimit.ts`), so switching transport buys nothing.
   */
  MESSAGE_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(10).max(10000).default(300),
  /**
   * The window that ceiling is measured over. Its own value rather than
   * `RATE_LIMIT_WINDOW_MINUTES` so a deployment can tune a chatty endpoint without
   * touching the per-IP buckets; the development default matches them at 15 minutes.
   */
  MESSAGE_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(86400).default(900),

  MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  MAIL_FROM: z.string().min(3).default('Unihood <no-reply@unihood.local>'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: booleanField('false'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),

  // ---------------------------------------------------------------------------
  // Phone sign-in (Phase 5)
  //
  // `OTP_TRANSPORT=log` is a development convenience with no provider, no
  // credentials and no cost - and it is refused in production below, because a
  // production server that cannot actually send a code is not a server.
  // ---------------------------------------------------------------------------
  OTP_TRANSPORT: z.enum(['log', 'sms']).default('log'),
  /** Digits in a generated code. Six is the industry default and is what the UI expects. */
  OTP_CODE_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
  /** How long a code stays usable. Short on purpose: a code is a one-shot credential. */
  OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  /** Wrong codes allowed per challenge before a new one must be requested. */
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  /** Seconds between two code requests for the same number. */
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  /** Codes a single number may request in a rolling hour (abuse ceiling). */
  OTP_MAX_REQUESTS_PER_HOUR: z.coerce.number().int().min(1).max(100).default(5),
  /**
   * HMAC key for stored code hashes.
   *
   * Required in production; in development an empty value falls back to
   * `JWT_ACCESS_SECRET` so a fresh checkout runs without extra setup. That
   * fallback is never used in production, where the value must be its own secret.
   */
  OTP_HASH_SECRET: z.string().default(''),
  SMS_PROVIDER_URL: z.string().default(''),
  SMS_PROVIDER_TOKEN: z.string().default(''),
  SMS_SENDER: z.string().default('Unihood'),

  EXPOSE_DEV_TOKENS: booleanField('false'),
  CORS_ALLOWED_ORIGINS: z.string().default('*'),
  ALLOWED_REDIRECT_SCHEMES: z.string().default('unihood,exp'),
});


const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('\n');

  throw new Error(
    `Unihood backend configuration is invalid.\n${problems}\n` +
      `Correct the values in ${ENV_FILE_PATH} (template: backend/.env.example).`,
  );
}

const raw = parsed.data;

// Cross-field rules the schema shape above cannot express.
if (raw.MAIL_TRANSPORT === 'smtp' && raw.SMTP_HOST.length === 0) {
  throw new Error(
    'MAIL_TRANSPORT=smtp requires SMTP_HOST (and usually SMTP_USER / SMTP_PASSWORD). ' +
      'Set them in backend/.env, or use MAIL_TRANSPORT=log for local development.',
  );
}

const isProduction = raw.NODE_ENV === 'production';

// Phone sign-in: the same fail-fast rules as email, for the same reason.
if (isProduction && raw.OTP_TRANSPORT === 'log') {
  throw new Error(
    'OTP_TRANSPORT=log is a development-only transport: it writes codes to backend/.otp-outbox and ' +
      'sends nothing. Set OTP_TRANSPORT=sms and the SMS_PROVIDER_* values, or set NODE_ENV=development.',
  );
}

if (raw.OTP_TRANSPORT === 'sms' && raw.SMS_PROVIDER_URL.length === 0) {
  throw new Error(
    'OTP_TRANSPORT=sms requires SMS_PROVIDER_URL. Set it in backend/.env, or use OTP_TRANSPORT=log ' +
      'for local development.',
  );
}

if (isProduction && raw.OTP_HASH_SECRET.trim().length === 0) {
  throw new Error(
    'OTP_HASH_SECRET is required in production - it keys the HMAC that protects stored one-time codes. ' +
      'Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(48).toString(\'hex\'))"',
  );
}

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const env = {
  nodeEnv: raw.NODE_ENV,
  isProduction,
  /** `production` always wins: a shipped build can never echo a live token. */
  exposeDevTokens: raw.EXPOSE_DEV_TOKENS && !isProduction,
  envFilePath: ENV_FILE_PATH,

  api: {
    host: raw.API_HOST,
    port: raw.API_PORT,
    /** Trailing slashes removed: link building concatenates paths directly. */
    publicUrl: raw.API_PUBLIC_URL.replace(/\/+$/, ''),
  },

  db: {
    host: raw.DB_HOST,
    port: raw.DB_PORT,
    database: raw.DB_NAME,
    user: raw.DB_USER,
    password: raw.DB_PASSWORD,
    connectionLimit: raw.DB_CONNECTION_LIMIT,
  },

  tokens: {
    accessSecret: raw.JWT_ACCESS_SECRET,
    accessTtlSeconds: raw.ACCESS_TOKEN_TTL_MINUTES * 60,
    refreshTtlSeconds: raw.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    maxActiveRefreshSessions: raw.MAX_ACTIVE_REFRESH_SESSIONS,
    emailVerificationTtlSeconds: raw.EMAIL_VERIFICATION_TTL_HOURS * 60 * 60,
    passwordResetTtlSeconds: raw.PASSWORD_RESET_TTL_MINUTES * 60,
  },

  rateLimit: {
    windowMs: raw.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    max: raw.RATE_LIMIT_MAX_REQUESTS,
    authMax: raw.AUTH_RATE_LIMIT_MAX_REQUESTS,
    otpMax: raw.OTP_RATE_LIMIT_MAX_REQUESTS,
    /**
     * The chat's own bucket: counted per member, not per address, and over its own
     * window. Both the HTTP middleware and the socket handler read these two.
     */
    messageMax: raw.MESSAGE_RATE_LIMIT_MAX_REQUESTS,
    messageWindowMs: raw.MESSAGE_RATE_LIMIT_WINDOW_SECONDS * 1000,
  },

  mail: {
    transport: raw.MAIL_TRANSPORT,
    from: raw.MAIL_FROM,
    smtp: {
      host: raw.SMTP_HOST,
      port: raw.SMTP_PORT,
      secure: raw.SMTP_SECURE,
      user: raw.SMTP_USER,
      password: raw.SMTP_PASSWORD,
    },
  },

  otp: {
    transport: raw.OTP_TRANSPORT,
    codeLength: raw.OTP_CODE_LENGTH,
    ttlSeconds: raw.OTP_TTL_MINUTES * 60,
    ttlMinutes: raw.OTP_TTL_MINUTES,
    maxAttempts: raw.OTP_MAX_ATTEMPTS,
    resendCooldownSeconds: raw.OTP_RESEND_COOLDOWN_SECONDS,
    maxRequestsPerHour: raw.OTP_MAX_REQUESTS_PER_HOUR,
    /**
     * The HMAC key. The development fallback onto `JWT_ACCESS_SECRET` is
     * deliberate and documented: it keeps a fresh checkout runnable, and it still
     * beats storing an unkeyed digest of a six-digit code. Production has its own
     * required value (see the check above).
     */
    hashSecret: raw.OTP_HASH_SECRET.trim().length > 0 ? raw.OTP_HASH_SECRET : raw.JWT_ACCESS_SECRET,
    /**
     * True when the hash key is the JWT secret rather than its own value. Reported
     * at startup so the fallback is visible rather than silent.
     */
    usingFallbackHashSecret: raw.OTP_HASH_SECRET.trim().length === 0,
    sms: {
      providerUrl: raw.SMS_PROVIDER_URL,
      token: raw.SMS_PROVIDER_TOKEN,
      sender: raw.SMS_SENDER,
    },
  },

  http: {
    corsAllowedOrigins: splitList(raw.CORS_ALLOWED_ORIGINS),
    allowedRedirectSchemes: splitList(raw.ALLOWED_REDIRECT_SCHEMES).map((scheme) => scheme.toLowerCase()),
  },
} as const;

export type Env = typeof env;
