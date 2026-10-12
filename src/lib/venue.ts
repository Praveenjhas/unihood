/**
 * What makes a place name usable - the mobile mirror of
 * `backend/src/domain/venue.ts`.
 *
 * The API decides; this file exists so a form can refuse a placeholder *before*
 * the request is made, and so both the group form and the event form give the
 * same answer. The list of placeholders is deliberately the same strings, case
 * folded, with trailing punctuation and repeated whitespace removed.
 */

/** The shortest label that can still name a place. */
export const VENUE_LABEL_MIN_LENGTH = 3;

const PLACEHOLDER_LABELS: readonly string[] = [
  'point set on map',
  'pin set on map',
  'point on map',
  'pinned on map',
  'map point',
  'marked on map',
  'location on map',
  'location set',
  'location',
  'my location',
  'current location',
  'device location',
  'gps',
  'gps location',
  'coordinates',
  'coords',
  'latitude, longitude',
  'unknown',
  'unspecified',
  'not specified',
  'not set',
  'unset',
  'n/a',
  'na',
  'none',
  'null',
  'nil',
  'tbd',
  'tba',
  'to be decided',
  'to be confirmed',
  'to be announced',
  'venue to be confirmed',
  'venue to be decided',
  'somewhere',
  'anywhere',
  'here',
  'there',
  'test',
  'testing',
  'asdf',
  'x',
  'xx',
  'xxx',
  'no location',
  'no venue',
  'placeholder',
  'foo',
  'bar',
];

const COORDINATE_PAIR = /^-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$/;

function canonicalLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/g, '')
    .trim();
}

/** Whether a label names a place the way a person would recognise it. */
export function isMeaningfulVenueLabel(value: string): boolean {
  const canonical = canonicalLabel(value);
  if (canonical.length < VENUE_LABEL_MIN_LENGTH) return false;
  if (PLACEHOLDER_LABELS.includes(canonical)) return false;
  if (COORDINATE_PAIR.test(canonical)) return false;
  const wordCharacters = canonical.replace(/[^0-9a-z\u00c0-\u024f]/gi, '').length;
  return wordCharacters >= VENUE_LABEL_MIN_LENGTH;
}

/**
 * The sentence for a map position that has no readable name.
 *
 * Word for word the same as `VENUE_LABEL_REQUIRED_MESSAGE` in
 * `backend/src/domain/venue.ts`: the member must not read one thing when the form
 * refuses and another when the server does.
 */
export const VENUE_LABEL_REQUIRED_MESSAGE =
  'Add the venue name, e.g. “Riverside Park, north gate”. A map pin on its own does not say where to meet.';

/** The sentence for a label that names no place ("test", "Point set on map"). */
export const VENUE_LABEL_UNREADABLE_MESSAGE =
  'That venue name does not say where to meet. Use a real place, e.g. “Riverside Park, north gate”.';

/** How long a label may be, per form. The API enforces the same numbers. */
export interface VenueLabelRules {
  /** True when the label is the only thing naming the place, so it is required. */
  required: boolean;
  maxLength: number;
}

/**
 * Why a label cannot be used, as a sentence for the member, or `null`.
 *
 * A map position with no readable name is the case this exists for: a pin says
 * "here", a name says where to meet.
 */
export function venueLabelProblem(value: string, rules: VenueLabelRules): string | null {
  const label = value.trim();
  if (label.length === 0) {
    return rules.required ? VENUE_LABEL_REQUIRED_MESSAGE : null;
  }
  if (label.length > rules.maxLength) {
    return `Keep the venue name to ${rules.maxLength} characters or fewer.`;
  }
  if (!isMeaningfulVenueLabel(label)) {
    return VENUE_LABEL_UNREADABLE_MESSAGE;
  }
  return null;
}
