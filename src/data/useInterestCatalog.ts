/**
 * The interest catalog, live where possible.
 *
 * `public.interests` is the vocabulary the member actually chose their interests
 * from, so the picker and the filter rows read it from the server. The static
 * catalog stays as the fallback: an unconfigured project, a dropped connection
 * or a failed request must not leave someone staring at an empty chip row, and
 * the *selection* is ids either way, so nothing is silently lost.
 *
 * `isLive` is what callers use to be honest about that: when it is false the list
 * on screen is the client's own copy of the vocabulary, not the project's.
 */
import { useMemo } from 'react';

import { useQuery } from '../lib';
import type { Interest } from '../types';
import { INTERESTS } from './interests';
import { fetchInterestCatalog } from './interestsRepo';

/** A chip-shaped `{ id, label }` pair, ready for `FilterRow`. */
export interface InterestOption {
  id: string;
  label: string;
  /**
   * Catalogue group, carried through so the onboarding picker can render group
   * headings without a second lookup. `null` for the compiled fallback list, which
   * predates the catalogue.
   */
  category: string | null;
}

export interface InterestCatalogValue {
  interests: readonly Interest[];
  /** Plain-string ids, so a screen can hold any id the server returns. */
  options: readonly InterestOption[];
  /** False while the compiled fallback list is standing in for the server one. */
  isLive: boolean;
  isLoading: boolean;
}

/**
 * Reads the catalog once per session.
 *
 * `enabled` follows the session: the table has no anonymous grant, so there is
 * no point asking before the member is signed in.
 */
export function useInterestCatalog(enabled: boolean): InterestCatalogValue {
  const query = useQuery(fetchInterestCatalog, { queryKey: 'interest-catalog', enabled });

  return useMemo(() => {
    const live = query.data && query.data.length > 0 ? query.data : null;
    const interests = live ?? INTERESTS;

    return {
      interests,
      options: interests.map((interest) => ({
        id: interest.id,
        label: interest.label,
        category: typeof interest.category === 'string' ? interest.category : null,
      })),
      isLive: live !== null,
      isLoading: enabled && query.status === 'loading',
    };
  }, [enabled, query.data, query.status]);
}
