/**
 * Email delivery.
 *
 * Two transports, and the honest difference between them:
 *
 *   * `smtp`  - a real provider. `sendMail` resolves only after the server has
 *               accepted the message, and `delivered` is `true`.
 *   * `log`   - no provider configured. The message is written to
 *               `backend/.mail-outbox/` and `delivered` stays **false**.
 *
 * Nothing here ever claims a delivery that did not happen. `MAIL_TRANSPORT=smtp`
 * without an `SMTP_HOST` stops the server at startup (see `config/env.ts`), and
 * a transport-level failure is returned rather than thrown away, so a caller can
 * report "the account exists but the email did not go out" instead of lying.
 *
 * The verification / reset links are single-use and expiring, so writing them to
 * a local file while no provider exists is a development convenience rather than
 * a weakening of the flow - and `EXPOSE_DEV_TOKENS` is forced off in production.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import nodemailer, { type Transporter } from 'nodemailer';

import { env } from '../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailResult {
  transport: 'smtp' | 'log';
  /** True only when a real server accepted the message. */
  delivered: boolean;
  /** Where the `log` transport wrote the message; `null` for `smtp`. */
  outboxPath: string | null;
  /** Set when the transport raised; the caller decides how to report it. */
  error: string | null;
}

const OUTBOX_DIR = path.resolve(__dirname, '..', '..', '.mail-outbox');

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.mail.smtp.host,
    port: env.mail.smtp.port,
    secure: env.mail.smtp.secure,
    auth: env.mail.smtp.user.length > 0 ? { user: env.mail.smtp.user, pass: env.mail.smtp.password } : undefined,
  });

  return transporter;
}

/** Strips anything that cannot appear in a file name. */
const safeFilePart = (value: string): string => value.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 80);

async function writeToOutbox(message: MailMessage): Promise<string> {
  await mkdir(OUTBOX_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(OUTBOX_DIR, `${stamp}__${safeFilePart(message.to)}.txt`);

  const body = [
    `To:      ${message.to}`,
    `From:    ${env.mail.from}`,
    `Subject: ${message.subject}`,
    `Written: ${new Date().toISOString()}`,
    '',
    '--- text/plain ---',
    message.text,
    '',
    '--- text/html ---',
    message.html,
    '',
  ].join('\n');

  await writeFile(filePath, body, 'utf8');
  return filePath;
}

/** Sends a message, or records it locally when no provider is configured. */
export async function sendMail(message: MailMessage): Promise<MailResult> {
  if (env.mail.transport === 'log') {
    try {
      const outboxPath = await writeToOutbox(message);
      console.log(`[mail] MAIL_TRANSPORT=log - "${message.subject}" for ${message.to} written to ${outboxPath}`);
      return { transport: 'log', delivered: false, outboxPath, error: null };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      console.error(`[mail] could not write to the outbox: ${error}`);
      return { transport: 'log', delivered: false, outboxPath: null, error };
    }
  }

  try {
    await getTransporter().sendMail({
      from: env.mail.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { transport: 'smtp', delivered: true, outboxPath: null, error: null };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    console.error(`[mail] SMTP delivery to ${message.to} failed: ${error}`);
    return { transport: 'smtp', delivered: false, outboxPath: null, error };
  }
}
