import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Button, Notice, Screen, ScreenHeader } from '../../src/components';
import { GroupForm, createGroup } from '../../src/features/groups';
import { describeError, routes } from '../../src/lib';
import { spacing } from '../../src/theme';
import { GROUP_NAME_MIN_LENGTH, emptyGroupDraft, type GroupDraft } from '../../src/types';

/**
 * Create group.
 *
 * The form writes straight to `POST /api/groups`, which creates the row and the
 * caller's owner membership in one transaction; the screen then replaces itself with
 * the new group's page rather than pushing, so Back returns to the directory instead
 * of to a filled-in form that no longer means anything.
 */
export default function CreateGroupScreen() {
  const router = useRouter();
  const [draft, setDraft] = useState<GroupDraft>(emptyGroupDraft);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace(routes.groups));

  const hasName = draft.name.trim().length >= GROUP_NAME_MIN_LENGTH;
  const hasDescription = draft.description.trim().length > 0;
  const canSave = hasName && hasDescription && !isSaving;

  const save = async () => {
    if (!canSave) return;
    setIsSaving(true);
    setErrorMessage(null);

    try {
      const group = await createGroup(draft);
      router.replace(routes.group(group.id));
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
            label="Create group"
            icon="checkmark"
            variant="primary"
            fullWidth
            loading={isSaving}
            disabled={!canSave}
            onPress={() => void save()}
            accessibilityHint="Creates the group and opens its page"
          />
          <Button label="Cancel" variant="ghost" fullWidth disabled={isSaving} onPress={goBack} />
        </>
      }
    >
      <ScreenHeader
        eyebrow="New group"
        title="Start a group"
        subtitle="Societies, study crews, five-a-side teams — anything worth organising people around."
        onBack={goBack}
      />

      {errorMessage ? <Notice tone="danger" message={errorMessage} /> : null}

      <GroupForm
        draft={draft}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        disabled={isSaving}
      />

      <View style={styles.footerNote}>
        <AppText variant="meta">
          You become the owner of this group, which means you can edit it, manage its members and archive it. A group
          with no location still works — it just will not appear in nearby search.
        </AppText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.xxl,
  },
  footerNote: {
    gap: spacing.sm,
  },
});
