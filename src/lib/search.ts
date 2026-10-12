/** Small, dependency-free text matching helpers used by the search fields. */

/** Lower-cases and trims so matching is forgiving of casing and stray spaces. */
export function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

/** True when any of the provided haystacks contains the query. */
export function matchesAny(haystack: readonly (string | undefined)[], query: string): boolean {
  const needle = normalizeQuery(query);
  if (!needle) return true;
  return haystack.some((entry) => (entry ?? '').toLowerCase().includes(needle));
}
