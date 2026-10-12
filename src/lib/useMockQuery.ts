import { useCallback, useEffect, useRef, useState } from 'react';

export type QueryStatus = 'loading' | 'error' | 'success';

export interface QueryResult<T> {
  status: QueryStatus;
  data: T | null;
  error: Error | null;
  /** Re-runs the loader — wired to the "Try again" button on error states. */
  retry: () => void;
}

export interface QueryOptions {
  /**
   * Stable key that re-runs the loader when it changes (search term, active
   * filters, …). Keep it cheap to build, e.g. a joined string.
   */
  queryKey?: string;
  /** Simulated latency in ms, so the skeleton state is actually reachable. */
  delayMs?: number;
}

interface QueryState<T> {
  /** Identifies the query run this result belongs to (see `token` below). */
  token: string;
  status: QueryStatus;
  data: T | null;
  error: Error | null;
}

/**
 * Tiny async-shaped wrapper around a synchronous data source.
 *
 * It exists for the two features that still run on the in-app catalogs (Groups
 * and Events): their screens are written against `{ status, data, error, retry }`
 * — exactly the shape a real request hook exposes — so when a catalog moves to the
 * server the screen keeps its loading/error/empty branches and only the hook
 * changes. Live features use `useQuery` instead, which speaks the same language
 * with a promise.
 *
 * "Loading" is derived, not stored: a result only counts if its `token` matches
 * the currently requested run, so a new key is `loading` on the very first
 * render after it changes and no state is set synchronously inside the effect.
 */
export function useMockQuery<T>(loader: () => T, options: QueryOptions = {}): QueryResult<T> {
  const { queryKey = 'default', delayMs = 240 } = options;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<QueryState<T> | null>(null);

  // One token per (key, attempt) pair: retry() changes it, which is what flips
  // the derived status back to 'loading'.
  const token = `${queryKey}#${attempt}`;

  // Keep the latest loader without re-running the effect on every render: the
  // effect is keyed on `token`, not on the closure identity.
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  }, [loader]);

  useEffect(() => {
    let cancelled = false;

    const timer = setTimeout(() => {
      if (cancelled) return;
      try {
        setState({ token, status: 'success', data: loaderRef.current(), error: null });
      } catch (caught) {
        setState({
          token,
          status: 'error',
          data: null,
          error: caught instanceof Error ? caught : new Error('Something went wrong while loading this screen.'),
        });
      }
    }, delayMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token, delayMs]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  if (state !== null && state.token === token) {
    return { status: state.status, data: state.data, error: state.error, retry };
  }

  return { status: 'loading', data: null, error: null, retry };
}
