/**
 * The chat thread and its composer.
 *
 * Two components, split by where they live on the screen rather than by what they
 * show: the thread is the scrolling list, and the composer is the pinned bar at the
 * bottom. Both read the same `GroupChatValue`, so the screen owns no chat state of
 * its own and there is exactly one place that decides what "sending" means.
 *
 * The list is `inverted` with `ListFooterComponent` carrying the "older messages"
 * control: that is what makes a chat behave like a chat - it opens at the newest
 * message, grows upward, and does not jump when an older page is prepended.
 */
import { useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';

import { AppText, Avatar, Button, Card, EmptyState, ErrorState, ListSkeleton, Notice, Tag } from '../../components';
import { formatInstantDay, formatInstantTimeRange } from '../../lib';
import { colors, radii, spacing } from '../../theme';
import { CHAT_MESSAGE_MAX_LENGTH, type ChatMessage } from '../../types';
import type { GroupChatValue } from './useGroupChat';

/** The one-line description of the transport, in the member's words. */
const CONNECTION_COPY: Record<GroupChatValue['connection'], string | null> = {
  connecting: 'Connecting to the group chat…',
  live: null,
  offline: 'You are offline. Messages will send when the connection returns.',
  blocked: 'The live chat connection was refused. Refresh the page, or sign in again.',
};

export interface ChatThreadProps {
  chat: GroupChatValue;
  emptyTitle?: string;
  emptyMessage?: string;
}

/**
 * One bubble.
 *
 * The member's own messages sit on the right, tinted, with no name (they know who
 * they are); everyone else's sit on the left with an initials avatar and the name the
 * server returned. Colour is never the only signal - alignment, the name and the
 * avatar all carry the same information.
 */
function ChatMessageBubble({ message }: { message: ChatMessage }) {
  const time = formatInstantTimeRange(message.createdAt);

  if (message.isYou) {
    return (
      <View style={[styles.bubbleRow, styles.bubbleRowOwn]}>
        <View style={[styles.bubble, styles.bubbleOwn]}>
          <AppText variant="body">{message.body}</AppText>
          <AppText variant="meta" color={colors.oliveDeep}>
            You · {time}
          </AppText>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.bubbleRow}>
      <Avatar name={message.senderName} size="sm" />
      <View style={[styles.bubble, styles.bubbleOther]}>
        <AppText variant="metaStrong">{message.senderName}</AppText>
        <AppText variant="body">{message.body}</AppText>
        <AppText variant="meta">{time}</AppText>
      </View>
    </View>
  );
}

/**
 * The thread.
 *
 * `status === 'blocked'` is its own state rather than an error: the server said the
 * member may not read this room, which no retry can fix. Everything else follows the
 * usual loading / error / empty / list ladder the other screens use.
 */
export function ChatThread({ chat, emptyTitle, emptyMessage }: ChatThreadProps) {
  const { messages, status, error, hasMore, isLoadingOlder, olderError, connection } = chat;
  const connectionCopy = CONNECTION_COPY[connection];

  // Newest first, because the list is inverted.
  const data = [...messages].reverse();

  const loadOlderControl = () => {
    if (olderError !== null) {
      return (
        <View style={styles.olderControl}>
          <Notice
            tone="danger"
            message={olderError}
            action={{ label: 'Try again', onPress: () => void chat.loadOlder() }}
          />
        </View>
      );
    }

    if (!hasMore) {
      return messages.length > 0 ? (
        <AppText variant="meta" align="center" style={styles.olderControl}>
          This is the start of the conversation.
        </AppText>
      ) : null;
    }

    return (
      <View style={styles.olderControl}>
        <Button
          label="Load older messages"
          variant="ghost"
          size="sm"
          loading={isLoadingOlder}
          onPress={() => void chat.loadOlder()}
        />
      </View>
    );
  };

  if (status === 'blocked') {
    return (
      <EmptyState
        icon="lock-closed-outline"
        title="Chat is for members"
        message="Only active members of a group can read or post in its chat. If you have just been approved, reload the group."
      />
    );
  }

  if (status === 'loading') {
    return (
      <View style={styles.state}>
        <ListSkeleton rows={4} />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.state}>
        <ErrorState
          message="We couldn't load this conversation just now."
          onRetry={chat.retry}
          detail={error ? error.message : undefined}
        />
      </View>
    );
  }

  return (
    <View style={styles.thread}>
      {connectionCopy !== null ? (
        <Notice
          tone="info"
          message={connectionCopy}
          detail="The conversation is still saved - this only affects live updates."
        />
      ) : null}

      <FlatList
        data={data}
        inverted
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => {
          // A day label wherever the local day changes as the thread is read upward.
          const previous = data[index + 1];
          const showDay =
            previous !== undefined && formatInstantDay(previous.createdAt) !== formatInstantDay(item.createdAt);

          return (
            <View>
              {showDay ? (
                <View style={styles.dayRow}>
                  <Tag label={formatInstantDay(item.createdAt)} variant="neutral" />
                </View>
              ) : null}
              <ChatMessageBubble message={item} />
            </View>
          );
        }}
        ListFooterComponent={loadOlderControl}
        ListEmptyComponent={
          <EmptyState
            icon="chatbubbles-outline"
            title={emptyTitle ?? 'No messages yet'}
            message={
              emptyMessage ?? 'Nobody has said anything here. Say hello - every member of the group will see it.'
            }
          />
        }
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

export interface ChatComposerProps {
  chat: GroupChatValue;
  /** Set when posting is impossible (archived group, or not a member). */
  disabledReason?: string | null;
}

/**
 * The pinned composer.
 *
 * The draft is local state here, and the box is only cleared once `send` resolves
 * `true`. That is the client's half of "do not report a message as sent until the
 * backend confirms persistence": a refusal leaves the words in the box, with the
 * reason above them, so nothing has to be retyped.
 */
export function ChatComposer({ chat, disabledReason = null }: ChatComposerProps) {
  const [draft, setDraft] = useState('');
  const { isSending, sendError, connection } = chat;

  const trimmed = draft.trim();
  const isClosed = disabledReason !== null;
  const canSend = !isClosed && !isSending && trimmed.length > 0;

  const submit = () => {
    if (!canSend) return;
    void chat.send(draft).then((sent) => {
      if (sent) setDraft('');
    });
  };

  return (
    <Card style={styles.composer}>
      {disabledReason !== null ? <Notice tone="info" message={disabledReason} /> : null}
      {sendError !== null && !isClosed ? <Notice tone="danger" message={sendError} /> : null}

      <View style={styles.inputRow}>
        <TextInput
          accessibilityLabel="Message"
          value={draft}
          onChangeText={setDraft}
          placeholder={isClosed ? 'Chat is closed' : 'Write a message'}
          placeholderTextColor={colors.textSecondary}
          editable={!isClosed && !isSending}
          multiline
          maxLength={CHAT_MESSAGE_MAX_LENGTH}
          style={[styles.input, isClosed ? styles.inputDisabled : null]}
        />
        <Button
          label="Send"
          icon="send"
          variant="primary"
          loading={isSending}
          disabled={!canSend}
          onPress={submit}
          accessibilityHint="Sends your message to the group"
        />
      </View>

      <AppText variant="meta">
        {trimmed.length > CHAT_MESSAGE_MAX_LENGTH - 100
          ? `${trimmed.length}/${CHAT_MESSAGE_MAX_LENGTH} characters`
          : connection === 'live'
            ? 'Everyone in this group can read this. Messages are kept for the group.'
            : 'Sent over the standard connection - it reaches the group either way.'}
      </AppText>
    </Card>
  );
}

const styles = StyleSheet.create({
  thread: {
    flex: 1,
    gap: spacing.md,
  },
  listContent: {
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  bubbleRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  bubbleRowOwn: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '78%',
    borderRadius: radii.lg,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xxs,
  },
  bubbleOwn: {
    backgroundColor: colors.oliveSoft,
    borderColor: colors.oliveBorder,
    alignItems: 'flex-end',
  },
  bubbleOther: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  dayRow: {
    alignItems: 'center',
    marginVertical: spacing.sm,
  },
  olderControl: {
    marginBottom: spacing.md,
    alignItems: 'center',
  },
  state: {
    marginTop: spacing.lg,
  },
  composer: {
    gap: spacing.sm,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 132,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontSize: 15,
  },
  inputDisabled: {
    backgroundColor: colors.surfaceMuted,
    color: colors.textSecondary,
  },
});


