import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { spacing } from '../theme';
import { AppText } from './AppText';
import { IconButton } from './IconButton';

export interface ScreenHeaderProps {
  title: string;
  /** Small tracked label above the title. At most one per screen. */
  eyebrow?: string;
  subtitle?: string;
  /**
   * Hero element rendered between the back bar and the eyebrow — e.g. the large
   * avatar on a student profile, or the date block on an event. Keeps the
   * "art above the headline" detail screens on the shared header rhythm.
   */
  hero?: ReactNode;
  /** Renders a back control and steps the title down to `displaySmall`. */
  onBack?: () => void;
  trailing?: ReactNode;
}

/**
 * The page heading for every screen: optional back row, optional eyebrow, the
 * editorial serif title, and optional supporting line. Using one component means
 * the typographic rhythm is identical everywhere.
 */
export function ScreenHeader({ title, eyebrow, subtitle, hero, onBack, trailing }: ScreenHeaderProps) {
  const showBar = Boolean(onBack) || Boolean(trailing);

  return (
    <View style={styles.container}>
      {showBar ? (
        <View style={styles.bar}>
          {onBack ? <IconButton name="chevron-back" onPress={onBack} accessibilityLabel="Go back" /> : <View />}
          {trailing}
        </View>
      ) : null}

      {hero ? <View style={styles.hero}>{hero}</View> : null}

      {eyebrow ? (
        <AppText variant="eyebrow" style={styles.eyebrow}>
          {eyebrow}
        </AppText>
      ) : null}

      <AppText variant={onBack ? 'displaySmall' : 'display'}>{title}</AppText>

      {subtitle ? (
        <AppText variant="bodySecondary" style={styles.subtitle}>
          {subtitle}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // Pulls the icon control out to the page margin so it optically aligns.
    marginLeft: -8,
    marginRight: -4,
    marginBottom: spacing.xs,
  },
  hero: {
    marginBottom: spacing.md,
  },
  eyebrow: {
    marginBottom: spacing.xs,
  },
  subtitle: {
    marginTop: spacing.sm,
    maxWidth: 520,
  },
});
