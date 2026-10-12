import { StyleSheet, View } from 'react-native';

import { AppText } from '../../components';
import { formatDayOfMonth, formatMonthShort, toLocalDateString } from '../../lib';
import { colors, radii } from '../../theme';

export interface EventDateBlockProps {
  /** UTC ISO instant (`2026-10-10T18:00:00.000Z`), shown in local time. */
  instant: string;
  /** `lg` is used by the event detail hero; `md` by list cards. */
  size?: 'md' | 'lg';
}

/**
 * The big date numeral that anchors every event surface.
 *
 * This is the one place a numeral outranks the title in the hierarchy, which is
 * what makes the Events tab feel like a listings page rather than a feed.
 *
 * The API speaks UTC and the member reads their own timezone, so the instant is
 * converted here rather than by whoever rendered the block: an 11 pm event in
 * Delhi belongs to the day the member will actually turn up on.
 */
export function EventDateBlock({ instant, size = 'md' }: EventDateBlockProps) {
  const localDate = toLocalDateString(instant);
  const isLarge = size === 'lg';

  return (
    <View style={[styles.block, isLarge ? styles.blockLarge : styles.blockMedium]}>
      <AppText variant="label" style={styles.month}>
        {formatMonthShort(localDate)}
      </AppText>
      <AppText variant={isLarge ? 'displaySmall' : 'numeral'}>{formatDayOfMonth(localDate)}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
  },
  blockMedium: {
    width: 56,
    height: 56,
  },
  blockLarge: {
    width: 76,
    height: 76,
    borderRadius: radii.lg,
  },
  month: {
    marginBottom: -2,
  },
});
