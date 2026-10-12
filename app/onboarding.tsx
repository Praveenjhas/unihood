import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AppText,
  Button,
  Card,
  ErrorState,
  Field,
  FilterRow,
  ListSkeleton,
  Notice,
  Screen,
  ScreenHeader,
  SectionHeading,
  Toggle,
} from '../src/components';
import { GROUP_ELIGIBILITY_OPTIONS, useInterestCatalog } from '../src/data';
import { useAuth } from '../src/features/auth';
import { updateMyLocation, useCurrentFix } from '../src/features/location';
import { InterestPicker } from '../src/features/onboarding';
import { describeError } from '../src/lib';
import { layout, spacing } from '../src/theme';
import {
  DISPLAY_NAME_MAX_LENGTH,
  LOCATION_LABEL_MAX_LENGTH,
  MAX_PROFILE_INTERESTS,
  draftFromProfile,
  type GroupEligibilityGender,
  type Profile,
  type ProfileDraft,
} from '../src/types';

/**
 * How many interests onboarding asks for before it lets someone continue.
 *
 * Three, because ranking by shared interests needs *something* to rank by, and
 * because the number is small enough not to feel like a chore. It is a product
 * rule rather than an API rule - `PUT /api/profile/me` accepts an empty list, and
 * the explicit "Skip for now" below is what uses that.
 */
const MIN_ONBOARDING_INTERESTS = 3;

type Step = 1 | 2 | 3;

const STEP_COPY: Record<Step, { title: string; subtitle: string }> = {
  1: {
    title: 'About you',
    subtitle: 'Two fields, and everything here can be changed later from your profile.',
  },
  2: {
    title: 'What are you into?',
    subtitle: 'Nearby people and groups are ranked by what you share, so this is the step that makes the app useful.',
  },
  3: {
    title: 'Finding people nearby',
    subtitle: 'Entirely optional, and off until you say otherwise.',
  },
};

/**
 * Onboarding — the gate between "signed up" and "in the app".
 *
 * It exists because `profile_completed` is false for a brand-new row, and the root
 * guard sends any such member here rather than into a People list that would have
 * nothing to rank them by. Finishing is not a navigation this screen performs:
 * the final save flips the flag, the guard notices, and the whole section swaps.
 *
 * **Resumable on purpose.** Each step is saved before the next one is shown, with
 * `complete: false`, so a member who is interrupted (a call, a dead battery, a
 * swipe away) comes back to a form pre-filled with what they already entered
 * rather than to an empty one. Only the last step marks the profile complete.
 *
 * The row may also still be loading, or may have failed to load. Both cases are
 * handled here rather than in the guard, and both offer a way out (retry, or sign
 * out), because a member must never be trapped on a screen they cannot use.
 */
export default function OnboardingScreen() {
  const { profile, profileError, refreshProfile, signOut } = useAuth();

  if (!profile) {
    return (
      <Screen contentStyle={styles.content}>
        <ScreenHeader
          eyebrow="Welcome"
          title="Setting up your account"
          subtitle="Fetching your profile so you can finish it in a few steps."
        />
        <View style={styles.state}>
          {profileError ? (
            <ErrorState message={describeError(profileError)} onRetry={refreshProfile} />
          ) : (
            <ListSkeleton rows={2} />
          )}
          <Button label="Sign out" variant="ghost" fullWidth onPress={() => void signOut()} />
        </View>
      </Screen>
    );
  }

  return <OnboardingFlow profile={profile} />;
}

/**
 * The flow itself, mounted only once the profile has arrived, so its draft is
 * seeded from a real row instead of being patched up by an effect.
 */
function OnboardingFlow({ profile }: { profile: Profile }) {
  const { phone, email, saveProfile, signOut } = useAuth();
  const { options: interestOptions, isLoading: interestsLoading } = useInterestCatalog(true);
  const fix = useCurrentFix();

  const [step, setStep] = useState<Step>(1);
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(profile));
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const [locationStored, setLocationStored] = useState(Boolean(profile.locationUpdatedAt));

  const patch = (changes: Partial<ProfileDraft>) => setDraft((current) => ({ ...current, ...changes }));

  const hasName = draft.displayName.trim().length > 0;
  const enoughInterests = draft.interestIds.length >= MIN_ONBOARDING_INTERESTS;
  const copy = STEP_COPY[step];

  /**
   * Saves the draft, then either advances or finishes.
   *
   * `next === null` means "finish": the write marks the profile complete, and the
   * screen is left in its saving state because the guard is about to unmount it -
   * re-enabling the button first would flash an editable form.
   */
  const saveAndMove = async (next: Step | null) => {
    if (isSaving) return;
    setIsSaving(true);
    setErrorMessage(null);

    try {
      await saveProfile(draft, { complete: next === null });
      if (next === null) return;
      setStep(next);
      setIsSaving(false);
    } catch (caught) {
      setErrorMessage(describeError(caught));
      setIsSaving(false);
    }
  };

  /**
   * Stores the fix the member just confirmed.
   *
   * Consent has to reach the database *before* the coordinates do, because
   * `PUT /api/location/me` refuses to write without it - so the draft is saved
   * with nearby discovery switched on first. That is also why this is a separate
   * step from "Continue": nothing is written until the member has seen the number
   * the app is about to use and said yes to it.
   */
  const confirmLocation = async () => {
    if (!fix.fix || isSaving) return;
    setIsSaving(true);
    setErrorMessage(null);
    setLocationNotice(null);

    try {
      await saveProfile({ ...draft, isDiscoverable: true, nearbyDiscoveryEnabled: true }, { complete: false });
      const stored = await updateMyLocation({ latitude: fix.fix.latitude, longitude: fix.fix.longitude });

      setLocationStored(Boolean(stored.locationUpdatedAt));
      setLocationNotice('Nearby area saved. It is rounded to about 11 m, and stays saved until you change it.');
      fix.reset();
    } catch (caught) {
      setErrorMessage(describeError(caught));
    } finally {
      setIsSaving(false);
    }
  };

  const removeLocation = async () => {
    setIsSaving(true);
    setErrorMessage(null);

    try {
      // Withdrawing consent also deletes the stored fix server-side (the profile
      // write is what does it), so there is nothing else to call.
      await saveProfile({ ...draft, nearbyDiscoveryEnabled: false }, { complete: false });
      patch({ nearbyDiscoveryEnabled: false });
      setLocationStored(false);
      setLocationNotice('Nearby discovery is off and the stored location is gone.');
    } catch (caught) {
      setErrorMessage(describeError(caught));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Screen
      contentStyle={styles.content}
      footer={
        <>
          {step === 1 ? (
            <Button
              label="Continue"
              icon="arrow-forward"
              variant="primary"
              fullWidth
              loading={isSaving}
              disabled={!hasName || isSaving}
              onPress={() => void saveAndMove(2)}
              accessibilityHint="Saves your name and moves to interests"
            />
          ) : null}

          {step === 2 ? (
            <>
              <Button
                label="Continue"
                icon="arrow-forward"
                variant="primary"
                fullWidth
                loading={isSaving}
                disabled={!enoughInterests || isSaving}
                onPress={() => void saveAndMove(3)}
                accessibilityHint="Saves your interests and moves to location"
              />
              <Button
                label="Skip for now"
                variant="secondary"
                fullWidth
                disabled={isSaving}
                onPress={() => void saveAndMove(3)}
                accessibilityHint="Continues without picking interests"
              />
            </>
          ) : null}

          {step === 3 ? (
            <Button
              label="Finish and start exploring"
              icon="checkmark"
              variant="primary"
              fullWidth
              loading={isSaving}
              disabled={isSaving}
              onPress={() => void saveAndMove(null)}
              accessibilityHint="Saves your profile and opens the app"
            />
          ) : null}

          {step > 1 ? (
            <Button
              label="Back"
              variant="ghost"
              fullWidth
              disabled={isSaving}
              onPress={() => setStep((current) => (current === 3 ? 2 : 1))}
            />
          ) : (
            <Button label="Sign out" variant="ghost" fullWidth disabled={isSaving} onPress={() => void signOut()} />
          )}
        </>
      }
    >
      <ScreenHeader eyebrow={`Step ${step} of 3`} title={copy.title} subtitle={copy.subtitle} />

      {errorMessage ? <Notice tone="danger" message={errorMessage} /> : null}

      {step === 1 ? (
        <>
          <Card style={styles.card}>
            <Field
              label="Display name"
              value={draft.displayName}
              onChangeText={(displayName) => patch({ displayName })}
              placeholder="The name other members will see"
              autoCapitalize="words"
              autoComplete="name"
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              autoFocus
              editable={!isSaving}
              helper={hasName ? 'This is what people see next to your interests.' : 'A display name is required.'}
              invalid={!hasName}
            />
          </Card>

          <View style={styles.section}>
            <SectionHeading title="Gender (optional)" />
            <AppText variant="meta">
              Some groups are for women only and some are for men only. Picking one here is how Unihood decides which of
              those you can find and join. It is private: it never appears on your profile, on a People card, or in front
              of a group administrator.
            </AppText>
            <View style={styles.filterRow}>
              <FilterRow<GroupEligibilityGender>
                options={GROUP_ELIGIBILITY_OPTIONS}
                selected={draft.groupEligibilityGender ? [draft.groupEligibilityGender] : []}
                onToggle={(id) =>
                  // Single choice: tapping the active chip again clears it, which is
                  // the way back to "not set".
                  patch({ groupEligibilityGender: draft.groupEligibilityGender === id ? null : id })
                }
                accessibilityPrefix="Gender"
              />
            </View>
            <AppText variant="meta">
              {draft.groupEligibilityGender
                ? 'Saved with your profile. You can change or clear it at any time.'
                : 'Not set, so men-only and women-only groups are closed to you for now.'}
            </AppText>
          </View>
        </>
      ) : null}

      {step === 2 ? (
        <InterestPicker
          options={interestOptions}
          selectedIds={draft.interestIds}
          disabled={isSaving}
          isLoading={interestsLoading}
          minSelections={MIN_ONBOARDING_INTERESTS}
          maxSelections={MAX_PROFILE_INTERESTS}
          onToggle={(id) =>
            patch({
              interestIds: draft.interestIds.includes(id)
                ? draft.interestIds.filter((entry) => entry !== id)
                : [...draft.interestIds, id],
            })
          }
          hint={
            enoughInterests
              ? 'Good to go — you can add or remove these later from your profile.'
              : 'You can skip this, but a few shared interests is what makes the People list useful.'
          }
        />
      ) : null}

      {step === 3 ? (
        <>
          <Card style={styles.card}>
            <Toggle
              label="Show me in Nearby"
              description="Lets Unihood save one coarse area so you appear in nearby results. It stays saved until you change it. Off by default."
              value={draft.nearbyDiscoveryEnabled}
              disabled={isSaving}
              onChange={(nearbyDiscoveryEnabled) => patch({ nearbyDiscoveryEnabled })}
            />
          </Card>

          {draft.nearbyDiscoveryEnabled ? (
            <>
              <AppText variant="meta">
                Unihood uses your location while the app is open — never in the background — to find people and groups
                around you. One fix is read when you tap the button below, rounded to about 11 m before it is stored, and
                it is only ever visible to members who have also switched Nearby on.
              </AppText>

              <AppText variant="meta">
                A saved area does not expire. It stays where you put it until you change it, remove it or close your
                account, so you will not be asked for it again on the next sign-in or app start.
              </AppText>

              {fix.fix ? (
                <Notice
                  tone="info"
                  message="Use this as your nearby area?"
                  detail="Confirm and Unihood will store this one fix. Nothing has been saved yet."
                  action={{ label: 'Use it', onPress: () => void confirmLocation() }}
                />
              ) : null}

              {fix.fix ? (
                <Button label="Not now" variant="ghost" fullWidth disabled={isSaving} onPress={fix.reset} />
              ) : (
                <Button
                  label={locationStored ? 'Update my location' : 'Use my current location'}
                  icon="navigate-outline"
                  variant="secondary"
                  fullWidth
                  loading={fix.isWorking || isSaving}
                  disabled={isSaving}
                  onPress={() => void fix.requestFix()}
                  accessibilityHint="Asks for permission, then reads one coarse location"
                />
              )}

              {fix.status === 'denied' ? (
                <Notice
                  tone="info"
                  message="Unihood cannot see your location."
                  detail="Nothing was stored. Nearby discovery will need location permission — or a stored area — later, so you can finish onboarding and turn it on from your profile whenever you like."
                />
              ) : null}

              {fix.status === 'error' && fix.errorMessage ? (
                <Notice
                  tone="danger"
                  message={fix.errorMessage}
                  action={{ label: 'Try again', onPress: () => void fix.requestFix() }}
                />
              ) : null}

              {fix.permission === 'unavailable' ? (
                <Notice tone="info" message="This device cannot report a location, so nearby search will stay unavailable." />
              ) : null}

              {locationNotice ? <Notice tone="success" message={locationNotice} /> : null}

              {locationStored ? (
                <Button
                  label="Remove my location"
                  icon="trash-outline"
                  variant="danger"
                  fullWidth
                  disabled={isSaving}
                  onPress={() => void removeLocation()}
                />
              ) : null}
            </>
          ) : (
            <Notice
              tone="info"
              message="Nearby is off."
              detail="You can still browse every public group and event, and you can skip this step entirely. Turning Nearby on later needs location permission; finishing without it also deletes any location already stored."
            />
          )}

          <Card style={styles.card}>
            <Field
              label="Area label (optional)"
              value={draft.locationLabel ?? ''}
              onChangeText={(locationLabel) => patch({ locationLabel: locationLabel.length === 0 ? null : locationLabel })}
              placeholder="e.g. North Campus"
              maxLength={LOCATION_LABEL_MAX_LENGTH}
              editable={!isSaving}
              helper="A rough area other members can see. Free text — never a coordinate, and never geocoded."
            />
          </Card>

          <AppText variant="meta">
            Everything on this screen can be changed from your profile, and Nearby can be switched off — which also
            deletes the stored fix. Come back and update your nearby area whenever you move, or whenever you want to be
            part of a different local community.
          </AppText>
        </>
      ) : null}

      <AppText variant="meta" align="center">
        {phone
          ? `This account signs in with ${phone}.`
          : email
            ? `This account signs in as ${email}.`
            : 'Signing you in.'}
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
    gap: spacing.md,
  },
  card: {
    gap: spacing.lg,
  },
  section: {
    gap: spacing.sm,
  },
  filterRow: {
    // The chip rail runs to the screen edge so it reads as scrollable.
    marginRight: -layout.screenPadding,
  },
});
