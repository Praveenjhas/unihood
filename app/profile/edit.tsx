import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Button, ErrorState, ListSkeleton, Notice, Screen, ScreenHeader } from '../../src/components';
import { useInterestCatalog } from '../../src/data';
import { useAuth } from '../../src/features/auth';
import { LocationSharingCard } from '../../src/features/location';
import { ProfileForm } from '../../src/features/profile';
import { describeError, routes } from '../../src/lib';
import { spacing } from '../../src/theme';
import { draftFromProfile, type Profile, type ProfileDraft } from '../../src/types';

/** True when the two drafts would write the same row. */
function sameDraft(left: ProfileDraft, right: ProfileDraft): boolean {
  return (
    left.displayName === right.displayName &&
    left.bio === right.bio &&
    left.avatarPath === right.avatarPath &&
    left.locationLabel === right.locationLabel &&
    left.isDiscoverable === right.isDiscoverable &&
    left.nearbyDiscoveryEnabled === right.nearbyDiscoveryEnabled &&
    left.groupEligibilityGender === right.groupEligibilityGender &&
    [...left.interestIds].sort().join(',') === [...right.interestIds].sort().join(',')
  );
}

/**
 * Profile editor.
 *
 * It edits a local draft rather than the provider's row, so abandoning the screen
 * — back gesture, hardware back, app kill — leaves the stored profile untouched
 * and there is no half-saved state to reason about. Save is the only write, and
 * it goes through `useAuth().saveProfile`, i.e. the same `PUT /api/profile/me` call
 * onboarding uses.
 *
 * The location card lives here rather than on the profile screen because storing
 * a fix is only allowed while nearby discovery is on, and this is the screen that
 * owns that switch.
 */
export default function EditProfileScreen() {
  const router = useRouter();
  const { profile, profileError, refreshProfile } = useAuth();

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(routes.profile);
  };

  if (!profile) {
    return (
      <Screen>
        <ScreenHeader title="Edit profile" onBack={goBack} />
        <View style={styles.state}>
          {profileError ? (
            <ErrorState message={describeError(profileError)} onRetry={refreshProfile} />
          ) : (
            <ListSkeleton rows={2} />
          )}
        </View>
      </Screen>
    );
  }

  return <ProfileEditor profile={profile} onDone={goBack} />;
}

/**
 * The editor itself, mounted only once the row is in hand so both the draft and
 * the baseline are seeded from real data instead of being patched by an effect.
 */
function ProfileEditor({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const { refreshProfile, saveProfile } = useAuth();
  const { options: interestOptions } = useInterestCatalog(true);

  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(profile));
  // What the server currently holds, so "unsaved changes" is a comparison
  // rather than a flag somebody has to remember to clear.
  const [baseline, setBaseline] = useState<ProfileDraft>(() => draftFromProfile(profile));
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const hasName = draft.displayName.trim().length > 0;
  const isDirty = !sameDraft(draft, baseline);
  const canSave = hasName && isDirty && !isSaving;

  const save = async () => {
    if (!canSave) return;
    setIsSaving(true);
    setErrorMessage(null);

    try {
      const saved = await saveProfile(draft);
      // Re-baseline so the form matches the stored row, then leave: the profile
      // screen renders whatever the provider now holds.
      setBaseline(draftFromProfile(saved));
      onDone();
    } catch (caught) {
      setErrorMessage(describeError(caught));
      setIsSaving(false);
    }
  };

  const discard = () => {
    setDraft(baseline);
    setErrorMessage(null);
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
            accessibilityHint="Saves your profile and returns to it"
          />
          <Button
            label="Discard changes"
            variant="ghost"
            fullWidth
            disabled={!isDirty || isSaving}
            onPress={discard}
          />
        </>
      }
    >
      <ScreenHeader
        eyebrow="Your details"
        title="Edit profile"
        subtitle="Your name, area and interests are what People search matches on, so the more accurate they are the better the results."
        onBack={onDone}
      />

      {errorMessage ? <Notice tone="danger" message={errorMessage} /> : null}

      <ProfileForm
        draft={draft}
        onChange={(changes) => setDraft((current) => ({ ...current, ...changes }))}
        interestOptions={interestOptions}
        disabled={isSaving}
        showGroupEligibility
        locationSlot={
          <LocationSharingCard
            enabled={draft.nearbyDiscoveryEnabled}
            initialUpdatedAt={profile.locationUpdatedAt}
            onChanged={refreshProfile}
          />
        }
      />

      <AppText variant="meta">
        {isDirty
          ? 'You have unsaved changes. Nothing is written until you save.'
          : 'Everything here is saved. Saving writes the whole profile in one step.'}
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
});
