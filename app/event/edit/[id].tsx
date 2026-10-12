import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AppText,
  Button,
  EmptyState,
  ErrorState,
  ListSkeleton,
  Notice,
  Screen,
  ScreenHeader,
} from '../../../src/components';
import {
  EventForm,
  EventNotAvailableError,
  cancelEvent,
  fetchEvent,
  updateEvent,
} from '../../../src/features/events';
import { fetchGroupsPage } from '../../../src/features/groups';
import { describeError, routes, useQuery } from '../../../src/lib';
import { spacing } from '../../../src/theme';
import {
  eventBodyFrom,
  eventFormProblem,
  eventFormValuesFrom,
  isEventCancelled,
  type CampusEvent,
  type EventFormValues,
} from '../../../src/types';

/** True when the two forms would write the same event. */
function sameValues(left: EventFormValues, right: EventFormValues): boolean {
  return (
    left.title === right.title &&
    left.description === right.description &&
    left.category === right.category &&
    left.date === right.date &&
    left.startTime === right.startTime &&
    left.endTime === right.endTime &&
    left.locationLabel === right.locationLabel &&
    left.latitude === right.latitude &&
    left.longitude === right.longitude &&
    left.removeLocation === right.removeLocation &&
    left.maxParticipants === right.maxParticipants
  );
}

/**
 * Edit event - the organiser's settings, and the other place cancelling lives.
 *
 * The editor follows the group editor's shape: a local draft, a baseline to compare
 * against, and one write on save. Cancelling is deliberately *not* a field on the
 * form - it is a separate, confirmed action, because it takes the event out of
 * every listing for good and there is no way back from it in the app.
 *
 * Who may open this screen is decided by the API, not here: the `viewerCanManage`
 * flag the event page reads is re-derived on the write, so a crafted request from
 * someone else's account is refused by the service.
 */
export default function EditEventScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const eventQuery = useQuery(() => fetchEvent(id ?? ''), { queryKey: `event|${id ?? ''}|edit`, enabled: Boolean(id) });
  const groupsQuery = useQuery(() => fetchGroupsPage({ mode: 'mine', limit: 50 }), {
    queryKey: 'groups|mine|edit-event',
  });

  const event = eventQuery.data;

  // The draft is seeded from whatever the server confirmed, so a background refresh
  // cannot overwrite what the member is typing.
  const [draft, setDraft] = useState<EventFormValues | null>(null);
  const [baseline, setBaseline] = useState<EventFormValues | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace(routes.events));

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
        <ScreenHeader title="Edit event" onBack={goBack} />
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
          message="It may have been cancelled, or it may not be shared with you."
          action={{ label: "Back to what's on", onPress: goBack }}
        />
      </Screen>
    );
  }

  if (isEventCancelled(event)) {
    return (
      <Screen>
        <ScreenHeader title="Edit event" onBack={goBack} />
        <EmptyState
          icon="close-circle-outline"
          title="This event was cancelled"
          message="A cancelled event cannot be edited or reopened. Its attendance history is kept."
          action={{ label: 'Back to the event', onPress: () => router.replace(routes.event(event.id)) }}
        />
      </Screen>
    );
  }

  const current = draft ?? eventFormValuesFrom(event);
  const original = baseline ?? eventFormValuesFrom(event);
  const problem = eventFormProblem(current);
  const isDirty = !sameValues(current, original);
  const canSave = problem === null && isDirty && !isSaving && !isCancelling;

  const save = async () => {
    if (!canSave) return;

    const body = eventBodyFrom(current, { includeGroup: false });
    if (!body) {
      setErrorMessage('That date and time could not be read. Check the date, the start and the end.');
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);

    try {
      const saved: CampusEvent = await updateEvent(event.id, body);
      setDraft(eventFormValuesFrom(saved));
      setBaseline(eventFormValuesFrom(saved));
      router.replace(routes.event(saved.id));
    } catch (caught) {
      setErrorMessage(describeError(caught));
      setIsSaving(false);
    }
  };

  const cancel = async () => {
    setIsCancelling(true);
    setErrorMessage(null);

    try {
      await cancelEvent(event.id);
      router.replace(routes.event(event.id));
    } catch (caught) {
      setErrorMessage(describeError(caught));
      setIsCancelling(false);
    }
  };

  return (
    <Screen
      contentStyle={styles.content}
      footer={
        <>
          <Button
            label="Save changes"
            icon="checkmark"
            variant="primary"
            fullWidth
            loading={isSaving}
            disabled={!canSave}
            onPress={() => void save()}
            accessibilityHint="Saves the event and goes back to its page"
          />
          <Button
            label="Discard changes"
            variant="ghost"
            fullWidth
            disabled={!isDirty || isSaving || isCancelling}
            onPress={() => {
              setDraft(original);
              setErrorMessage(null);
            }}
          />
        </>
      }
    >
      <ScreenHeader
        eyebrow="Event settings"
        title={event.title}
        subtitle="What it is, when it runs and where people should turn up."
        onBack={goBack}
      />

      {errorMessage ? <Notice tone="danger" message={errorMessage} /> : null}
      {problem && !errorMessage ? <Notice tone="info" message={problem} /> : null}

      <EventForm
        values={current}
        onChange={(patch) => setDraft((value) => ({ ...(value ?? current), ...patch }))}
        groups={groupsQuery.data?.groups ?? []}
        existingLocation={event.hasLocation}
        disabled={isSaving || isCancelling}
      />

      <AppText variant="meta">
        {isDirty ? 'You have unsaved changes. Nothing is written until you save.' : 'Everything here is saved.'}
      </AppText>

      <View style={styles.section}>
        <Button
          label="Cancel event"
          icon="close-circle-outline"
          variant="danger"
          fullWidth
          loading={isCancelling}
          disabled={isSaving}
          onPress={() => setConfirmCancel(true)}
        />
        {confirmCancel ? (
          <Notice
            tone="danger"
            message={`Cancel ${event.title}?`}
            detail="It stops appearing in listings and nobody can sign up. The people who said yes keep their history, and this cannot be undone from the app."
            action={{ label: 'Yes, cancel it', onPress: () => void cancel() }}
          />
        ) : (
          <AppText variant="meta">
            Cancelling is how an event is taken down. Nothing is deleted: the guest list stays readable, and the event
            can never be reopened.
          </AppText>
        )}
      </View>
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
});
