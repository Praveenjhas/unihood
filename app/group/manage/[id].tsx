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
} from '../../../src/components';
import { groupRoleLabel } from '../../../src/data';
import { useAuth } from '../../../src/features/auth';
import {
  GroupNotAvailableError,
  approveJoinRequest,
  fetchGroup,
  fetchGroupMembers,
  fetchJoinRequests,
  rejectJoinRequest,
  removeMember,
  setMemberRole,
} from '../../../src/features/groups';
import { describeError, formatMemberCount, pluralize, routes, useQuery } from '../../../src/lib';
import { spacing } from '../../../src/theme';
import type { GroupMember, GroupRequest } from '../../../src/types';

/**
 * Membership management: the request queue and the member list.
 *
 * Reached from a group's page by its owner or an administrator, and re-checked by
 * the API on every action - this screen decides *what to show*, never what is
 * allowed. A member who navigates here directly sees the guard message, and a
 * crafted request that skips the screen is refused by the service.
 *
 * Requests come oldest-first and members owner/admin/member-first, so the two lists
 * answer the questions they are actually used for: "who has been waiting?" and "who
 * is running this?".
 */
export default function ManageGroupScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useAuth();

  const groupQuery = useQuery(() => fetchGroup(id ?? ''), { queryKey: `group|${id ?? ''}|manage`, enabled: Boolean(id) });
  const canManage = groupQuery.data?.viewerCanManage === true;

  const requestsQuery = useQuery(() => fetchJoinRequests(id ?? ''), {
    queryKey: `group|${id ?? ''}|requests`,
    enabled: Boolean(id) && canManage,
  });
  const membersQuery = useQuery(() => fetchGroupMembers(id ?? ''), {
    queryKey: `group|${id ?? ''}|members`,
    enabled: Boolean(id) && canManage,
  });

  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace(routes.groups));

  const refreshAll = () => {
    groupQuery.refresh();
    requestsQuery.refresh();
    membersQuery.refresh();
  };

  /** One action at a time per row, and an error that never fakes success. */
  const runFor = async (userId: string, action: () => Promise<unknown>) => {
    setBusyUser(userId);
    setActionError(null);
    setConfirmRemove(null);

    try {
      await action();
      refreshAll();
    } catch (caught) {
      setActionError(describeError(caught));
    } finally {
      setBusyUser(null);
    }
  };

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

  const group = groupQuery.data;
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

  if (!group.viewerCanManage) {
    return (
      <Screen>
        <ScreenHeader title="Manage group" onBack={goBack} />
        <EmptyState
          icon="lock-closed-outline"
          title="Owners and administrators only"
          message="The request queue and the member list belong to the people running this group."
          action={{ label: 'Back to the group', onPress: goBack }}
        />
      </Screen>
    );
  }

  const requests = requestsQuery.data?.requests ?? [];
  const members = membersQuery.data?.members ?? [];

  const renderRequest = (request: GroupRequest) => (
    <View key={request.userId} style={styles.row}>
      <ListRow
        title={request.displayName}
        meta="Wants to join"
        leading={<Avatar name={request.displayName} size="sm" />}
      />
      <View style={styles.rowActions}>
        <Button
          label="Approve"
          size="sm"
          variant="secondary"
          loading={busyUser === request.userId}
          disabled={busyUser !== null}
          onPress={() => void runFor(request.userId, () => approveJoinRequest(group.id, request.userId))}
          style={styles.rowButton}
        />
        <Button
          label="Decline"
          size="sm"
          variant="danger"
          disabled={busyUser !== null}
          onPress={() => void runFor(request.userId, () => rejectJoinRequest(group.id, request.userId))}
          style={styles.rowButton}
        />
      </View>
    </View>
  );

  const renderMember = (member: GroupMember) => {
    const isSelf = member.userId === userId;
    const isOwnerRow = member.role === 'owner';
    const isAdminRow = member.role === 'admin';
    // The API is the authority on all of this; the checks here only decide which
    // buttons are worth showing.
    const canRemove = !isOwnerRow && !isSelf && (group.viewerIsOwner || !isAdminRow);
    const canChangeRole = group.viewerIsOwner && !isOwnerRow;

    return (
      <View key={member.userId} style={styles.row}>
        <ListRow
          title={member.displayName}
          meta={groupRoleLabel(member.role)}
          leading={<Avatar name={member.displayName} size="sm" />}
          trailing={isOwnerRow ? <Tag label="Owner" variant="soft" /> : undefined}
        />

        {canRemove || canChangeRole ? (
          <View style={styles.rowActions}>
            {canChangeRole ? (
              <Button
                label={isAdminRow ? 'Make member' : 'Make admin'}
                size="sm"
                variant="secondary"
                loading={busyUser === member.userId}
                disabled={busyUser !== null}
                onPress={() =>
                  void runFor(member.userId, () =>
                    setMemberRole(group.id, member.userId, isAdminRow ? 'member' : 'admin'),
                  )
                }
                style={styles.rowButton}
              />
            ) : null}
            {canRemove ? (
              <Button
                label="Remove"
                size="sm"
                variant="danger"
                disabled={busyUser !== null}
                onPress={() => setConfirmRemove(member.userId)}
                style={styles.rowButton}
              />
            ) : null}
          </View>
        ) : null}

        {confirmRemove === member.userId ? (
          <Notice
            tone="danger"
            message={`Remove ${member.displayName}?`}
            detail="They lose access to the group immediately and cannot join it again themselves."
            action={{
              label: 'Yes, remove',
              onPress: () => void runFor(member.userId, () => removeMember(group.id, member.userId)),
            }}
          />
        ) : null}
      </View>
    );
  };

  return (
    <Screen contentStyle={styles.content}>
      <ScreenHeader
        eyebrow="Manage"
        title={group.name}
        subtitle="Approve who joins, and keep the member list tidy."
        onBack={goBack}
      />

      {actionError ? <Notice tone="danger" message={actionError} /> : null}

      <View style={styles.section}>
        <SectionHeading title="Join requests" count={group.pendingRequestCount ?? requests.length} />
        {requestsQuery.status === 'loading' ? (
          <ListSkeleton rows={2} />
        ) : requestsQuery.status === 'error' ? (
          <ErrorState
            message="We couldn't load the requests just now."
            onRetry={requestsQuery.retry}
            detail={requestsQuery.error ? describeError(requestsQuery.error) : undefined}
          />
        ) : requests.length === 0 ? (
          <EmptyState
            icon="checkmark-circle-outline"
            title="No pending requests"
            message="When somebody asks to join this group, their request appears here for you to approve or decline."
          />
        ) : (
          <Card style={styles.rowCard}>
            {requests.map((request, index) => (
              <View key={request.userId}>
                {index > 0 ? <ListDivider /> : null}
                {renderRequest(request)}
              </View>
            ))}
          </Card>
        )}
      </View>

      <View style={styles.section}>
        <SectionHeading title="Members" count={group.memberCount} />
        {membersQuery.status === 'loading' ? (
          <ListSkeleton rows={3} />
        ) : membersQuery.status === 'error' ? (
          <ErrorState
            message="We couldn't load the member list just now."
            onRetry={membersQuery.retry}
            detail={membersQuery.error ? describeError(membersQuery.error) : undefined}
          />
        ) : members.length === 0 ? (
          <EmptyState icon="people-outline" title="No members yet" message="Members appear here as soon as they join." />
        ) : (
          <Card style={styles.rowCard}>
            <AppText variant="meta">
              {`${formatMemberCount(group.memberCount)} — ${pluralize(requests.length, 'pending request')}`}
            </AppText>
            {members.map((member, index) => (
              <View key={member.userId}>
                {index > 0 ? <ListDivider /> : null}
                {renderMember(member)}
              </View>
            ))}
          </Card>
        )}
      </View>

      <AppText variant="meta">
        Removing an ordinary member is a job for an administrator; changing roles, editing the group and archiving it
        belong to the owner. Nothing here can be undone by the person it happened to.
      </AppText>
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
  row: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  rowActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  rowButton: {
    flexGrow: 1,
  },
});
