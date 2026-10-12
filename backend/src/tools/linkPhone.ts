/**
 * Attaches a phone number to an existing account.
 *
 *   $env:PHONE_LINK_EMAIL='you@example.com'; $env:PHONE_LINK_PHONE='+919876543210'; npm run phone:link
 *
 * Why this exists, and why it is the *only* way a number is ever attached to an
 * account that already has one:
 *
 *   Phase 5 makes a phone number the user-facing sign-in, and migration 0008
 *   deliberately leaves existing email accounts without one. Nothing in the API
 *   will invent a number for somebody, and no code path silently claims a number
 *   on behalf of an account that never proved it holds it - that would be an
 *   account takeover with extra steps. A developer (or an administrator) who
 *   wants an existing development account to be reachable through the new phone
 *   screen runs this, deliberately, once, with a number they actually control.
 *
 * What it refuses to do:
 *   * run without both values, or with a number that is not valid E.164;
 *   * attach a number another account already has (`users.phone_e164` is unique,
 *     and this tool reports the conflict rather than letting the constraint blow
 *     up as a 500 somewhere later);
 *   * touch anything but `phone_e164` and `phone_verified_at` - the password,
 *     profile, interests, groups and events are all left exactly as they are.
 *
 * The number is *recorded as verified* on purpose: there is no code to send
 * through the `log` transport to a developer's real phone, so the alternative
 * would be a bridging flow that pretends. The tool prints the masked number and
 * the account's display name so the operation is auditable from the terminal.
 */
import type { RowDataPacket } from 'mysql2/promise';

import { pool } from '../db/pool';
import { InvalidPhoneError, maskPhone, normalizePhone } from '../domain/phone';

interface UserRow extends RowDataPacket {
  id: string;
  display_name: string;
  phone_e164: string | null;
}

async function run(): Promise<void> {
  const email = (process.env.PHONE_LINK_EMAIL ?? '').trim().toLowerCase();
  const rawPhone = (process.env.PHONE_LINK_PHONE ?? '').trim();

  if (email.length === 0 || rawPhone.length === 0) {
    throw new Error(
      'Set both values, then run again:\n' +
        "  $env:PHONE_LINK_EMAIL='you@example.com'\n" +
        "  $env:PHONE_LINK_PHONE='+919876543210'\n" +
        '  npm run phone:link',
    );
  }

  // The tool accepts the same shapes the API does, so `9876543210` with `+91`
  // pasted into the same string is normalised rather than rejected.
  const split = /^\+?(\d{1,3})(\d{4,})$/.exec(rawPhone.replace(/[\s()-]/g, ''));
  if (!split?.[1] || !split[2]) {
    throw new Error(`"${rawPhone}" is not a phone number this tool can read. Use the full number, e.g. +919876543210.`);
  }

  let e164: string;
  try {
    e164 = normalizePhone({ countryCode: split[1], nationalNumber: split[2] }).e164;
  } catch (caught) {
    throw new Error(caught instanceof InvalidPhoneError ? caught.message : String(caught));
  }

  const [users] = await pool.query<UserRow[]>(
    'SELECT id, display_name, phone_e164 FROM users WHERE email = ? LIMIT 1',
    [email],
  );

  const user = users[0];
  if (!user) throw new Error(`No account uses ${email}.`);

  if (user.phone_e164 === e164) {
    console.log(`${user.display_name} already signs in with ${maskPhone(e164)}. Nothing to do.`);
    return;
  }

  try {
    await pool.query('UPDATE users SET phone_e164 = ?, phone_verified_at = NOW(3) WHERE id = ?', [e164, user.id]);
  } catch (caught) {
    if ((caught as { errno?: unknown }).errno === 1062) {
      throw new Error(`${maskPhone(e164)} is already attached to a different account.`);
    }
    throw caught;
  }

  console.log(
    `Linked ${maskPhone(e164)} to "${user.display_name}" (${email}).\n` +
      'That account can now sign in with the phone number on the sign-in screen.',
  );
}

run()
  .then(() => undefined)
  .catch((caught: unknown) => {
    console.error(`\n${caught instanceof Error ? caught.message : String(caught)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end().catch(() => undefined);
  });
