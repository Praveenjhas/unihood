import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, radii, spacing } from '../theme';
import { AppText } from './AppText';
import type { IoniconName } from './Button';

export type NoticeTone = 'info' | 'success' | 'danger';

interface TonePalette {
  icon: IoniconName;
  iconColor: string;
  backgroundColor: string;
  borderColor: string;
  textColor: string;
}

/** Three tones, all from the shared palette — no notice ever invents a colour. */
const TONES: Record<NoticeTone, TonePalette> = {
  info: {
    icon: 'information-circle-outline',
    iconColor: colors.textSecondary,
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    textColor: colors.ink,
  },
  success: {
    icon: 'checkmark-circle-outline',
    iconColor: colors.olive,
    backgroundColor: colors.oliveSoft,
    borderColor: colors.oliveBorder,
    textColor: colors.oliveDeep,
  },
  danger: {
    icon: 'alert-circle-outline',
    iconColor: colors.danger,
    backgroundColor: colors.dangerSoft,
    borderColor: colors.dangerSoft,
    textColor: colors.danger,
  },
};

export interface NoticeProps {
  message: string;
  tone?: NoticeTone;
  /**
   * Inline recovery action, rendered at the end of the row — "Try again",
   * "Resend email", "Open settings". Kept inside the notice so the answer to a
   * problem sits next to the problem instead of somewhere else on the screen.
   */
  action?: { label: string; onPress: () => void };
  /** Quiet second line for supporting context. */
  detail?: string;
}

/**
 * Inline message strip for outcomes: a denied permission, a save that failed,
 * "we emailed you a link", a privacy caveat.
 *
 * Deliberately not a modal alert. Every message in this app is about something
 * the member can still read and act on, so it belongs in the page flow where it
 * can be re-read at leisure — and it never blocks the screen behind it.
 */
export function Notice({ message, tone = 'info', action, detail }: NoticeProps) {
  const palette = TONES[tone];

  return (
    <View
      // Failures interrupt a screen reader; confirmations wait their turn.
      accessibilityLiveRegion={tone === 'danger' ? 'assertive' : 'polite'}
      style={[
        styles.container,
        { backgroundColor: palette.backgroundColor, borderColor: palette.borderColor },
      ]}
    >
      <View style={styles.icon}>
        <Ionicons name={palette.icon} size={17} color={palette.iconColor} />
      </View>

      <View style={styles.text}>
        <AppText variant="bodyStrong" color={palette.textColor}>
          {message}
        </AppText>
        {detail ? (
          <AppText variant="meta" numberOfLines={3}>
            {detail}
          </AppText>
        ) : null}
      </View>

      {action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          hitSlop={8}
          style={({ pressed }) => [styles.action, pressed ? styles.pressed : null]}
        >
          <AppText variant="label" color={palette.textColor}>
            {action.label}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  icon: {
    // Optically centres the glyph on the first line of the message.
    paddingTop: 2,
  },
  text: {
    flex: 1,
    gap: spacing.xxs,
  },
  action: {
    paddingTop: 2,
    paddingHorizontal: spacing.xs,
  },
  pressed: {
    opacity: 0.6,
  },
});
