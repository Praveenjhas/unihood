import { useEffect, useState } from 'react';

/**
 * Returns `value` once it has stopped changing for `delayMs`.
 *
 * The discovery screens key their query on this rather than on the raw input, so
 * typing a five-character name runs one query instead of five — and the loading
 * skeleton does not strobe under the search field while someone is mid-word.
 */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
