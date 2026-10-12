import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';

/**
 * Re-runs a query when its screen comes back into focus.
 *
 * Pull-to-refresh is for the member's own gesture; this is for the trip *back* from
 * somewhere else - a group joined, an RSVP answered, a profile saved two screens
 * ago must not still be missing from the list they return to. The mechanism is a
 * re-run of the same loader, never a restart of the app or a remount of the tree.
 *
 * The first focus is skipped on purpose: it is the one that has just loaded the
 * screen, and re-running then would double every request the moment a tab opens.
 *
 * `refresh` comes from `useQuery` and is stable, so the focus effect is registered
 * once per screen rather than re-subscribed on every render. **The callback has to
 * be stable too** (wrap it in `useCallback`): a new identity on every render would
 * re-register the effect while the screen is focused, and each re-registration runs
 * the loader again - a refresh loop, not a refresh.
 */
export function useRefreshOnFocus(refresh: () => void): void {
  const isFirstFocus = useRef(true);

  useFocusEffect(
    useCallback(() => {
      if (isFirstFocus.current) {
        isFirstFocus.current = false;
        return;
      }
      refresh();
    }, [refresh]),
  );
}
