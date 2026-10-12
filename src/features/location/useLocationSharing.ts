/**
 * One-shot location sharing.
 *
 * The app's least-privilege location policy, in code:
 *   * permission is only ever requested from a direct tap, and only *after* the
 *     screen has explained what will be stored (the pre-prompt copy the member
 *     reads before the OS dialog appears);
 *   * a single coarse fix is read per tap (`Accuracy.Low`) — no watcher, no
 *     background updates, no polling;
 *   * the fix goes straight to `set_my_location`, which rounds it to ~11 m, and
 *     nothing is kept in component state afterwards;
 *   * the only thing the UI remembers is *when* the server stored it.
 */
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';

import { describeError } from '../../lib';
import { forgetMyLocation, updateMyLocation } from './locationRepo';

export type LocationPermissionState = 'checking' | 'undetermined' | 'granted' | 'denied' | 'unavailable';

export type LocationSharingStatus = 'idle' | 'working' | 'shared' | 'denied' | 'error';

export interface LocationSharingValue {
  permission: LocationPermissionState;
  status: LocationSharingStatus;
  isWorking: boolean;
  /** One actionable sentence when `status` is `error`. */
  errorMessage: string | null;
  /** Server timestamp of the last stored fix, or `null` if none was stored. */
  locationUpdatedAt: string | null;
  /** Reads one coarse fix and stores it. Never polls. */
  share: () => Promise<void>;
  /** Deletes the stored fix server-side. */
  forget: () => Promise<void>;
  /** Clears the last outcome so a banner can be dismissed. */
  reset: () => void;
}

function mapPermission(response: Location.LocationPermissionResponse): LocationPermissionState {
  if (response.granted) return 'granted';
  return response.canAskAgain ? 'undetermined' : 'denied';
}

export interface LocationSharingOptions {
  /**
   * The stored-fix timestamp from the profile row, read once on mount as the
   * starting value for the status line. It is *seeded*, not tracked: after that
   * the only fix this hook knows about is one this screen stored, because a
   * profile refresh can also clear the location (see the editor's switches).
   */
  initialUpdatedAt?: string | null;
}

export function useLocationSharing({ initialUpdatedAt = null }: LocationSharingOptions = {}): LocationSharingValue {
  const [permission, setPermission] = useState<LocationPermissionState>('checking');
  const [status, setStatus] = useState<LocationSharingStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [locationUpdatedAt, setLocationUpdatedAt] = useState<string | null>(initialUpdatedAt);

  // A screen can be left mid-request; the flags below are only meaningful while
  // this hook is mounted, so late results are dropped rather than applied.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Existing permission is read, never requested, on mount: opening a screen
  // must not trigger an OS prompt.
  useEffect(() => {
    let active = true;

    void Location.getForegroundPermissionsAsync()
      .then((response) => {
        if (active) setPermission(mapPermission(response));
      })
      .catch(() => {
        if (active) setPermission('unavailable');
      });

    return () => {
      active = false;
    };
  }, []);

  const share = useCallback(async () => {
    setStatus('working');
    setErrorMessage(null);

    try {
      const existing = await Location.getForegroundPermissionsAsync();
      const response = existing.granted || !existing.canAskAgain
        ? existing
        : await Location.requestForegroundPermissionsAsync();

      if (!mountedRef.current) return;
      setPermission(mapPermission(response));

      if (!response.granted) {
        setStatus('denied');
        return;
      }

      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        if (!mountedRef.current) return;
        setStatus('error');
        setErrorMessage('Location is switched off for this device. Turn it on and try again.');
        return;
      }

      // One coarse fix. The server rounds further; this is the least precision
      // that still supports a 1 km search.
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
      const stored = await updateMyLocation({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      });

      if (!mountedRef.current) return;
      setLocationUpdatedAt(stored.locationUpdatedAt);
      setStatus('shared');
    } catch (caught) {
      if (!mountedRef.current) return;
      setStatus('error');
      setErrorMessage(describeError(caught));
    }
  }, []);

  const forget = useCallback(async () => {
    setStatus('working');
    setErrorMessage(null);

    try {
      await forgetMyLocation();
      if (!mountedRef.current) return;
      setLocationUpdatedAt(null);
      setStatus('idle');
    } catch (caught) {
      if (!mountedRef.current) return;
      setStatus('error');
      setErrorMessage(describeError(caught));
    }
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setErrorMessage(null);
  }, []);

  return {
    permission,
    status,
    isWorking: status === 'working',
    errorMessage,
    locationUpdatedAt,
    share,
    forget,
    reset,
  };
}
