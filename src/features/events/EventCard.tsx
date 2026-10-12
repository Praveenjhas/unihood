import { StyleSheet, View } from 'react-native';

import { AppText, PressableCard, Tag } from '../../components';
import { eventCategoryLabel } from '../../data/eventCategories';
import { formatApproximateDistance, formatAttendance, formatInstantWhen } from '../../lib';
import { spacing } from '../../theme';
import { isEventCancelled, type CampusEvent } from '../../types';
import { EventDateBlock } from './EventDateBlock';

export interface EventCardProps {
  event: CampusEvent;
  onPress: () => void;
}

/**
 * Listings card for one event: when it is, where to turn up, and where the member
 * stands. The date block is deliberately the first thing the eye lands on.
 *
 * Every number here comes from the server - the attendee count, the capacity and
 * the distance included - so the card can never claim availability that the API
 * would refuse. A distance appears only when a nearby search produced one; an
 * event with no anchor says where it is without implying it is close.
 */
export function EventCard({ event, onPress }: EventCardProps) {
  const when = formatInstantWhen(event.startAt, event.endAt);
  const distance = formatApproximateDistance(event.distanceMeters);
  const cancelled = isEventCancelled(event);

  const venue = event.locationLabel ?? 'Venue to be confirmed';
  const attendance = formatAttendance(event.goingCount, event.maxParticipants ?? undefined);

  return (
    <PressableCard
      onPress={onPress}
      accessibilityLabel={`${event.title}, ${when}, ${venue}`}
      accessibilityHint="Opens the event"
    >
      <View style={styles.row}>
        <EventDateBlock instant={event.startAt} />

        <View style={styles.body}>
          <AppText variant="heading" numberOfLines={2}>
            {event.title}
          </AppText>
          <AppText variant="metaStrong" numberOfLines={1}>
            {when}
          </AppText>
          <AppText variant="meta" numberOfLines={1}>
            {distance ? `${venue} · ${distance}` : venue}
          </AppText>
        </View>
      </View>

      <View style={styles.tagRow}>
        <Tag label={eventCategoryLabel(event.category)} variant="soft" />
        {event.groupName ? (
          <Tag label={`${event.groupName}${event.groupVisibility === 'private' ? ' · Private' : ''}`} />
        ) : null}
        {cancelled ? <Tag label="Cancelled" variant="neutral" /> : null}
        {!cancelled && event.isFull ? <Tag label="Full" variant="outline" /> : null}
        {event.viewerRsvpStatus === 'going' ? <Tag label="Going" variant="outline" /> : null}
        {event.viewerRsvpStatus === 'not_going' ? <Tag label="Not going" variant="neutral" /> : null}
      </View>

      <AppText variant="meta" numberOfLines={1} style={styles.attendance}>
        {cancelled ? 'This event was cancelled.' : attendance}
      </AppText>
    </PressableCard>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.lg,
  },
  body: {
    flex: 1,
    gap: spacing.xxs,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
    marginTop: spacing.md,
  },
  attendance: {
    marginTop: spacing.sm,
  },
});
