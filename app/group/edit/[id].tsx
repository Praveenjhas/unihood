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
import { GroupForm, GroupNotAvailableError, archiveGroup, fetchGroup, updateGroup } from '../../../src/features/groups';
import { describeError, routes, useQuery } from '../../../src/lib';
import { spacing } from '../../../src/theme';
import { GROUP_NAME_MIN_LENGTH, groupDraftFrom, type Group, type GroupDraft } from '../../../src/types';

/** True when the two drafts would write the same group. */
function sameDraft(left: GroupDraft, right: GroupDraft): boolean {
  return (
    left.name === right.name &&
    left.description === right.description &&
    left.category === right.category &&
    left.interestId === right.interestId &&
    left.visibility === right.visibility &&
    left.audience === right.audience &&
    left.locationLabel === right.locationLabel &&
    left.latitude === right.latitude &&
    left.longitude === right.longitude &&
    left.removeLocation === right.removeLocation
  );
}

/**
 * Edit group settings. Owner-only, and the API enforces that rather than this screen.
 *
 * The editor follows the profile editor's shape: a local draft, a baseline to compare
 * against, and one write on save. Archiving sits here too, behind a confirmation,
 * because it is the only destructive action in the phase and it deletes nothing - it
 * takes the group out of discovery for good.
 */
export default function EditGroupScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const groupQuery = useQuery(() => fetchGroup(id ?? ''), { queryKey: `group|${id ?? ''}|edit`, enabled: Boolean(id) });

  const goBack = () => (router.canGoBack() ? router.back() : router.replace(routes.groups));

  if (groupQuery.status === 'loading') {
    return (
      <Screen>
        <ScreenHeader title="Loading group" onBack={goBack} />
        <View style={styles.state}>
          <ListSkeleton rows={2} />
        </View>
      </Screen>
    );
  }

  if (groupQuery.status === 'error' && !(groupQuery.error instanceof GroupNotAvailableError)) {
    return (
      <Screen>
        <ScreenHeader title="Edit group" onBack={goBack} />
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

  if (group.archivedAt) {
    return (
      <Screen>
        <ScreenHeader title="Edit group" onBack={goBack} />
        <EmptyState
          icon="archive-outline"
          title="This group is archived"
          message="An archived group cannot be edited or reopened. Its members and history are kept."
          action={{ label: 'Back to the group', onPress: goBack }}
        />
      </Screen>
    );
  }

  if (!group.viewerIsOwner) {
    return (
      <Screen>
        <ScreenHeader title="Edit group" onBack={goBack} />
        <EmptyState
          icon="lock-closed-outline"
          title="Only the owner can edit this group"
          message="Administrators manage requests and members; the group's own settings belong to its owner."
          action={{ label: 'Back to the group', onPress: goBack }}
        />
      </Screen>
    );
  }

  return <GroupEditor group={group} onDone={goBack} />;
}

/** Mounted only once the group is in hand, so the draft is seeded from real data. */
function GroupEditor({ group, onDone }: { group: Group; onDone: () => void }) {
  const router = useRouter();
  const [draft, setDraft] = useState<GroupDraft>(() => groupDraftFrom(group));
  const [baseline, setBaseline] = useState<GroupDraft>(() => groupDraftFrom(group));
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

  const hasName = draft.name.trim().length >= GROUP_NAME_MIN_LENGTH;
  const hasDescription = draft.description.trim().length > 0;
  const isDirty = !sameDraft(draft, baseline);
  const canSave = hasName && hasDescription && isDirty && !isSaving && !isArchiving;

  const save = async () => {
    if (!canSave) return;
    setIsSaving(true);
    setErrorMessage(null);

    try {
      const saved = await updateGroup(group.id, draft);
      setBaseline(groupDraftFrom(saved));
      onDone();
    } catch (caught) {
      setErrorMessage(describeError(caught));
      setIsSaving(false);
    }
  };

  const archive = async () => {
    setIsArchiving(true);
    setErrorMessage(null);

    try {
      await archiveGroup(group.id);
      router.replace(routes.group(group.id));
    } catch (caught) {
      setErrorMessage(describeError(caught));
      setIsArchiving(false);
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
            accessibilityHint="Saves the group and goes back to its page"
          />
          <Button
            label="Discard changes"
            variant="ghost"
            fullWidth
            disabled={!isDirty || isSaving || isArchiving}
            onPress={() => {
              setDraft(baseline);
              setErrorMessage(null);
            }}
          />
        </>
      }
    >
      <ScreenHeader
        eyebrow="Group settings"
        title={group.name}
        subtitle="Name, description, who can join and where it meets."
        onBack={onDone}
      />

      {errorMessage ? <Notice tone="danger" message={errorMessage} /> : null}

      <GroupForm
        draft={draft}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        existingAnchor={group.hasLocation}
        disabled={isSaving || isArchiving}
      />

      <AppText variant="meta">
        {isDirty ? 'You have unsaved changes. Nothing is written until you save.' : 'Everything here is saved.'}
      </AppText>

      <View style={styles.section}>
        <Button
          label="Archive group"
          icon="archive-outline"
          variant="danger"
          fullWidth
          loading={isArchiving}
          disabled={isSaving}
          onPress={() => setConfirmArchive(true)}
        />
        {confirmArchive ? (
          <Notice
            tone="danger"
            message={`Archive ${group.name}?`}
            detail="It stops appearing in discovery and nobody can join it. Members keep their membership history, and this cannot be undone from the app."
            action={{ label: 'Yes, archive it', onPress: () => void archive() }}
          />
        ) : (
          <AppText variant="meta">
            Archiving is the way to close a group. You cannot leave a group you own, because that would leave nobody able
            to manage it.
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
