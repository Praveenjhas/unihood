/**
 * The two transactional emails.
 *
 * Kept deliberately plain and identical in structure: a member who has just
 * signed up should be able to tell at a glance which of the two messages is in
 * front of them, and both must survive a text-only client because the whole
 * point of the link is that it gets clicked.
 */
import { env } from '../config/env';

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const SIGNATURE = 'Unihood';

export function verificationEmail(displayName: string, link: string): EmailContent {
  const subject = 'Confirm your Unihood email address';

  const text = [
    `Hi ${displayName},`,
    '',
    'One tap confirms this address and switches your Unihood account on.',
    'Open the link on the device you want to use:',
    '',
    link,
    '',
    'The link works once and stops working if it is left unopened.',
    'If you did not create an account, you can ignore this message.',
    '',
    SIGNATURE,
  ].join('\n');

  const html = [
    `<p>Hi ${escapeHtml(displayName)},</p>`,
    '<p>One tap confirms this address and switches your Unihood account on. ',
    'Open the link on the device you want to use:</p>',
    `<p><a href="${escapeHtml(link)}">Confirm this email address</a></p>`,
    '<p>The link works once and stops working if it is left unopened. ',
    'If you did not create an account, you can ignore this message.</p>',
    `<p>${SIGNATURE}</p>`,
  ].join('\n');

  return { subject, text, html };
}

export function passwordResetEmail(displayName: string, link: string): EmailContent {
  const subject = 'Reset your Unihood password';

  const text = [
    `Hi ${displayName},`,
    '',
    'Open this link to choose a new password:',
    '',
    link,
    '',
    'The link works once and expires shortly. Choosing a new password signs you out',
    'everywhere else.',
    '',
    'If you did not ask for this, ignore the message - your current password is',
    'unchanged and still works.',
    '',
    SIGNATURE,
  ].join('\n');

  const html = [
    `<p>Hi ${escapeHtml(displayName)},</p>`,
    '<p>Open this link to choose a new password:</p>',
    `<p><a href="${escapeHtml(link)}">Choose a new password</a></p>`,
    '<p>The link works once and expires shortly. Choosing a new password signs you out everywhere else.</p>',
    '<p>If you did not ask for this, ignore the message - your current password is unchanged and still works.</p>',
    `<p>${SIGNATURE}</p>`,
  ].join('\n');

  return { subject, text, html };
}

/** The API's own landing page for a link clicked from an email. */
export function isPublicApiConfigured(): boolean {
  return env.api.publicUrl.length > 0;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
