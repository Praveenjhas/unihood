import { StyleSheet, View } from 'react-native';

import { AppText, Avatar, PressableCard, Tag } from '../../components';
import { interestLabelFor } from '../../data';
import { formatApproximateDistance, pluralize } from '../../lib';
import { spacing } from '../../theme';
import type { Person } from '../../types';

export interface PersonCardProps {
  person: Person;
  onPress: () => void;
  /**
   * The viewer's own interests. Passing them lets shared interests be lifted to
   * the front of the tag row and tinted, which is the whole point of the list —
   * "who else is into this" — without the card having to fetch anything.
   */
  viewerInterestIds?: readonly string[];
}

/**
 * The interests the viewer shares with this member.
 *
 * The API's own answer is preferred, because it is exactly what the ranking used:
 * the list was ordered by it, so the tint and the order can never disagree. The
 * viewer's cached profile is the fallback - for a response from an older build, or
 * when the viewer changed their own interests after the list was drawn.
 */
export function sharedInterestsOf(person: Person, viewerInterestIds: readonly string[]): Set<string> {
  if (person.sharedInterestIds.length > 0) return new Set(person.sharedInterestIds);

  const viewer = new Set(viewerInterestIds);
  return new Set(person.interestIds.filter((id) => viewer.has(id)));
}

/** The most interesting tags for a card: shared interests first, then the rest. */
export function interestsMatchedFirst(person: Person, shared: ReadonlySet<string>): string[] {
  return [...person.interestIds].sort((left, right) => {
    const leftShared = shared.has(left) ? 0 : 1;
    const rightShared = shared.has(right) ? 0 : 1;
    if (leftShared !== rightShared) return leftShared - rightShared;
    return left.localeCompare(right);
  });
}

/**
 * A member in the People list.
 *
 * The card answers three questions in reading order — who they are, where they
 * roughly are, and why they were ranked here — so the ranking never has to be
 * explained in prose. Distance is rendered only when the backend shared it; a
 * missing distance says "not shared", never "0 m".
 */
export function PersonCard({ person, onPress, viewerInterestIds = [] }: PersonCardProps) {
  const distance = formatApproximateDistance(person.distanceMeters);
  const meta = [person.locationLabel, distance].filter(Boolean).join(' · ');

  const shared = sharedInterestsOf(person, viewerInterestIds);
  const ordered = interestsMatchedFirst(person, shared);
  const visible = ordered.slice(0, 3);
  const hiddenCount = ordered.length - visible.length;

  return (
    <PressableCard
      onPress={onPress}
      accessibilityLabel={`${person.displayName}${person.sharedInterestCount > 0 ? `, ${pluralize(person.sharedInterestCount, 'interest')} in common` : ''}`}
      accessibilityHint="Opens their profile"
      style={styles.card}
    >
      <View style={styles.headerRow}>
        <Avatar name={person.displayName} size="md" />
        <View style={styles.headerText}>
          <AppText variant="title" numberOfLines={1}>
            {person.displayName}
          </AppText>
          {meta ? (
            <AppText variant="meta" numberOfLines={1}>
              {meta}
            </AppText>
          ) : null}
        </View>
        {person.sharedInterestCount > 0 ? (
          <Tag label={`${person.sharedInterestCount} in common`} variant="soft" />
        ) : null}
      </View>

      {person.bio ? (
        <AppText variant="bodySecondary" numberOfLines={2}>
          {person.bio}
        </AppText>
      ) : null}

      {visible.length > 0 ? (
        <View style={styles.tags}>
          {visible.map((id) => (
            <Tag key={id} label={interestLabelFor(id)} variant={shared.has(id) ? 'soft' : 'neutral'} />
          ))}
          {hiddenCount > 0 ? <Tag label={`+${hiddenCount}`} variant="neutral" /> : null}
        </View>
      ) : null}
    </PressableCard>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  headerText: {
    flex: 1,
    gap: spacing.xxs,
  },
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
  },
});
