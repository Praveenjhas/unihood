import { ScrollView, StyleSheet, View } from 'react-native';

import { spacing } from '../theme';
import { FilterChip } from './Tag';

export interface FilterOption<T extends string> {
  id: T;
  label: string;
}

export interface FilterRowProps<T extends string> {
  options: readonly FilterOption<T>[];
  selected: readonly T[];
  onToggle: (id: T) => void;
  /** Accessibility prefix, e.g. "Interest" -> "Interest: Coding". */
  accessibilityPrefix: string;
}

/**
 * Single row of multi-select chips for a discovery filter.
 *
 * Scrolls horizontally so adding interests later never reflows the layout, and
 * the row bleeds to the screen edge with `contentContainerStyle` padding so the
 * last chip is reachable rather than clipped.
 */
export function FilterRow<T extends string>({ options, selected, onToggle, accessibilityPrefix }: FilterRowProps<T>) {
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
      >
        {options.map((option) => (
          <FilterChip
            key={option.id}
            label={option.label}
            selected={selected.includes(option.id)}
            onPress={() => onToggle(option.id)}
            accessibilityLabel={`${accessibilityPrefix}: ${option.label}`}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.sm,
    paddingRight: spacing.xl,
    paddingVertical: spacing.xxs,
  },
});
