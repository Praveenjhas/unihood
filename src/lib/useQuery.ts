import { useCallback, useEffect, useRef, useState } from 'react';

import { toError } from './errors';
import type { QueryStatus } from './useMockQuery';

export interface AsyncQueryResult<T> {
  status: QueryStatus;
  data: T | null;
  /**
   * Non-null while a run is failing. A *refresh* that fails keeps the last good
   * data on screen and reports the problem here instead of blanking the list.
   */
  error: Error | null;
  /** Re-runs the loader and shows the loading state again ("Try again"). */
  retry: () => void;
  /** Re-runs the loader but keeps the current data ("pull to refresh"). */
  refresh: () => void;
  isRefreshing: boolean;
}

export interface AsyncQueryOptions {
  /**
   * Identity of the query: changing it discards the current result and loads
   * again (search term, active filters, …). Keep it cheap to build.
   */
  queryKey?: string;
  /**
   * When false the loader is never called and the query stays in `loading`.
   * Screens use this to wait for something else first — a session, or a
   * configured backend — without breaking the rules of hooks.
   */
  enabled?: boolean;
}

interface QueryState<T> {
  status: QueryStatus;
  data: T | null;
  error: Error | null;
}

/**
 * Async counterpart to `useMockQuery`, with the same `{ status, data, error,
 * retry }` contract so both hooks can drive identical screen branches.
 *
 * Differences from the mock hook, all of them deliberate:
 * - it takes a promise, and every run is stale-guarded, so an out-of-order
 *   response from a previous key can never overwrite a newer one;
 * - a failed refresh keeps the previous data (`data !== null`, `error !== null`)
 *   because losing a rendered list to one dropped packet is worse than showing
 *   a stale one;
 * - a failed initial load clears the data, so an error state can never be
 *   mistaken for an empty one.
 */
export function useQuery<T>(loader: () => Promise<T>, options: AsyncQueryOptions = {}): AsyncQueryResult<T> {
  const { queryKey = 'default', enabled = true } = options;

  const [state, setState] = useState<QueryState<T> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Reset when the query identity changes. Done during render — React's
  // documented pattern for adjusting state when an input changes — because an
  // effect would let one frame of the previous key's results reach the screen.
  const [identity, setIdentity] = useState(queryKey);
  if (identity !== queryKey) {
    setIdentity(queryKey);
    setState(null);
    setIsRefreshing(false);
  }

  // The loader closure changes on every render; keeping it in a ref means the
  // run effects below are keyed on the query inputs, not on that identity.
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  // Runs are numbered and only a completion newer than the last applied one may
  // touch state. This is what makes a slow first search unable to overwrite the
  // results of a fast second one, and a manual refresh unable to resurrect a
  // list that a new search term has already replaced.
  const startedRunRef = useRef(0);
  const appliedRunRef = useRef(0);

  /** Runs the loader and normalizes both outcomes into a state value. */
  const execute = useCallback(async (): Promise<QueryState<T>> => {
    try {
      const data = await loaderRef.current();
      return { status: 'success', data, error: null };
    } catch (caught) {
      return { status: 'error', data: null, error: toError(caught) };
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const runId = (startedRunRef.current += 1);

    void (async () => {
      const next = await execute();
      if (cancelled || runId <= appliedRunRef.current) return;
      appliedRunRef.current = runId;
      setState(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, queryKey, attempt, execute]);

  useEffect(() => {
    // `refreshKey === 0` is the pre-first-refresh state, not a refresh request.
    if (!enabled || refreshKey === 0) return;
    let cancelled = false;
    const runId = (startedRunRef.current += 1);

    void (async () => {
      const next = await execute();
      if (cancelled) return;
      setIsRefreshing(false);
      if (runId <= appliedRunRef.current) return;
      appliedRunRef.current = runId;
      setState((current) =>
        // A refresh that fails is a notice, not a wipe: the previous result
        // stays on screen and the error is surfaced alongside it.
        next.status === 'error' && current?.status === 'success'
          ? { status: 'success', data: current.data, error: next.error }
          : next,
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey, execute]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const refresh = useCallback(() => {
    // The spinner is raised here, where the refresh is requested, rather than in
    // the effect below: an effect body that sets state synchronously triggers a
    // second render pass for something a handler already knows.
    if (enabled) setIsRefreshing(true);
    setRefreshKey((value) => value + 1);
  }, [enabled]);

  return {
    status: state?.status ?? 'loading',
    data: state?.data ?? null,
    error: state?.error ?? null,
    retry,
    refresh,
    isRefreshing,
  };
}
