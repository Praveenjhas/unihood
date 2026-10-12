/**
 * Phone numbers, as the API understands them.
 *
 * One rule, and everything else follows from it: **a phone number is stored and
 * compared in exactly one shape - E.164** (`+` followed by 8-15 digits, the first
 * of which is not zero). The uniqueness constraint on `users.phone_e164` is only
 * meaningful if `+91 98765 43210`, `+919876543210` and `919876543210` cannot all
 * be stored as different values, so normalisation happens here, before any query,
 * and the column's CHECK is the second line of defence.
 *
 * This module holds no I/O and no SQL, so the rules can be reasoned about (and
 * tested) on their own.
 */

/** Digits in an E.164 number, country code included. */
export const PHONE_MIN_DIGITS = 8;
export const PHONE_MAX_DIGITS = 15;

/** Country calling codes are one to three digits. */
const COUNTRY_CODE_MAX_DIGITS = 3;

/** `+` then 1-9 then 7-14 more digits - the same shape migration 0008 enforces. */
const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

export interface PhoneInput {
  /** `+91`, `91` or `0091` - the caller's chosen dialling code. */
  countryCode: string;
  /** The subscriber number, without the dialling code. */
  nationalNumber: string;
}

/** A parsed, storage-ready number. */
export interface NormalizedPhone {
  /** `+919876543210` - what goes in the database and into a message. */
  e164: string;
  /** Digits only, without the `+`. */
  digits: string;
  /** The first one to three digits, e.g. `91`. */
  countryCode: string;
  /** The rest of the digits. */
  nationalNumber: string;
}

/** Everything that is not a digit, removed. `+`, spaces, dashes, brackets, dots. */
const digitsOf = (value: string): string => value.replace(/\D+/g, '');

/** Raised for anything the caller can fix by re-typing the number. */
export class InvalidPhoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPhoneError';
  }
}

/**
 * Normalises a dialling code to digits.
 *
 * Accepts `+91`, `91` and `0091` - the last one because it is a common spelling
 * in forms and imported data, and it is unambiguous once the leading zeros are
 * dropped. A country code never starts with 0, so `000` is rejected rather than
 * silently becoming an empty string.
 */
function normalizeCountryCode(countryCode: string): string {
  const digits = digitsOf(countryCode.trim());
  const trimmedZeros = digits.replace(/^0+/, '');

  if (digits.length === 0) {
    throw new InvalidPhoneError('Choose a country code.');
  }

  if (trimmedZeros.length === 0 || trimmedZeros.length > COUNTRY_CODE_MAX_DIGITS) {
    throw new InvalidPhoneError('That country code is not valid.');
  }

  return trimmedZeros;
}

/**
 * Parses a number, or throws `InvalidPhoneError` with a sentence for the member.
 *
 * A leading zero on the subscriber part is the one mistake worth naming
 * explicitly: it is what a local-format number looks like, and silently keeping
 * it would store a number that can never receive a message.
 */
export function normalizePhone(input: PhoneInput): NormalizedPhone {
  const countryCode = normalizeCountryCode(input.countryCode);
  const national = digitsOf(input.nationalNumber);

  if (national.length === 0) {
    throw new InvalidPhoneError('Enter your phone number.');
  }

  if (national.startsWith('0')) {
    throw new InvalidPhoneError('Leave out the leading 0 - it is not part of an international number.');
  }

  const digits = `${countryCode}${national}`;

  if (digits.length < PHONE_MIN_DIGITS) {
    throw new InvalidPhoneError('That phone number looks too short.');
  }

  if (digits.length > PHONE_MAX_DIGITS) {
    throw new InvalidPhoneError('That phone number looks too long.');
  }

  const e164 = `+${digits}`;
  if (!E164_PATTERN.test(e164)) {
    throw new InvalidPhoneError('That phone number does not look right.');
  }

  return { e164, digits, countryCode, nationalNumber: national };
}

/** True when the value is *already* stored-shape E.164. */
export function isE164(value: string): boolean {
  return E164_PATTERN.test(value.trim());
}

/**
 * A number safe to show, or to put in a log line.
 *
 * Keeps the dialling code and the last two digits, so a member can recognise the
 * number they are looking at without the full value being readable over a
 * shoulder or in a log file. Used by every response and every console line - a
 * full number is never printed.
 */
export function maskPhone(value: string): string {
  const digits = digitsOf(value);
  if (digits.length <= 4) return `+${'*'.repeat(Math.max(digits.length, 1))}`;
  return `+${'*'.repeat(Math.max(digits.length - 4, 2))}${digits.slice(-4)}`;
}
