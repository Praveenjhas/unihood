/**
 * One-shot device location read, for a *place* the member is naming: a group's
 * meeting point or an event's venue.
 *
 * Deliberately *not* `useLocationSharing`. That hook stores a fix against the
 * member's private row through `PUT /api/location/me`, which is exactly what a
 * place anchor must never be: the anchor is a separate record, it belongs to the
 * group or the event, and it is only ever written when the member explicitly
 * chooses the position in the form.
 *
 * The permission etiquette is the same as the profile one, on purpose:
 *   * permission is read, never requested, on mount, so opening a form cannot raise
 *     an OS dialog;
 *   * a request happens only from a direct tap on "Use my current location";
 *   * one coarse fix (`Accuracy.Low`) is read per tap - no watcher, no polling;
 *   * the coordinate is handed straight back to the caller and kept nowhere else.
 *
 * `subject` only changes the wording of a failed read ("the group has no anchor
 * yet" / "the venue is not set yet"); the behaviour is identical, which is why the
 * event form reuses this hook rather than growing a second one.
 */
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';

import { describeError } from '../../lib';

export type AnchorPermissionState = 'checking' | 'undetermined' | 'granted' | 'denied' | 'unavailable';

export interface GroupLocationAnchor {
  permission: AnchorPermissionState;
  isWorking: boolean;
  /** One actionable sentence when a read failed, otherwise `null`. */
  errorMessage: string | null;
  /** Reads one coarse fix. Returns `null` when it could not (and explains why). */
  readOneFix: () => Promise<{ latitude: number; longitude: number } | null>;
  /** Clears the last failure so a notice can be dismissed. */
  reset: () => void;
}

function mapPermission(response: Location.LocationPermissionResponse): AnchorPermissionState {
  if (response.granted) return 'granted';
  return response.canAskAgain ? 'undetermined' : 'denied';
}

export function useGroupLocationAnchor(subject: 'group' | 'event' = 'group'): GroupLocationAnchor {
  const [permission, setPermission] = useState<AnchorPermissionState>('checking');
  const [isWorking, setIsWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Late results from an unmounted form are dropped rather than applied.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  const readOneFix = useCallback(async () => {
    setIsWorking(true);
    setErrorMessage(null);

    try {
      const existing = await Location.getForegroundPermissionsAsync();
      const response =
        existing.granted || !existing.canAskAgain ? existing : await Location.requestForegroundPermissionsAsync();

      if (!mountedRef.current) return null;
      setPermission(mapPermission(response));

      if (!response.granted) {
        setErrorMessage(
          subject === 'event'
            ? 'Unihood cannot see your location, so the venue has no map position yet.'
            : 'Unihood cannot see your location, so the group has no anchor yet.',
        );
        return null;
      }

      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        if (!mountedRef.current) return null;
        setErrorMessage('Location is switched off for this device. Turn it on and try again.');
        return null;
      }

      // Coarse on purpose: this anchors a group to a place, not to a person, and the
      // server rounds it to ~11 m anyway.
      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
      if (!mountedRef.current) return null;

      return { latitude: position.coords.latitude, longitude: position.coords.longitude };
    } catch (caught) {
      if (!mountedRef.current) return null;
      setErrorMessage(describeError(caught));
      return null;
    } finally {
      if (mountedRef.current) setIsWorking(false);
    }
  }, [subject]);

  const reset = useCallback(() => setErrorMessage(null), []);

  return { permission, isWorking, errorMessage, readOneFix, reset };
}
