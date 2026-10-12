/**
 * The interest vocabulary.
 *
 * Read-only by design: `interests` is seeded by migration `0002` and the API
 * exposes no write path, so a member cannot invent a filter or attach a category
 * that does not exist. The table's `CHECK` on `id` is the second half of that
 * guarantee.
 */
import type { RowDataPacket } from 'mysql2/promise';

import { pool } from '../db/pool';

export interface InterestOption {
  id: string;
  label: string;
  /**
   * The catalogue category the interest belongs to, e.g. `programming_tech`.
   *
   * Sent as a stable slug rather than as a display name: the mobile picker holds
   * the labels (it has to render them in the Campus Editorial type scale anyway),
   * and a slug cannot drift out of sync with a typo in a seed.
   */
  category: string;
}

interface InterestRow extends RowDataPacket {
  id: string;
  name: string;
  category: string;
}

interface InterestIdRow extends RowDataPacket {
  id: string;
}

/**
 * Active interests, in a deterministic order.
 *
 * `category` then `sort_order` then `name`: the rows arrive already grouped, and
 * the picker re-orders the *categories* into the product's own sequence (it holds
 * the labels and the intended reading order). The tie-break on `name` exists so
 * two interests that share a `sort_order` never swap places between requests.
 */
export async function listActiveInterests(): Promise<InterestOption[]> {
  const [rows] = await pool.query<InterestRow[]>(
    'SELECT id, name, category FROM interests WHERE is_active = 1 ORDER BY category ASC, sort_order ASC, name ASC',
  );

  return rows.map((row) => ({ id: row.id, label: row.name, category: row.category }));
}

/** Every category that has at least one active interest, in alphabetical order. */
export async function listInterestCategories(): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT DISTINCT category FROM interests WHERE is_active = 1 ORDER BY category ASC',
  );

  return rows.map((row) => String(row.category));
}

/**
 * The subset of `ids` that exist and are active.
 *
 * Used when saving a profile: the request is rejected outright if anything it
 * asked for is unknown or has been deactivated, rather than silently dropping
 * the member's choices and letting the form disagree with the database.
 */
export async function activeInterestIds(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  // Placeholders are generated, but the *values* are always bound - the only
  // string interpolation in this codebase that touches SQL, and it emits `?`.
  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await pool.query<InterestIdRow[]>(
    `SELECT id FROM interests WHERE is_active = 1 AND id IN (${placeholders})`,
    [...ids],
  );

  return new Set(rows.map((row) => row.id));
}
