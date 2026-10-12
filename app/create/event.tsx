import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Button, ListSkeleton, Notice, Screen, ScreenHeader } from '../../src/components';
import { EventForm, createEvent } from '../../src/features/events';
import { fetchGroupsPage } from '../../src/features/groups';
import { describeError, routes, useQuery } from '../../src/lib';
import { spacing } from '../../src/theme';
import { emptyEventFormValues, eventBodyFrom, eventFormProblem, type EventFormValues } from '../../src/types';

/**
 * Create event.
 *
 * The form writes straight to `POST /api/events`, which stores the row (and, when
 * one was chosen, checks the caller's membership of the group in the same
 * transaction); the screen then replaces itself with the new event's page rather
 * than pushing, so Back returns to the listings instead of to a filled-in form that
 * no longer means anything.
 *
 * `?groupId=` pre-selects a group, which is how a group's own page offers "host an
 * event here". The picker only ever offers groups the member is an active member
 * of - and the server re-checks that regardless of what the app sends.
 */
export default function CreateEventScreen() {
  const router = useRouter();
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();

  const [values, setValues] = useState<EventFormValues>(() =>
    emptyEventFormValues(groupId ? { groupId } : {}),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const groupsQuery = useQuery(() => fetchGroupsPage({ mode: 'mine', limit: 50 }), {
    queryKey: 'groups|mine|create-event',
  });
  const groups = groupsQuery.data?.groups ?? [];

  const problem = eventFormProblem(values, { requireGroup: true });
  const canSave = problem === null && !isSaving && groupsQuery.status !== 'loading';

  const goBack = () => (router.canGoBack() ? router.back() : router.replace(routes.events));

  const save = async () => {
    if (!canSave) return;

    const body = eventBodyFrom(values, { includeGroup: true });
    if (!body) {
      setErrorMessage('That date and time could not be read. Check the date, the start and the end.');
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);

    try {
      const event = await createEvent(body);
      router.replace(routes.event(event.id));
    } catch (caught) {
      setErrorMessage(describeError(caught));
      setIsSaving(false);
    }
  };

  return (
    <Screen
      contentStyle={styles.content}
      footer={
        <>
          <Button
            label="Post event"
            icon="checkmark"
            variant="primary"
            fullWidth
            loading={isSaving}
            disabled={!canSave}
            onPress={() => void save()}
            accessibilityHint="Creates the event and opens its page"
          />
          <Button label="Cancel" variant="ghost" fullWidth disabled={isSaving} onPress={goBack} />
        </>
      }
    >
      <ScreenHeader
        eyebrow="New event"
        title="Post an event"
        subtitle="A lecture, a gig, a match, a picnic - anything with a time and a place."
        onBack={goBack}
      />

      {errorMessage ? <Notice tone="danger" message={errorMessage} /> : null}
      {problem && !errorMessage ? <Notice tone="info" message={problem} /> : null}

      {groupsQuery.status === 'loading' ? (
        <View style={styles.state}>
          <ListSkeleton rows={3} />
        </View>
      ) : (
        <>
          {groupsQuery.status === 'error' ? (
            <Notice
              tone="danger"
              message="We couldn't load your groups just now."
              detail="You can still post a standalone event; refresh to attach it to a group."
              action={{ label: 'Try again', onPress: groupsQuery.retry }}
            />
          ) : null}

          <EventForm
            values={values}
            onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
            groups={groups}
            requireGroup
            disabled={isSaving}
          />

          <View style={styles.footerNote}>
            <AppText variant="meta">
              You organise this event, so you can edit or cancel it later from its page. A group’s owner or
              administrators can manage it too, and a private group’s event is only visible to that group.
            </AppText>
            <AppText variant="meta">
              Posting it to a group is what puts it on the Events tab: the feed there shows upcoming events from the
              groups you belong to, so every member can answer Going or Not going.
            </AppText>
          </View>
        </>
      )}
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
  footerNote: {
    gap: spacing.sm,
  },
});
