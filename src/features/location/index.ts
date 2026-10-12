/**
 * Location feature.
 *
 * Two halves that are deliberately kept apart: `locationRepo` writes and clears
 * the stored fix through security-definer RPCs, and `useLocationSharing` owns the
 * permission conversation and the one-shot read. Nothing here ever reads a
 * stored coordinate back out of the database — the app does not need it, and not
 * fetching it is the strongest privacy guarantee available.
 */
export { forgetMyLocation, updateMyLocation, type Coordinates, type StoredLocation } from './locationRepo';
export { LocationSharingCard, type LocationSharingCardProps } from './LocationSharingCard';
export { useCurrentFix, type CurrentFix, type CurrentFixStatus, type CurrentFixValue } from './useCurrentFix';
export {
  useLocationSharing,
  type LocationPermissionState,
  type LocationSharingOptions,
  type LocationSharingStatus,
  type LocationSharingValue,
} from './useLocationSharing';
