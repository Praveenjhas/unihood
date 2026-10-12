import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AppText,
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ListDivider,
  ListRow,
  ListSkeleton,
  Notice,
  Screen,
  ScreenHeader,
  SectionHeading,
  Tag,
} from '../../src/components';
import { eventCategoryLabel } from '../../src/data';
import {
  EventDateBlock,
  EventNotAvailableError,
  cancelEvent,
  cancelEventRsvp,
  fetchEvent,
  fetchEventAttendees,
  setEventRsvp,
} from '../../src/features/events';
import {
  describeError,
  formatApproximateDistance,
  formatAttendance,
  formatInstantWhen,
  pluralize,
  routes,
  useQuery,
} from '../../src/lib';
import { spacing } from '../../src/theme';
import { isEventCancelled, isEventOpen, viewerHasAnswered, viewerResponseLabel, type CampusEvent, type EventAttendee } from '../../src/types';

/**
 * Event detail - the listings page for a single event.
 *
 * The date block is promoted into the header hero and the RSVP sits in the footer,
 * so "when is it" and "am I going" are both answerable without scrolling.
 *
 * Nothing on this screen predicts its own outcome: RSVP, cancel and RSVP-cancel
 * each return the refreshed event from the server, and that payload is what gets
 * rendered. A tap the API refuses (a full event, a cancelled one, an event the
 * caller's group eligibility does not match) leaves the old state on screen and
 * explains why - the difference between an honest button and an optimistic one.
 */
export default function EventDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const eventQuery = useQuery(() => fetchEvent(id ?? ''), { queryKey: `event|${id ?? ''}`, enabled: Boolean(id) });

  // The newest event the server has confirmed for this screen. Kept beside the
  // query result rather than inside it, so a failed action never blanks the page.
  const [updated, setUpdated] = useState<CampusEvent | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const event = updated ?? eventQuery.data;
  const canRead = event !== null;

  const attendeesQuery = useQuery(() => fetchEventAttendees(id ?? ''), {
    queryKey: `event|${id ?? ''}|attendees`,
    enabled: Boolean(id) && canRead,
  });

  const goBack = () => (router.canGoBack() ? router.back() : router.replace(routes.events));

  /** Runs one action and adopts whatever the API answered with. */
  const run = async (action: (eventId: string) => Promise<CampusEvent>) => {
    if (!event) return;
    setIsWorking(true);
    setActionError(null);
    setConfirmCancel(false);

    try {
      setUpdated(await action(event.id));
      attendeesQuery.refresh();
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setIsWorking(false);
    }
  };

  if (eventQuery.status === 'loading') {
    return (
      <Screen>
        <ScreenHeader title="Loading event" onBack={goBack} />
        <View style={styles.state}>
          <ListSkeleton rows={3} />
        </View>
      </Screen>
    );
  }

  if (eventQuery.status === 'error' && !(eventQuery.error instanceof EventNotAvailableError)) {
    return (
      <Screen>
        <ScreenHeader title="Event" onBack={goBack} />
        <View style={styles.state}>
          <ErrorState
            message="We couldn't load this event just now."
            onRetry={eventQuery.retry}
            detail={eventQuery.error ? describeError(eventQuery.error) : undefined}
          />
        </View>
      </Screen>
    );
  }

  if (!event) {
    return (
      <Screen>
        <ScreenHeader title="Event not found" onBack={goBack} />
        <EmptyState
          icon="calendar-outline"
          title="We couldn't find that event"
          message="It may have been cancelled, or it may not be shared with you. Private group events are only visible to their members."
          action={{ label: "Back to what's on", onPress: goBack }}
        />
      </Screen>
    );
  }

  const cancelled = isEventCancelled(event);
  const open = isEventOpen(event);
  const going = event.viewerIsGoing;
  const notGoing = event.viewerRsvpStatus === 'not_going';
  const answered = viewerHasAnswered(event);
  const distance = formatApproximateDistance(event.distanceMeters);
  const attendees: EventAttendee[] = attendeesQuery.data?.attendees ?? [];

  /** The one action the footer is really about, in whichever state applies. */
  const renderRsvpAction = () => {
    if (cancelled) {
      return (
        <>
          <Button
            label="This event was cancelled"
            icon="close-circle-outline"
            variant="secondary"
            fullWidth
            disabled
            onPress={() => undefined}
          />
          <AppText variant="meta" align="center">
            Nobody can sign up for it any more. Anyone who was going has been told on their Going list.
          </AppText>
        </>
      );
    }

    if (event.isPast) {
      return (
        <>
          <Button
            label="This event has ended"
            icon="time-outline"
            variant="secondary"
            fullWidth
            disabled
            onPress={() => undefined}
          />
          <AppText variant="meta" align="center">
            {formatAttendance(event.goingCount, event.maxParticipants ?? undefined)} in the end.
          </AppText>
        </>
      );
    }
  };

  /**
   * The two explicit answers, and the way to take one back.
   *
   * Phase 7 made the response a *choice* rather than a single "RSVP" button: the
   * member can say Going or Not going, and can change their mind either way. The one
   * they currently hold is the filled button, so the screen always shows the state
   * the server last confirmed.
   *
   * "Withdraw my response" is a different thing from Not going, and is deliberately
   * worded that way: it clears the answer, so the event returns to Needs response
   * instead of being counted as a decline.
   */
  const renderRsvpChoice = () => {
    return (
      <>
        <Button
          label={going ? "Going - you're in" : "I'm going"}
          icon="checkmark"
          variant={going ? 'primary' : 'secondary'}
          fullWidth
          loading={isWorking}
          onPress={() => void run((eventId) => setEventRsvp(eventId, 'going'))}
          accessibilityHint="Records that you are attending"
        />
        <Button
          label="Not going"
          icon="close"
          variant={notGoing ? 'primary' : 'secondary'}
          fullWidth
          disabled={isWorking}
          onPress={() => void run((eventId) => setEventRsvp(eventId, 'not_going'))}
          accessibilityHint="Records that you are not attending"
        />
        {answered ? (
          <Button
            label="Withdraw my response"
            variant="ghost"
            fullWidth
            disabled={isWorking}
            onPress={() => void run(cancelEventRsvp)}
            accessibilityHint="Clears your answer, putting the event back in Needs response"
          />
        ) : null}
        <AppText variant="meta" align="center">
          {event.isFull
            ? 'Every place is taken. Marking yourself as Not going does not hold or free a place - only Going counts.'
            : event.maxParticipants === null
              ? 'No participant limit has been set. Only Going counts towards the attendance.'
              : `${pluralize(event.spotsLeft ?? 0, 'place')} left of ${event.maxParticipants}. Only Going counts towards them.`}
        </AppText>
      </>
    );
  };
  return (
    <Screen
      contentStyle={styles.content}
      footer={
        <>
          {actionError ? <Notice tone="danger" message={actionError} /> : null}

          {event.viewerCanManage && !cancelled ? (
            <>
              <Button
                label="Edit event"
                icon="create-outline"
                variant="secondary"
                fullWidth
                disabled={isWorking}
                onPress={() => router.push(routes.editEvent(event.id))}
              />
              <Button
                label="Cancel event"
                icon="close-circle-outline"
                variant="danger"
                fullWidth
                loading={isWorking}
                onPress={() => setConfirmCancel(true)}
              />
              {confirmCancel ? (
                <Notice
                  tone="danger"
                  message={`Cancel ${event.title}?`}
                  detail="It stops appearing in listings and nobody can sign up. The people who said yes keep their history, and this cannot be undone from the app."
                  action={{ label: 'Yes, cancel it', onPress: () => void run(cancelEvent) }}
                />
              ) : null}
            </>
          ) : null}

          {cancelled || event.isPast ? renderRsvpAction() : renderRsvpChoice()}
        </>
      }
    >
      <ScreenHeader
        eyebrow={eventCategoryLabel(event.category)}
        title={event.title}
        hero={<EventDateBlock instant={event.startAt} size="lg" />}
        subtitle={formatInstantWhen(event.startAt, event.endAt)}
        onBack={goBack}
      />

      {cancelled ? (
        <Notice
          tone="danger"
          message="This event was cancelled."
          detail="It no longer appears in any listing and no new RSVPs can be recorded. The guest list below is the record of who had said yes."
        />
      ) : null}

      {!cancelled && event.isFull ? (
        <Notice
          tone="info"
          message="This event is full."
          detail="Every place is taken, so a new RSVP would be refused. Nobody is added to a waiting list in this phase."
        />
      ) : null}

      {event.groupArchived ? (
        <Notice
          tone="info"
          message="The group hosting this event has been archived."
          detail="It is kept for its members, but the event is closed to new sign-ups and no longer appears in discovery."
        />
      ) : null}

      <Card style={styles.rowCard}>
        <ListRow
          title="Venue"
          meta={
            event.hasLocation
              ? [event.locationLabel, distance].filter(Boolean).join(' · ') || 'A map position is set'
              : [event.locationLabel, 'No map position'].filter(Boolean).join(' · ')
          }
        />
        {event.groupId && event.groupName ? (
          <>
            <ListDivider />
            <ListRow
              title="Hosted by"
              meta={`${event.groupName}${event.groupVisibility === 'private' ? ' · Private group' : ''}`}
              onPress={() => router.push(routes.group(event.groupId ?? ''))}
              accessibilityLabel={`Open ${event.groupName}`}
            />
          </>
        ) : null}
        <ListDivider />
        <ListRow title="Organiser" meta={event.creatorName} />
        <ListDivider />
        <ListRow title="Attendance" meta={formatAttendance(event.goingCount, event.maxParticipants ?? undefined)} />
        <ListDivider />
        <ListRow
          title="Your RSVP"
          meta={viewerResponseLabel(event)}
        />
      </Card>

      <View style={styles.section}>
        <SectionHeading title="About this event" />
        <Card>
          <AppText variant="bodySecondary">{event.description}</AppText>
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeading title="Who's going" count={event.goingCount} />
        {attendeesQuery.status === 'loading' ? (
          <ListSkeleton rows={2} />
        ) : attendeesQuery.status === 'error' ? (
          <ErrorState
            message="We couldn't load the guest list just now."
            onRetry={attendeesQuery.retry}
            detail={attendeesQuery.error ? describeError(attendeesQuery.error) : undefined}
          />
        ) : attendees.length === 0 ? (
          <EmptyState
            icon="people-outline"
            title="Nobody has signed up yet"
            message="Be the first - the guest list appears here as soon as someone says yes."
          />
        ) : (
          <Card style={styles.rowCard}>
            {attendees.map((attendee, index) => (
              <View key={attendee.userId}>
                {index > 0 ? <ListDivider /> : null}
                <ListRow
                  title={attendee.displayName}
                  meta={attendee.isYou ? 'That is you' : undefined}
                  leading={<Avatar name={attendee.displayName} size="sm" />}
                  trailing={attendee.isYou ? <Tag label="You" variant="soft" /> : undefined}
                />
              </View>
            ))}
          </Card>
        )}
      </View>

      {!open && !cancelled ? (
        <AppText variant="meta">
          This event has finished. Its page stays readable so the people who were going can see what happened.
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.xxl,
  },
  state: {
    marginTop: spacing.xl,
  },
  section: {
    gap: spacing.md,
  },
  rowCard: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
});
