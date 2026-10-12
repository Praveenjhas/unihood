import { StyleSheet, View } from 'react-native';

import { AppText, PressableCard, Tag } from '../../components';
import { interestLabelFor } from '../../data';
import { groupAudienceLabel, groupCategoryLabel } from '../../data/groupCategories';
import { formatApproximateDistance, formatMemberCount } from '../../lib';
import { spacing } from '../../theme';
import { membershipStateOf, type Group } from '../../types';

export interface GroupCardProps {
  group: Group;
  onPress: () => void;
  /**
   * The viewer's own interests, so the group's primary interest can be shown
   * tinted when it is one the viewer also picked - the same "why am I seeing
   * this?" answer the nearby ordering gives, made visible.
   */
  viewerInterestIds?: readonly string[];
}

/** The one tag that says what this member's relationship to the group is. */
function membershipTag(group: Group): { label: string; variant: 'soft' | 'neutral' | 'outline' } | null {
  switch (membershipStateOf(group)) {
    case 'active':
      return { label: group.viewerIsOwner ? 'You own this' : "You're a member", variant: 'soft' };
    case 'pending':
      return { label: 'Request pending', variant: 'outline' };
    case 'blocked':
      return { label: group.viewerMembership?.status === 'removed' ? 'Removed' : 'Declined', variant: 'neutral' };
    case 'none':
      return null;
  }
}

/**
 * Directory card for one group.
 *
 * Reading order is deliberate: what it is, then who it is for, then a line of
 * description, then the two facts that decide a tap - how many people are in it and
 * how far away it is. Distance is only shown when the server produced one; an
 * unlocated group says so rather than showing a number the app cannot know.
 */
export function GroupCard({ group, onPress, viewerInterestIds = [] }: GroupCardProps) {
  const membership = membershipTag(group);
  const distance = formatApproximateDistance(group.distanceMeters);
  const meta = [group.locationLabel, distance].filter(Boolean).join(' · ');
  const audienceLabel = group.audience === 'everyone' ? null : groupAudienceLabel(group.audience);
  const matchedInterest = group.interestId !== null && viewerInterestIds.includes(group.interestId);

  return (
    <PressableCard
      onPress={onPress}
      accessibilityLabel={`${group.name}, ${groupCategoryLabel(group.category)}, ${formatMemberCount(group.memberCount)}`}
      accessibilityHint="Opens the group"
    >
      <AppText variant="heading" numberOfLines={2}>
        {group.name}
      </AppText>

      <View style={styles.tagRow}>
        <Tag label={groupCategoryLabel(group.category)} variant="soft" />
        {group.interestId ? (
          <Tag label={interestLabelFor(group.interestId)} variant={matchedInterest ? 'soft' : 'neutral'} />
        ) : null}
        {group.visibility === 'private' ? <Tag label="Private" /> : <Tag label="Public" />}
        {audienceLabel ? <Tag label={audienceLabel} /> : null}
        {membership ? <Tag label={membership.label} variant={membership.variant} /> : null}
      </View>

      <AppText variant="bodySecondary" numberOfLines={2} style={styles.summary}>
        {group.description}
      </AppText>

      <AppText variant="meta" numberOfLines={1}>
        {group.hasLocation
          ? `${formatMemberCount(group.memberCount)} · ${meta || 'Location not named'}`
          : `${formatMemberCount(group.memberCount)} · No meeting place yet`}
      </AppText>
    </PressableCard>
  );
}

const styles = StyleSheet.create({
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
    marginTop: spacing.sm,
  },
  summary: {
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
});
