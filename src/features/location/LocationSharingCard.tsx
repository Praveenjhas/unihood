import * as Linking from 'expo-linking';
import { StyleSheet, View } from 'react-native';

import { AppText, Button, Card, Notice } from '../../components';
import { formatLocationAge, hasSavedLocation } from '../../lib';
import { spacing } from '../../theme';
import { useLocationSharing } from './useLocationSharing';

export interface LocationSharingCardProps {
  /**
   * The profile's nearby-discovery switch. When it is off the server refuses the
   * write, so the card explains that instead of offering a button that would fail.
   */
  enabled: boolean;
  /** Stored-fix timestamp from the profile row, used to seed the status line. */
  initialUpdatedAt?: string | null;
  /** Called after a successful share or removal, so the caller can refresh. */
  onChanged?: () => void;
}

/**
 * The one place a member can store or remove their nearby area.
 *
 * This card is deliberately wordy. Storing a location is the single most
 * consequential thing the app asks for, so it states the precision (~11 m), the
 * lifetime (until they change it) and who can see it (members who also consented)
 * - before the OS permission dialog ever appears. `useLocationSharing` requests
 * permission only from the tap below, never on mount.
 */
export function LocationSharingCard({ enabled, initialUpdatedAt = null, onChanged }: LocationSharingCardProps) {
  const sharing = useLocationSharing({ initialUpdatedAt });
  const hasStoredFix = hasSavedLocation(sharing.locationUpdatedAt);
  const canAskAgain = sharing.permission === 'undetermined';
  const permissionBlocked = sharing.permission === 'denied';
  const permissionUnavailable = sharing.permission === 'unavailable';

  const share = async () => {
    await sharing.share();
    onChanged?.();
  };

  const forget = async () => {
    await sharing.forget();
    onChanged?.();
  };

  const openSettings = () => {
    void Linking.openSettings().catch(() => undefined);
  };

  return (
    <Card style={styles.card}>
      <View style={styles.header}>
        <AppText variant="bodyStrong">Your nearby area</AppText>
        <AppText variant="meta">
          {hasStoredFix
            ? `${formatLocationAge(sharing.locationUpdatedAt)} · used for nearby search`
            : 'Nothing saved yet'}
        </AppText>
      </View>

      <AppText variant="meta">
        Unihood stores one coarse area, rounded to about 11 m, and only while nearby discovery is on. It stays saved
        until you change it, remove it or close your account — and it is visible only as a distance, never as a pin on
        anyone else’s map. Update it whenever you move, or whenever you want a
        different local community.
      </AppText>

      {sharing.errorMessage ? (
        <Notice
          tone="danger"
          message={sharing.errorMessage}
          action={sharing.permission === 'granted' ? { label: 'Try again', onPress: () => void share() } : undefined}
        />
      ) : null}

      {!sharing.errorMessage && sharing.status === 'shared' ? (
        <Notice
          tone="success"
          message="Nearby area saved."
          detail={hasStoredFix ? `${formatLocationAge(sharing.locationUpdatedAt)}. Update it whenever you move.` : undefined}
        />
      ) : null}

      {!sharing.errorMessage && sharing.status === 'denied' ? (
        <Notice
          tone="info"
          message="Unihood cannot see your location."
          detail="Permission was declined, so nothing was stored. You can change this in your device settings."
          action={{ label: 'Open settings', onPress: openSettings }}
        />
      ) : null}

      {!sharing.errorMessage && sharing.status !== 'denied' && permissionBlocked ? (
        <Notice
          tone="info"
          message="Location permission is off for Unihood."
          detail="Turn it back on in your device settings, then share a new fix."
          action={{ label: 'Open settings', onPress: openSettings }}
        />
      ) : null}

      {!sharing.errorMessage && permissionUnavailable ? (
        <Notice tone="info" message="This device cannot report a location, so nearby search is unavailable." />
      ) : null}

      {enabled ? (
        <View style={styles.actions}>
          <Button
            label={hasStoredFix ? 'Update nearby area' : 'Use my location'}
            icon="navigate-outline"
            variant="secondary"
            loading={sharing.isWorking}
            onPress={() => void share()}
            style={styles.action}
            accessibilityHint={
              canAskAgain
                ? 'Asks for permission, then saves one coarse area'
                : 'Saves one coarse area'
            }
          />
          <Button
            label="Remove"
            icon="trash-outline"
            variant="danger"
            disabled={!hasStoredFix || sharing.isWorking}
            onPress={() => void forget()}
            style={styles.action}
            accessibilityHint="Deletes the saved nearby area"
          />
        </View>
      ) : (
        <Notice
          tone="info"
          message="Nearby discovery is off."
          detail="Unihood will not store a location until you turn that switch on above."
        />
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.md,
  },
  header: {
    gap: spacing.xxs,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  action: {
    flex: 1,
  },
});
