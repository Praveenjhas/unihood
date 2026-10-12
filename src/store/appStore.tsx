import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Local UI state that is *not* part of the account: the members this device has
 * bookmarked.
 *
 * Scope note, because it changed: this store used to hold "groups I joined" and
 * "events I am going to" as in-memory lists, because those catalogues were mock
 * data. Groups (Phase 3) and events and RSVPs (Phase 4) are rows in MySQL now, so
 * they no longer live here - the server is the single source of truth, and a local
 * copy would only be a second, stale answer to "am I going?". What is left is
 * genuinely device-local: a bookmark with no server row behind it. The signed-in
 * profile deliberately does **not** live here either - it is owned by
 * `AuthProvider` (`useAuth()`), the only place that knows the session.
 */
export interface AppStoreValue {
  /** Members this device has bookmarked. Local only. */
  savedPersonIds: readonly string[];

  isPersonSaved: (personId: string) => boolean;
  toggleSavedPerson: (personId: string) => void;
}

const AppStoreContext = createContext<AppStoreValue | null>(null);

/** Adds the id if absent, removes it if present — never mutates the input. */
function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

export function AppStoreProvider({ children }: { children: ReactNode }) {
  // Seeded empty: with no server row behind them, pre-bookmarked members would be
  // fake state the user never chose.
  const [savedPersonIds, setSavedPersonIds] = useState<string[]>([]);

  const toggleSavedPerson = useCallback((personId: string) => {
    setSavedPersonIds((current) => toggleId(current, personId));
  }, []);

  // The derived lookup keeps this provider the single source of truth — screens
  // never hold a second copy of "have I saved this person?".
  const value = useMemo<AppStoreValue>(
    () => ({
      savedPersonIds,
      isPersonSaved: (personId) => savedPersonIds.includes(personId),
      toggleSavedPerson,
    }),
    [savedPersonIds, toggleSavedPerson],
  );

  return <AppStoreContext.Provider value={value}>{children}</AppStoreContext.Provider>;
}

/**
 * Reads the app store. Throws when used outside `AppStoreProvider` so a missing
 * provider fails loudly during development instead of rendering empty screens.
 */
export function useAppStore(): AppStoreValue {
  const context = useContext(AppStoreContext);
  if (!context) {
    throw new Error('useAppStore must be used inside an <AppStoreProvider>.');
  }
  return context;
}
