/**
 * Live interest catalog.
 *
 * The catalog is server-owned: `GET /api/interests` is the only way to read it,
 * an authenticated member is the only caller who may, and the sign-up flow cannot
 * invent an interest. The static catalog in `./interests` stays as the
 * offline/fallback list (and as the label resolver for ids the seed has not
 * shipped yet), but this is what the filter rows and the interest picker render
 * once a session exists.
 */
import { apiRequest } from '../lib';
import type { Interest } from '../types';

/** `{ id, label, category }` is already the shape the chips render. */
interface InterestPayload {
  id: string;
  label: string;
  category?: string | null;
}

/**
 * Active interests, in the order the seed defines.
 *
 * Only readable by a signed-in member, so callers must gate this behind a
 * session - `useQuery`'s `enabled` flag is the intended tool.
 */
export async function fetchInterestCatalog(): Promise<Interest[]> {
  const payload = await apiRequest<{ interests?: InterestPayload[] | null }>('/api/interests');

  return (payload?.interests ?? []).map((entry) => ({
    id: entry.id,
    label: entry.label,
    category: typeof entry.category === 'string' ? entry.category : null,
  }));
}
