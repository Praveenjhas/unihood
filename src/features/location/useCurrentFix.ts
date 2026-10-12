/**
 * One-shot location *read*, with no write.
 *
 * `useLocationSharing` pairs the permission conversation with a write to
 * `PUT /api/location/me`. Onboarding needs the two halves apart: it must obtain a
 * fix and then ask the member to confirm it before anything is stored, because
 * "we stored your position" is not something to do before asking.
 *
 * The least-privilege rules are the same as the sharing hook:
 *   * permission is only requested from a direct tap, never on mount;
 *   * one coarse fix per tap (`Accuracy.Low`), no watcher, no background updates;
 *   * nothing is kept beyond the pending fix in this hook's state, and the caller
 *     drops it as soon as it has been written or rejected.
 */
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';

import { describeError } from '../../lib';
import type { LocationPermissionState } from './useLocationSharing';

export type CurrentFixStatus = 'idle' | 'working' | 'ready' | 'denied' | 'error';

export interface CurrentFix {
  latitude: number;
  longitude: number;
}

export interface CurrentFixValue {
  permission: LocationPermissionState;
  status: CurrentFixStatus;
  isWorking: boolean;
  /** The fix awaiting confirmation. Cleared by `reset`, never stored by this hook. */
  fix: CurrentFix | null;
  /** One actionable sentence when `status` is `error`. */
  errorMessage: string | null;
  /** Requests permission if needed, then reads one coarse fix. */
  requestFix: () => Promise<void>;
  /** Drops the pending fix and returns to `idle`. */
  reset: () => void;
}

function mapPermission(response: Location.LocationPermissionResponse): LocationPermissionState {
  if (response.granted) return 'granted';
  return response.canAskAgain ? 'undetermined' : 'denied';
}

export function useCurrentFix(): CurrentFixValue {
  const [permission, setPermission] = useState<LocationPermissionState>('checking');
  const [status, setStatus] = useState<CurrentFixStatus>('idle');
  const [fix, setFix] = useState<CurrentFix | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Existing permission is read, never requested, on mount: opening a screen must
  // not trigger an OS prompt.
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

  const requestFix = useCallback(async () => {
    setStatus('working');
    setErrorMessage(null);
    setFix(null);

    try {
      const existing = await Location.getForegroundPermissionsAsync();
      const response =
        existing.granted || !existing.canAskAgain ? existing : await Location.requestForegroundPermissionsAsync();

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

      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
      if (!mountedRef.current) return;

      setFix({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      setStatus('ready');
    } catch (caught) {
      if (!mountedRef.current) return;
      setStatus('error');
      setErrorMessage(describeError(caught));
    }
  }, []);

  const reset = useCallback(() => {
    setFix(null);
    setStatus('idle');
    setErrorMessage(null);
  }, []);

  return {
    permission,
    status,
    isWorking: status === 'working',
    fix,
    errorMessage,
    requestFix,
    reset,
  };
}
