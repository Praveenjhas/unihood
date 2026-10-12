/**
 * What makes a place name usable.
 *
 * A group's location and an event's venue are two different things: the label is
 * what a member reads and recognises ("Riverside Park, north gate"), while the
 * coordinate pair - when there is one - is only the anchor the distance maths
 * needs. Since coordinates are optional, a readable label is the *only* thing
 * guaranteed to be present, which is why both services require one whenever an
 * object is created or re-anchored.
 *
 * The rule lives here, with no SQL and no I/O, so `groupService` and
 * `eventService` cannot drift apart - and `src/lib/venue.ts` in the mobile app is
 * the same list, so the form refuses a placeholder before the request is made.
 * Nothing here claims a label is *verified*: it is a human-entered name, and the
 * API never presents it as anything else.
 */

/** The shortest label that can still name a place. */
export const VENUE_LABEL_MIN_LENGTH = 3;

/**
 * Labels that name no place.
 *
 * These are the strings the app itself used to produce ("Point set on map"), the
 * things people type to get past a form ("test", "n/a"), and the generic words
 * that describe a coordinate rather than a venue. Compared case-insensitively,
 * ignoring surrounding space and trailing punctuation.
 */
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

/** A bare decimal pair, which is a coordinate rather than a place name. */
const COORDINATE_PAIR = /^-?\d{1,3}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$/;

/** Letters or digits that are not just punctuation and separators. */
const HAS_WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * A comparable form of a label: case-folded, inner whitespace collapsed and
 * trailing punctuation dropped, so `" Point set on map. "` is the placeholder
 * `"point set on map"`.
 */
function canonicalLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/g, '')
    .trim();
}

/**
 * Whether a label names a place the way a person would recognise it.
 *
 * Deliberately conservative: anything with a word character that is not a known
 * placeholder passes, so a venue the list has never heard of is never refused.
 */
export function isMeaningfulVenueLabel(value: string): boolean {
  const canonical = canonicalLabel(value);
  if (canonical.length < VENUE_LABEL_MIN_LENGTH) return false;
  if (!HAS_WORD_CHARACTER.test(canonical)) return false;
  if (PLACEHOLDER_LABELS.includes(canonical)) return false;
  if (COORDINATE_PAIR.test(canonical)) return false;
  // A label that is only separators once punctuation is dropped (",,,", "---").
  if (canonical.replace(/[^\p{L}\p{N}]/gu, '').length < VENUE_LABEL_MIN_LENGTH) return false;
  return true;
}

/**
 * The sentence for a map position that has no readable name.
 *
 * Exported because the two services raise it from their *anchor* rules (where a
 * coordinate pair is being written but the merged label is `null`) rather than
 * from the label rules, and the members should not read two different sentences
 * for the same mistake.
 */
export const VENUE_LABEL_REQUIRED_MESSAGE =
  'Add the venue name, e.g. “Riverside Park, north gate”. A map pin on its own does not say where to meet.';

/** The sentence for a label that names no place ("test", "Point set on map"). */
export const VENUE_LABEL_UNREADABLE_MESSAGE =
  'That venue name does not say where to meet. Use a real place, e.g. “Riverside Park, north gate”.';

/**
 * Why a label cannot be used, as a sentence for the member, or `null`.
 *
 * Returned rather than thrown so this module stays pure; the callers wrap it in
 * the API's own `badRequest`. The empty case is reported as "required" here
 * because a caller that has no anchor at all should not be calling this with an
 * empty label - the two services pass an empty label only when the member is
 * anchoring something.
 */
export function venueLabelProblem(value: string | null, maxLength: number): string | null {
  if (value === null || value.length === 0) return VENUE_LABEL_REQUIRED_MESSAGE;
  if (value.length > maxLength) return `The venue name must be ${maxLength} characters or fewer.`;
  if (!isMeaningfulVenueLabel(value)) return VENUE_LABEL_UNREADABLE_MESSAGE;
  return null;
}
