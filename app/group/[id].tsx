import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AppText,
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
import { interestLabelFor, groupAudienceLabel, groupCategoryLabel, groupVisibilityHint, membershipStatusLabel } from '../../src/data';
import { EventCard, fetchEventsPage } from '../../src/features/events';
import {
  GroupNotAvailableError,
  cancelJoinRequest,
  fetchGroup,
  joinGroup,
  leaveGroup,
} from '../../src/features/groups';
import { describeError, formatApproximateDistance, formatMemberCount, routes, useQuery } from '../../src/lib';
import { spacing } from '../../src/theme';
import { isArchived, membershipStateOf, type Group } from '../../src/types';

/**
 * Group detail, and the one place a membership changes.
 *
 * The screen never predicts the outcome of an action: joining, leaving and
 * cancelling each return the refreshed group from the server, and that payload is
 * what gets rendered. A tap the API refuses leaves the old state on screen and
 * explains why - the difference between an honest button and an optimistic one.
 *
 * Everything stronger than membership lives behind the management screen, so this
 * page stays readable for the people who are not running the group.
 */
export default function GroupDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const groupQuery = useQuery(() => fetchGroup(id ?? ''), { queryKey: `group|${id ?? ''}`, enabled: Boolean(id) });

  // The group's own upcoming events, read from the API. The server applies the same
  // access rules it applies to the group itself, so a non-member of a private group
  // simply gets an empty list rather than someone else's event.
  const eventsQuery = useQuery(() => fetchEventsPage({ mode: 'all', groupId: id ?? '', limit: 5 }), {
    queryKey: `group|${id ?? ''}|events`,
    enabled: Boolean(id),
  });
  const groupEvents = eventsQuery.data?.events ?? [];

  // The newest group the server has confirmed for this screen. Kept beside the query
  // result rather than inside it, so a failed action never blanks the page.
  const [updated, setUpdated] = useState<Group | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace(routes.groups));

  if (groupQuery.status === 'loading') {
    return (
      <Screen>
        <ScreenHeader title="Loading group" onBack={goBack} />
        <View style={styles.state}>
          <ListSkeleton rows={3} />
        </View>
      </Screen>
    );
  }

  if (groupQuery.status === 'error' && !(groupQuery.error instanceof GroupNotAvailableError)) {
    return (
      <Screen>
        <ScreenHeader title="Group" onBack={goBack} />
        <View style={styles.state}>
          <ErrorState
            message="We couldn't load this group just now."
            onRetry={groupQuery.retry}
            detail={groupQuery.error ? describeError(groupQuery.error) : undefined}
          />
        </View>
      </Screen>
    );
  }

  const group = updated ?? groupQuery.data;
  if (!group) {
    return (
      <Screen>
        <ScreenHeader title="Group not found" onBack={goBack} />
        <EmptyState
          icon="grid-outline"
          title="We couldn't find that group"
          message="It may have been removed, or the link is out of date."
          action={{ label: 'Back to the directory', onPress: goBack }}
        />
      </Screen>
    );
  }

  const membership = membershipStateOf(group);
  const archived = isArchived(group);
  const distance = formatApproximateDistance(group.distanceMeters);

  /** Runs one membership action and adopts whatever the API answered with. */
  const run = async (action: (groupId: string) => Promise<Group>) => {
    setIsWorking(true);
    setActionError(null);
    setConfirmLeave(false);

    try {
      setUpdated(await action(group.id));
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setIsWorking(false);
    }
  };

  const renderMembershipActions = () => {
    if (archived) {
      return (
        <Notice
          tone="info"
          message="This group is archived."
          detail="It is no longer discoverable and cannot be joined. Its members keep their history."
        />
      );
    }

    if (!group.viewerEligible) {
      return (
        <>
          <Button label="Join group" variant="secondary" fullWidth disabled onPress={() => undefined} />
          <Notice
            tone="info"
            message={`${group.name} is ${groupAudienceLabel(group.audience).toLowerCase()}.`}
            detail="Your profile says a different gender, so this group is closed to you. You can change it in your profile."
            action={{ label: 'Edit profile', onPress: () => router.push(routes.editProfile) }}
          />
        </>
      );
    }

    if (membership === 'active') {
      if (group.viewerIsOwner) {
        return (
          <>
            <Button
              label="Manage group"
              icon="settings-outline"
              variant="primary"
              fullWidth
              onPress={() => router.push(routes.manageGroup(group.id))}
            />
            <Notice
              tone="info"
              message="You own this group."
              detail="An owner cannot leave — archive the group instead, from the management screen."
            />
          </>
        );
      }

      return (
        <>
          <Button
            label="Leave group"
            icon="exit-outline"
            variant="danger"
            fullWidth
            loading={isWorking}
            onPress={() => setConfirmLeave(true)}
            accessibilityHint={`Leaves ${group.name}`}
          />
          {confirmLeave ? (
            <Notice
              tone="danger"
              message={`Leave ${group.name}?`}
              detail="You will stop seeing member-only information and the member list. You can ask to join again later."
              action={{ label: 'Yes, leave', onPress: () => void run(leaveGroup) }}
            />
          ) : null}
        </>
      );
    }

    if (membership === 'pending') {
      return (
        <>
          <Button
            label="Cancel request"
            icon="close"
            variant="secondary"
            fullWidth
            loading={isWorking}
            onPress={() => void run(cancelJoinRequest)}
            accessibilityHint="Withdraws your request to join"
          />
          <Notice
            tone="info"
            message="Your request is waiting for approval."
            detail="An owner or administrator will approve or decline it. You can withdraw it if you change your mind."
          />
        </>
      );
    }

    if (membership === 'blocked') {
      return (
        <Notice
          tone="info"
          message={
            group.viewerMembership?.status === 'removed'
              ? 'You were removed from this group.'
              : 'Your request to join was declined.'
          }
          detail="That decision has to be changed by an owner or administrator, so joining again from here is not possible."
        />
      );
    }

    return (
      <>
        <Button
          label={group.visibility === 'private' ? 'Request to join' : 'Join group'}
          icon="add"
          variant="primary"
          fullWidth
          loading={isWorking}
          onPress={() => void run(joinGroup)}
          accessibilityHint={
            group.visibility === 'private'
              ? `Asks ${group.name} to approve you`
              : `Joins ${group.name} straight away`
          }
        />
        <AppText variant="meta" align="center">
          {groupVisibilityHint(group.visibility)}
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
          {renderMembershipActions()}
        </>
      }
    >
      <ScreenHeader
        eyebrow={groupCategoryLabel(group.category)}
        title={group.name}
        subtitle={group.description}
        onBack={goBack}
      />

      {archived ? (
        <Notice
          tone="info"
          message="This group has been archived."
          detail="It is kept for its members, but it no longer appears in discovery."
        />
      ) : null}

      <Card style={styles.rowCard}>
        <ListRow title="Category" meta={groupCategoryLabel(group.category)} />
        <ListDivider />
        <ListRow
          title="Interest"
          meta={
            group.interestId
              ? interestLabelFor(group.interestId)
              : 'Not set — this group appears in every listing, after the ones that match'
          }
        />
        <ListDivider />
        <ListRow
          title="Access"
          meta={group.visibility === 'private' ? 'Private · approval needed' : 'Public · open to join'}
        />
        <ListDivider />
        <ListRow title="Audience" meta={groupAudienceLabel(group.audience)} />
        <ListDivider />
        <ListRow title="Members" meta={formatMemberCount(group.memberCount)} />
        <ListDivider />
        <ListRow
          title="Meeting place"
          meta={
            group.hasLocation
              ? [group.locationLabel, distance].filter(Boolean).join(' · ') || 'Anchored near you'
              : 'No location set'
          }
        />
        {group.owner ? (
          <>
            <ListDivider />
            <ListRow title="Organiser" meta={group.owner.displayName} />
          </>
        ) : null}
        {group.viewerMembership ? (
          <>
            <ListDivider />
            <ListRow title="Your membership" meta={membershipStatusLabel(group.viewerMembership.status)} />
          </>
        ) : null}
      </Card>

      {/*
        Chat entry point (Phase 7). The section is shown to everyone so a non-member
        can see *why* there is nothing to open, while the actual room is behind the
        API's membership check - hiding the button is not the protection.
      */}
      <View style={styles.section}>
        <SectionHeading title="Group chat" />
        {membership === 'active' ? (
          <Card style={styles.rowCard}>
            <ListRow
              title="Open group chat"
              meta={
                archived
                  ? 'Read-only - this group is archived'
                  : 'Members only · messages are kept in the group history'
              }
              onPress={() => router.push(routes.groupChat(group.id))}
              accessibilityLabel={`Open the ${group.name} group chat`}
            />
          </Card>
        ) : (
          <Notice
            tone="info"
            message="Group chat is for members."
            detail="Only active members can read or post in a group's chat. Join the group to take part."
          />
        )}
      </View>

      <View style={styles.section}>
        <SectionHeading title="About" />
        <Card>
          <AppText variant="bodySecondary">{group.description}</AppText>
        </Card>
      </View>

      {group.viewerCanManage ? (
        <View style={styles.section}>
          <SectionHeading title="Manage" />
          <Card style={styles.manageCard}>
            {group.viewerIsOwner ? (
              <Button
                label="Edit group settings"
                icon="create-outline"
                variant="secondary"
                fullWidth
                onPress={() => router.push(routes.editGroup(group.id))}
              />
            ) : null}
            <Button
              label={
                group.pendingRequestCount && group.pendingRequestCount > 0
                  ? `Requests and members (${group.pendingRequestCount} waiting)`
                  : 'Requests and members'
              }
              icon="people-outline"
              variant="secondary"
              fullWidth
              onPress={() => router.push(routes.manageGroup(group.id))}
            />
            <View style={styles.tagRow}>
              <Tag label={group.viewerIsOwner ? 'You are the owner' : 'You are an administrator'} variant="soft" />
            </View>
          </Card>
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionHeading
          title="Upcoming events"
          count={groupEvents.length}
          action={
            membership === 'active' && !archived
              ? { label: 'Host one', onPress: () => router.push(routes.createEventForGroup(group.id)) }
              : undefined
          }
        />
        {eventsQuery.status === 'loading' ? (
          <ListSkeleton rows={2} />
        ) : eventsQuery.status === 'error' ? (
          <Notice
            tone="danger"
            message="We couldn't load this group's events just now."
            action={{ label: 'Try again', onPress: eventsQuery.retry }}
          />
        ) : groupEvents.length === 0 ? (
          <EmptyState
            icon="calendar-outline"
            title="Nothing scheduled yet"
            message={
              membership === 'active'
                ? 'This group has no upcoming events. Host one and it will appear here and on the Events tab.'
                : 'This group has no upcoming events. Members can post them from here.'
            }
            action={
              membership === 'active' && !archived
                ? { label: 'Post an event', onPress: () => router.push(routes.createEventForGroup(group.id)) }
                : undefined
            }
          />
        ) : (
          <View style={styles.list}>
            {groupEvents.map((event) => (
              <EventCard key={event.id} event={event} onPress={() => router.push(routes.event(event.id))} />
            ))}
          </View>
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
  rowCard: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
  manageCard: {
    gap: spacing.md,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
  },
  list: {
    gap: spacing.md,
  },
});
