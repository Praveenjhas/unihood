import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Card, EmptyState, FilterChip, SearchField } from '../../components';
import {
  interestCategoryLabel,
  interestCategoryOf,
  interestCategoryRank,
  type InterestOption,
} from '../../data';
import { matchesAny, normalizeQuery } from '../../lib';
import { layout, spacing } from '../../theme';

export interface InterestPickerProps {
  /** The live catalogue from `useInterestCatalog`, as plain-string options. */
  options: readonly InterestOption[];
  /** Selected interest ids, in selection order. */
  selectedIds: readonly string[];
  onToggle: (id: string) => void;
  /** Blocks interaction while a save is in flight. */
  disabled?: boolean;
  /** Shown as "n of m picked"; the cap is enforced here, the rule is the screen's. */
  maxSelections: number;
  /** The screen's minimum, echoed under the counter. */
  minSelections: number;
  /** Line under the picker, overridden by the caller for its own wording. */
  hint?: string;
  /** True while the catalogue request is still out. */
  isLoading?: boolean;
}

interface InterestGroup {
  category: string;
  label: string;
  rank: number;
  items: InterestOption[];
}

/**
 * The interest selector.
 *
 * Three ways to find something, because ~150 interests is a lot to scroll: type a
 * name, tap a category chip, or read down the grouped list. The catalogue already
 * arrives grouped by the server, so the only ordering work here is putting the
 * *categories* into the product's reading order and filtering.
 *
 * The counter is deliberately prominent: "we will show you people who share
 * these" is the whole reason the step exists, so the number of things selected is
 * the one figure worth watching while choosing.
 */
export function InterestPicker({
  options,
  selectedIds,
  onToggle,
  disabled = false,
  maxSelections,
  minSelections,
  hint,
  isLoading = false,
}: InterestPickerProps) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const atLimit = selectedIds.length >= maxSelections;

  /** Option + its normalised category, so the grouping below reads once. */
  const decorated = useMemo(
    () => options.map((option) => ({ option, category: interestCategoryOf(option) })),
    [options],
  );

  const groups = useMemo<InterestGroup[]>(() => {
    const byCategory = new Map<string, InterestOption[]>();

    for (const { option, category } of decorated) {
      const bucket = byCategory.get(category);
      if (bucket) bucket.push(option);
      else byCategory.set(category, [option]);
    }

    return [...byCategory.entries()]
      .map(([category, items]) => ({
        category,
        label: interestCategoryLabel(category),
        rank: interestCategoryRank(category),
        items: items.slice().sort((left, right) => left.label.localeCompare(right.label)),
      }))
      .sort((left, right) => left.rank - right.rank);
  }, [decorated]);

  const normalisedQuery = normalizeQuery(query);
  const searchResults = useMemo(() => {
    if (normalisedQuery.length === 0) return null;
    return decorated
      .filter(({ option }) => matchesAny([option.label], normalisedQuery))
      .map(({ option }) => option)
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [decorated, normalisedQuery]);

  const visibleGroups = activeCategory === null ? groups : groups.filter((group) => group.category === activeCategory);

  const renderChips = (items: readonly InterestOption[]) => (
    <View style={styles.chips}>
      {items.map((option) => (
        <FilterChip
          key={option.id}
          label={option.label}
          selected={selected.has(option.id)}
          // Quietly refusing a pick after the cap beats a server round-trip that
          // fails once the member has already moved on.
          onPress={() => {
            if (disabled) return;
            if (!selected.has(option.id) && atLimit) return;
            onToggle(option.id);
          }}
          accessibilityLabel={`Interest: ${option.label}`}
        />
      ))}
    </View>
  );

  return (
    <View style={styles.container}>
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder="Search interests"
        accessibilityLabel="Search interests"
      />

      <View style={styles.counter}>
        <AppText variant="bodyStrong">
          {selectedIds.length === 0 ? 'Nothing picked yet' : `${selectedIds.length} of ${maxSelections} picked`}
        </AppText>
        <AppText variant="meta">
          {selectedIds.length >= minSelections
            ? 'Shared interests are how nearby people and groups are ranked.'
            : `Pick at least ${minSelections} so results have something to work with.`}
        </AppText>
      </View>

      {searchResults ? (
        searchResults.length > 0 ? (
          <View style={styles.group}>
            <AppText variant="label">{`Matches · ${searchResults.length}`}</AppText>
            {renderChips(searchResults)}
          </View>
        ) : (
          <EmptyState
            title="No interest matches that"
            message="Try a shorter word — “run” finds Running, and “photo” finds Photography."
          />
        )
      ) : (
        <>
          <View style={styles.rail}>
            <View style={styles.chips}>
              <FilterChip
                label="All"
                selected={activeCategory === null}
                onPress={() => setActiveCategory(null)}
                accessibilityLabel="Show every category"
              />
              {groups.map((group) => (
                <FilterChip
                  key={group.category}
                  label={group.label}
                  selected={activeCategory === group.category}
                  // Tapping the active category clears it, which is the way back to
                  // the full list without hunting for "All".
                  onPress={() => setActiveCategory(activeCategory === group.category ? null : group.category)}
                  accessibilityLabel={`Category: ${group.label}`}
                />
              ))}
            </View>
          </View>

          {visibleGroups.map((group) => (
            <View key={group.category} style={styles.group}>
              <AppText variant="label">{group.label}</AppText>
              {renderChips(group.items)}
            </View>
          ))}
        </>
      )}

      {atLimit ? (
        <Card muted style={styles.limitCard}>
          <AppText variant="meta">
            {`That is the maximum of ${maxSelections}. Untick one to swap it for something else.`}
          </AppText>
        </Card>
      ) : null}

      {hint ? <AppText variant="meta">{hint}</AppText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.lg,
  },
  counter: {
    gap: spacing.xxs,
  },
  rail: {
    // The rail runs to the screen edge so it reads as scrollable.
    marginRight: -layout.screenPadding,
  },
  group: {
    gap: spacing.sm,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
  },
  limitCard: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
});
