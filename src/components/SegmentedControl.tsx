import { Pressable, StyleSheet, View } from 'react-native';

import { colors, radii, shadows, spacing } from '../theme';
import { AppText } from './AppText';

export interface SegmentedControlOption<T extends string> {
  id: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedControlOption<T>[];
  /** The single selected option. This control never has zero or two values. */
  value: T;
  onChange: (id: T) => void;
  /** Accessible name for the set, e.g. "Event view" -> "Event view: Nearby". */
  accessibilityLabel: string;
}

/**
 * Single-select switch for slicing one list several ways — used by the Events
 * tab, where the same catalog is browsed by proximity, by group and by RSVP.
 *
 * Deliberately not a chip row: chips are the filter language (`Tag`/`FilterRow`,
 * multi-select, olive when active), so the primary view switch gets its own
 * shape to stay readable next to the category filters below it.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: SegmentedControlProps<T>) {
  return (
    <View style={styles.track}>
      {options.map((option) => {
        const selected = option.id === value;

        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={`${accessibilityLabel}: ${option.label}`}
            // Re-selecting the active segment is a no-op rather than a toggle:
            // the Events tab always has exactly one view.
            onPress={() => {
              if (!selected) onChange(option.id);
            }}
            style={({ pressed }) => [
              styles.segment,
              selected ? styles.segmentSelected : null,
              pressed && !selected ? styles.pressed : null,
            ]}
          >
            <AppText variant="label" color={selected ? colors.ink : colors.textSecondary} numberOfLines={1}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 3,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm + 1,
    borderRadius: radii.pill,
  },
  segmentSelected: {
    backgroundColor: colors.surface,
    ...shadows.hairline,
  },
  pressed: {
    opacity: 0.7,
  },
});
