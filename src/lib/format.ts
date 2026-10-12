/** Presentation-level formatting helpers shared by cards and detail screens. */

/** `Amara Osei` -> `AO`. Handles single names and extra whitespace safely. */
export function initialsFromName(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  // Long names ("Priya Raghunathan") still produce two clean initials.
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return `${first}${last}`.toUpperCase();
}

/** `1240` -> `1.2k`, `980` -> `980`. Keeps card metadata compact. */
export function formatCompactNumber(value: number): string {
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

/** `1 member` / `128 members`. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** `128 members` */
export function formatMemberCount(count: number): string {
  return pluralize(count, 'member');
}

/** `38 of 60 going`, or `12 going` when there is no capacity. */
export function formatAttendance(count: number, capacity?: number): string {
  return capacity ? `${count} of ${capacity} going` : `${count} going`;
}

/** How full an event is, clamped to 0–1. Returns `null` when uncapped. */
export function capacityRatio(count: number, capacity?: number): number | null {
  if (!capacity || capacity <= 0) return null;
  return Math.min(Math.max(count / capacity, 0), 1);
}

/** Truncates on a word boundary where possible. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
