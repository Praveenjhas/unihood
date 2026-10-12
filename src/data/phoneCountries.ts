/**
 * Dialling codes for the phone sign-in form.
 *
 * A short, curated list rather than every one of the ~250 ITU assignments: the
 * sign-in screen needs a picker a thumb can operate, and the API accepts any
 * valid E.164 number regardless of whether its code is in this list. India is
 * first because that is the launch market; the rest are the codes a university
 * community is most likely to hold, in alphabetical order by country.
 *
 * The list is data, not a rule: `countryCode` is a free field on the screen for
 * anyone whose code is missing, and the backend is the authority on whether the
 * resulting number is a real E.164 value.
 */
export interface PhoneCountry {
  /** ISO 3166-1 alpha-2, for the key and the flag emoji. */
  iso: string;
  name: string;
  /** Dialling code, `+` included. */
  dialCode: string;
}

export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  { iso: 'IN', name: 'India', dialCode: '+91' },
  { iso: 'AE', name: 'United Arab Emirates', dialCode: '+971' },
  { iso: 'AU', name: 'Australia', dialCode: '+61' },
  { iso: 'BD', name: 'Bangladesh', dialCode: '+880' },
  { iso: 'BR', name: 'Brazil', dialCode: '+55' },
  { iso: 'CA', name: 'Canada', dialCode: '+1' },
  { iso: 'CN', name: 'China', dialCode: '+86' },
  { iso: 'DE', name: 'Germany', dialCode: '+49' },
  { iso: 'EG', name: 'Egypt', dialCode: '+20' },
  { iso: 'ES', name: 'Spain', dialCode: '+34' },
  { iso: 'FR', name: 'France', dialCode: '+33' },
  { iso: 'GB', name: 'United Kingdom', dialCode: '+44' },
  { iso: 'ID', name: 'Indonesia', dialCode: '+62' },
  { iso: 'IE', name: 'Ireland', dialCode: '+353' },
  { iso: 'IT', name: 'Italy', dialCode: '+39' },
  { iso: 'JP', name: 'Japan', dialCode: '+81' },
  { iso: 'KE', name: 'Kenya', dialCode: '+254' },
  { iso: 'KR', name: 'South Korea', dialCode: '+82' },
  { iso: 'LK', name: 'Sri Lanka', dialCode: '+94' },
  { iso: 'MY', name: 'Malaysia', dialCode: '+60' },
  { iso: 'NG', name: 'Nigeria', dialCode: '+234' },
  { iso: 'NP', name: 'Nepal', dialCode: '+977' },
  { iso: 'NL', name: 'Netherlands', dialCode: '+31' },
  { iso: 'NZ', name: 'New Zealand', dialCode: '+64' },
  { iso: 'PK', name: 'Pakistan', dialCode: '+92' },
  { iso: 'PH', name: 'Philippines', dialCode: '+63' },
  { iso: 'RU', name: 'Russia', dialCode: '+7' },
  { iso: 'SA', name: 'Saudi Arabia', dialCode: '+966' },
  { iso: 'SG', name: 'Singapore', dialCode: '+65' },
  { iso: 'TH', name: 'Thailand', dialCode: '+66' },
  { iso: 'TR', name: 'Turkey', dialCode: '+90' },
  { iso: 'US', name: 'United States', dialCode: '+1' },
  { iso: 'VN', name: 'Vietnam', dialCode: '+84' },
  { iso: 'ZA', name: 'South Africa', dialCode: '+27' },
];

/** The default selection: the first entry, i.e. the launch market. */
export const DEFAULT_PHONE_COUNTRY: PhoneCountry = PHONE_COUNTRIES[0] as PhoneCountry;

/**
 * The flag emoji for an ISO code, built from the regional indicator symbols.
 *
 * Presentation only, and it degrades to nothing on a platform without the glyphs
 * rather than being a source of truth for anything.
 */
export function countryFlag(iso: string): string {
  if (!/^[A-Za-z]{2}$/.test(iso)) return '';
  return String.fromCodePoint(
    ...[...iso.toUpperCase()].map((character) => 0x1f1e6 + character.charCodeAt(0) - 65),
  );
}

/** Finds a country by dialling code, for a number stored as E.164. */
export function countryForDialCode(dialCode: string): PhoneCountry | undefined {
  return PHONE_COUNTRIES.find((country) => country.dialCode === dialCode);
}
