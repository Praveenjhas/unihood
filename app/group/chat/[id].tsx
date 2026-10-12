import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { EmptyState, ErrorState, ListSkeleton, Notice, Screen, ScreenHeader } from '../../../src/components';
import { useAuth } from '../../../src/features/auth';
import { ChatComposer, ChatThread, useGroupChat } from '../../../src/features/chat';
import { GroupNotAvailableError, fetchGroup } from '../../../src/features/groups';
import { describeError, routes, useQuery } from '../../../src/lib';
import { spacing } from '../../../src/theme';
import { isArchived, membershipStateOf } from '../../../src/types';

/**
 * A group's chat.
 *
 * Members only, and that is enforced by the server rather than by this screen: the
 * history endpoint refuses anyone who is not an active member, the socket refuses to
 * put them in the room, and every send is authorised again. What the screen does with
 * that is presentation - a non-member who reaches this page by a hand-typed link gets
 * an explanation and a way back to the group, not a broken thread.
 *
 * The layout is deliberately not the usual `Screen` scroller: a chat is a list that
 * fills the viewport with a composer pinned below it, so the message list scrolls and
 * the composer never does.
 */
export default function GroupChatScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useAuth();

  const groupQuery = useQuery(() => fetchGroup(id ?? ''), {
    queryKey: `group|${id ?? ''}|chat`,
    enabled: Boolean(id),
  });
  const group = groupQuery.data;

  // Whether the viewer may be here at all. Until the group has loaded this is false,
  // and the chat hook is told to stay idle rather than fetching a room it may not be
  // allowed to read - a 403 flashing before the "members only" state would be noise,
  // not information.
  const isMember = group !== null && membershipStateOf(group) === 'active';
  const archived = group !== null && isArchived(group);

  const chat = useGroupChat(id ?? '', userId, { enabled: Boolean(id) && isMember });

  const goBack = () => (router.canGoBack() ? router.back() : router.replace(routes.groups));

  if (groupQuery.status === 'loading') {
    return (
      <Screen>
        <ScreenHeader title="Group chat" onBack={goBack} />
        <View style={styles.state}>
          <ListSkeleton rows={4} />
        </View>
      </Screen>
    );
  }

  if (groupQuery.status === 'error' && !(groupQuery.error instanceof GroupNotAvailableError)) {
    return (
      <Screen>
        <ScreenHeader title="Group chat" onBack={goBack} />
        <View style={styles.state}>
          <ErrorState
            message="We couldn't open this group just now."
            onRetry={groupQuery.retry}
            detail={groupQuery.error ? describeError(groupQuery.error) : undefined}
          />
        </View>
      </Screen>
    );
  }

  if (group === null) {
    return (
      <Screen>
        <ScreenHeader title="Group chat" onBack={goBack} />
        <EmptyState
          icon="grid-outline"
          title="We couldn't find that group"
          message="It may have been removed, or the link is out of date."
          action={{ label: 'Back to the directory', onPress: goBack }}
        />
      </Screen>
    );
  }

  if (!isMember) {
    return (
      <Screen>
        <ScreenHeader title={group.name} eyebrow="Group chat" onBack={goBack} />
        <EmptyState
          icon="lock-closed-outline"
          title="Chat is for members"
          message="Only active members of a group can read or post in its chat. Join the group first - a private group needs its owner to approve you."
          action={{ label: 'Open the group', onPress: () => router.replace(routes.group(group.id)) }}
        />
      </Screen>
    );
  }

  return (
    <Screen
      scroll={false}
      contentStyle={styles.content}
      footer={
        <ChatComposer
          chat={chat}
          disabledReason={
            archived ? 'This group has been archived, so no new messages can be sent. The history stays here.' : null
          }
        />
      }
    >
      <ScreenHeader
        eyebrow="Group chat"
        title={group.name}
        subtitle="Messages are visible to every member of this group and are kept in its history."
        onBack={goBack}
      />

      {archived ? (
        <Notice
          tone="info"
          message="This group is archived."
          detail="Its chat is closed to new messages, and you can still read everything that was said."
        />
      ) : null}

      <ChatThread chat={chat} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.md,
  },
  state: {
    marginTop: spacing.xl,
  },
});
