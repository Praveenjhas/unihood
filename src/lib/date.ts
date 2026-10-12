/**
 * Date/time helpers.
 *
 * All campus dates are wall-clock local dates, so we never use `Date.parse`
 * (which would interpret `YYYY-MM-DD` as UTC and shift the day for students in
 * non-UTC timezones). Everything is built from numeric parts instead.
 */

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Serialises a `Date` to a local `YYYY-MM-DD` string. */
export function toDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The device-local `YYYY-MM-DD` of a UTC ISO instant.
 *
 * The API stores and returns every timestamp in UTC (`2026-10-10T18:00:00.000Z`),
 * and a *listings* screen has to show the day the member will actually turn up on,
 * which is a local-calendar question. Everything in this section is that
 * translation, in both directions, so no screen has to do date arithmetic itself.
 */
export function toLocalDateString(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return toDateString(new Date());
  return toDateString(date);
}

/** The device-local `HH:mm` of a UTC ISO instant. */
export function toLocalTimeString(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return '00:00';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Combines a device-local `YYYY-MM-DD` and a local 24-hour `HH:mm` into the UTC
 * ISO instant the API expects. Returns `null` when either part is unreadable, so a
 * half-typed form can never send a made-up time.
 */
export function isoFromLocal(dateValue: string, timeValue: string): string | null {
  const [year, month, day] = dateValue.trim().split('-').map(Number);
  const [hours, minutes] = timeValue.trim().split(':').map(Number);
  if (!year || !month || !day || Number.isNaN(hours) || Number.isNaN(minutes)) return null;

  const date = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** True when a UTC ISO instant is in the past - or unreadable, which is not "upcoming". */
export function isPastInstant(instant: string | null | undefined): boolean {
  if (!instant) return true;
  const time = Date.parse(instant);
  return !Number.isFinite(time) || time <= Date.now();
}

/** `Today` / `Tomorrow` / `Sat 14 Mar` for a UTC ISO instant, in local time. */
export function formatInstantDay(instant: string): string {
  return formatRelativeDay(toLocalDateString(instant));
}

/** `6:30 PM – 9:00 PM` in the device's timezone. */
export function formatInstantTimeRange(startAt: string, endAt?: string | null): string {
  return formatTimeRange(toLocalTimeString(startAt), endAt ? toLocalTimeString(endAt) : undefined);
}

/** `Today · 6:30 PM – 9:00 PM` - the one-line answer to "when is it?". */
export function formatInstantWhen(startAt: string, endAt?: string | null): string {
  return `${formatInstantDay(startAt)} · ${formatInstantTimeRange(startAt, endAt)}`;
}

/** Parses `YYYY-MM-DD` into a local `Date` at midday (avoids DST edge cases). */
export function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid date string: "${value}". Expected YYYY-MM-DD.`);
  }
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

/** `14` — used as the big numeral in the event date block. */
export function formatDayOfMonth(value: string): string {
  return String(parseLocalDate(value).getDate());
}

/** `MAR` — month label for the event date block. */
export function formatMonthShort(value: string): string {
  return MONTHS_SHORT[parseLocalDate(value).getMonth()].toUpperCase();
}

/** `Saturday` */
export function formatWeekdayLong(value: string): string {
  return WEEKDAYS_LONG[parseLocalDate(value).getDay()];
}

/** `Sat 14 Mar` */
export function formatShortDate(value: string): string {
  const date = parseLocalDate(value);
  return `${WEEKDAYS_SHORT[date.getDay()]} ${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
}

/** Converts a 24-hour `HH:mm` string to `6:30 PM`. */
export function formatTime(value: string): string {
  const [hoursRaw, minutesRaw] = value.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return value;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHours}:${pad(minutes)} ${suffix}`;
}

/** `6:30 PM – 9:00 PM`, or `6:30 PM` when no end time is given. */
export function formatTimeRange(start: string, end?: string): string {
  return end ? `${formatTime(start)} – ${formatTime(end)}` : formatTime(start);
}

/** `Today`, `Tomorrow`, otherwise `Sat 14 Mar`. */
export function formatRelativeDay(value: string): string {
  const target = toDateString(parseLocalDate(value));
  if (target === toDateString(new Date())) return 'Today';
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (target === toDateString(tomorrow)) return 'Tomorrow';
  return formatShortDate(value);
}

/** True when the given `YYYY-MM-DD` is before today. */
export function isPastDate(value: string): boolean {
  return parseLocalDate(value).getTime() < parseLocalDate(toDateString(new Date())).getTime();
}

/** Validates the `YYYY-MM-DD` shape and that the date actually exists. */
export function isDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  try {
    return toDateString(parseLocalDate(value.trim())) === value.trim();
  } catch {
    return false;
  }
}

/** Validates a 24-hour `HH:mm` string. */
export function isTimeString(value: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}
