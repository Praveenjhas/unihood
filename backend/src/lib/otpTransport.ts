/**
 * OTP delivery.
 *
 * The same honesty rule as `mailer.ts`, applied to codes: a dispatch reports
 * `delivered: true` only when a real provider accepted the message.
 *
 *   * `log` - **development only.** The code is written to
 *     `backend/.otp-outbox/<timestamp>__<masked number>.txt`, which is
 *     git-ignored, and `delivered` stays `false`. This is what makes the whole
 *     flow testable with no account, no credentials and no cost. The file is the
 *     *only* place the code appears: it is never returned in an API response and
 *     never printed to the console (the console line names the file instead).
 *   * `sms` - a real provider, configured through `SMS_PROVIDER_URL` (plus an
 *     optional bearer token). The request shape is deliberately minimal
 *     (`{ to, message, code }` as JSON) so swapping in Twilio, MessageBird or an
 *     in-house gateway is a change to this one function and nothing else.
 *
 * `config/env.ts` refuses to start the server in production with `OTP_TRANSPORT=log`
 * and refuses to start with `sms` but no provider URL, so neither mistake can
 * present itself as "the code was sent".
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { env } from '../config/env';
import { maskPhone } from '../domain/phone';

export interface OtpMessage {
  /** Storage-shape E.164. */
  to: string;
  code: string;
  expiresInMinutes: number;
}

export interface OtpDispatch {
  transport: 'log' | 'sms';
  /** True only when a real provider accepted the message. */
  delivered: boolean;
  /** Where the `log` transport wrote the code; `null` for `sms`. */
  outboxPath: string | null;
  /** Set when the transport raised; the caller still answers 202. */
  error: string | null;
}

/** What a transport has to do. Everything else in the flow is transport-agnostic. */
export interface OtpTransport {
  readonly kind: 'log' | 'sms';
  send(message: OtpMessage): Promise<OtpDispatch>;
}

const OUTBOX_DIR = path.resolve(__dirname, '..', '..', '.otp-outbox');

/** Strips anything that cannot appear in a file name. */
const safeFilePart = (value: string): string => value.replace(/[^a-zA-Z0-9._@+-]/g, '_').slice(0, 40);

const logTransport: OtpTransport = {
  kind: 'log',

  async send(message) {
    const filePath = path.join(
      OUTBOX_DIR,
      `${new Date().toISOString().replace(/[:.]/g, '-')}__${safeFilePart(maskPhone(message.to))}.txt`,
    );

    try {
      await mkdir(OUTBOX_DIR, { recursive: true });
      await writeFile(
        filePath,
        [
          `To:      ${message.to}`,
          `Written: ${new Date().toISOString()}`,
          `Expires: in ${message.expiresInMinutes} minute(s)`,
          '',
          '--- one-time code ---',
          message.code,
          '',
          'This file exists because OTP_TRANSPORT=log. No SMS was sent.',
          'Production refuses to start in this mode.',
          '',
        ].join('\n'),
        'utf8',
      );

      // The path, never the code: a console line is not the enabled development
      // transport, and a terminal capture should not leak a live code.
      console.log(`[otp] OTP_TRANSPORT=log - code for ${maskPhone(message.to)} written to ${filePath}`);

      return { transport: 'log', delivered: false, outboxPath: filePath, error: null };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      console.error(`[otp] could not write to the outbox for ${maskPhone(message.to)}: ${error}`);
      return { transport: 'log', delivered: false, outboxPath: null, error };
    }
  },
};

const smsTransport: OtpTransport = {
  kind: 'sms',

  async send(message) {
    const url = env.otp.sms.providerUrl;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.otp.sms.token.length > 0 ? { authorization: `Bearer ${env.otp.sms.token}` } : {}),
        },
        body: JSON.stringify({
          to: message.to,
          sender: env.otp.sms.sender,
          message: `Your Unihood code is ${message.code}. It expires in ${message.expiresInMinutes} minutes.`,
          code: message.code,
        }),
      });

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        console.error(`[otp] provider rejected the message for ${maskPhone(message.to)}: ${response.status} ${detail}`);
        return {
          transport: 'sms',
          delivered: false,
          outboxPath: null,
          error: `provider responded ${response.status}`,
        };
      }

      return { transport: 'sms', delivered: true, outboxPath: null, error: null };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      console.error(`[otp] provider call for ${maskPhone(message.to)} failed: ${error}`);
      return { transport: 'sms', delivered: false, outboxPath: null, error };
    }
  },
};

/** The configured transport. Chosen once at import, from validated configuration. */
export const otpTransport: OtpTransport = env.otp.transport === 'sms' ? smsTransport : logTransport;

export function sendOtp(message: OtpMessage): Promise<OtpDispatch> {
  return otpTransport.send(message);
}
