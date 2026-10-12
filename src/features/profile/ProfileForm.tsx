import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Card, Field, FilterRow, ListDivider, SectionHeading, Toggle } from '../../components';
import { GROUP_ELIGIBILITY_OPTIONS, type InterestOption } from '../../data';
import { layout, spacing } from '../../theme';
import {
  BIO_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  LOCATION_LABEL_MAX_LENGTH,
  MAX_PROFILE_INTERESTS,
  type GroupEligibilityGender,
  type ProfileDraft,
} from '../../types';

export interface ProfileFormProps {
  draft: ProfileDraft;
  /** Receives the changed fields only — never a whole replacement draft. */
  onChange: (patch: Partial<ProfileDraft>) => void;
  /** Options from `useInterestCatalog`, as plain-string ids. */
  interestOptions: readonly InterestOption[];
  /** Blocks the text inputs and switches while a save is in flight. */
  disabled?: boolean;
  /** Rendered inside the privacy section, under the switches. */
  locationSlot?: ReactNode;
  /** Overrides the line under the interest picker. */
  interestHint?: string;
  /**
   * Shows the optional group-eligibility setting.
   *
   * Off during onboarding on purpose: the product must not ask for this while
   * someone is still creating an account. The profile editor turns it on, which is
   * where a member goes *because* they want to join a restricted group.
   */
  showGroupEligibility?: boolean;
}

/**
 * The profile form — shared by onboarding and the profile editor.
 *
 * Both screens write the same seven fields through the same RPC, so they share
 * one form rather than two copies that drift apart. The form owns presentation
 * and the two rules the member can feel immediately (a name is required, the
 * interest cap is visible before it bites); every length and consent rule is
 * enforced again server-side.
 *
 * Turn "Show me in People" off and nearby discovery follows, because the
 * database rejects a profile that keeps a location while hidden. Doing it here
 * means the member never meets that error at all.
 */
export function ProfileForm({
  draft,
  onChange,
  interestOptions,
  disabled = false,
  locationSlot,
  interestHint,
  showGroupEligibility = false,
}: ProfileFormProps) {
  const hasName = draft.displayName.trim().length > 0;
  const bioLength = draft.bio?.length ?? 0;
  const selectedCount = draft.interestIds.length;
  const atInterestLimit = selectedCount >= MAX_PROFILE_INTERESTS;

  const toggleInterest = (id: string) => {
    if (draft.interestIds.includes(id)) {
      onChange({ interestIds: draft.interestIds.filter((entry) => entry !== id) });
      return;
    }
    // Quietly refusing the 13th pick beats a server round-trip that fails
    // after the member has already moved on to something else.
    if (atInterestLimit) return;
    onChange({ interestIds: [...draft.interestIds, id] });
  };

  return (
    <View style={styles.sections}>
      <Card style={styles.card}>
        <Field
          label="Display name"
          value={draft.displayName}
          onChangeText={(displayName) => onChange({ displayName })}
          placeholder="The name other members will see"
          autoCapitalize="words"
          autoComplete="name"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          editable={!disabled}
          helper={hasName ? undefined : 'A display name is required.'}
          invalid={!hasName}
        />

        <Field
          label="Your area"
          value={draft.locationLabel ?? ''}
          onChangeText={(value) => onChange({ locationLabel: value.length > 0 ? value : null })}
          placeholder="e.g. Riverside, or Northgate campus"
          autoCapitalize="words"
          maxLength={LOCATION_LABEL_MAX_LENGTH}
          editable={!disabled}
          helper="A general area you are happy to share. Text only — it is never turned into coordinates."
        />

        <Field
          label="About you"
          value={draft.bio ?? ''}
          onChangeText={(value) => onChange({ bio: value.length > 0 ? value : null })}
          placeholder="A line or two about what you are into right now."
          multiline
          maxLength={BIO_MAX_LENGTH}
          editable={!disabled}
          helper={`${bioLength} of ${BIO_MAX_LENGTH} characters`}
        />
      </Card>

      <View style={styles.section}>
        <SectionHeading title="Interests" count={selectedCount} />
        <AppText variant="meta">
          {interestHint ??
            `Pick up to ${MAX_PROFILE_INTERESTS}. Every interest you add widens who you can match with — nearby search ranks people by what you share.`}
        </AppText>
        <View style={styles.filterRow}>
          <FilterRow
            options={interestOptions}
            selected={draft.interestIds}
            onToggle={toggleInterest}
            accessibilityPrefix="Interest"
          />
        </View>
        {atInterestLimit ? (
          <AppText variant="meta">
            {`That is the maximum of ${MAX_PROFILE_INTERESTS}. Untick one to swap it for another.`}
          </AppText>
        ) : null}
      </View>

      <View style={styles.section}>
        <SectionHeading title="Privacy" />
        <Card style={styles.toggles}>
          <Toggle
            label="Show me in People"
            description="Others can find your profile by name and see the interests you picked. Turn this off to be invisible."
            value={draft.isDiscoverable}
            disabled={disabled}
            onChange={(isDiscoverable) =>
              // Nearby discovery cannot work while hidden, so it goes too.
              onChange(isDiscoverable ? { isDiscoverable } : { isDiscoverable, nearbyDiscoveryEnabled: false })
            }
          />
          <ListDivider />
          <Toggle
            label="Nearby discovery"
            description="Lets Unihood save one coarse area so you can appear in nearby results. It stays saved until you change it."
            value={draft.nearbyDiscoveryEnabled}
            disabled={disabled || !draft.isDiscoverable}
            onChange={(nearbyDiscoveryEnabled) => onChange({ nearbyDiscoveryEnabled })}
          />
          {locationSlot ? <View style={styles.slot}>{locationSlot}</View> : null}
        </Card>
        {draft.isDiscoverable ? null : (
          <AppText variant="meta">
            Nearby discovery needs a visible profile, so it stays off while you are hidden.
          </AppText>
        )}
      </View>

      {showGroupEligibility ? (
        <View style={styles.section}>
          <SectionHeading title="Gender (optional)" />
          <AppText variant="meta">
            Some groups are for women only and some are for men only. Picking one here is how Unihood decides which of
            those you can find, create and join. It is private: it is never shown on your profile, on People cards, or to
            a group administrator - and you can leave it unset.
          </AppText>
          <View style={styles.filterRow}>
            <FilterRow<GroupEligibilityGender>
              options={GROUP_ELIGIBILITY_OPTIONS}
              selected={draft.groupEligibilityGender ? [draft.groupEligibilityGender] : []}
              onToggle={(id) =>
                // Single choice: tapping the active chip again clears the setting,
                // which is the way back to "not set".
                onChange({ groupEligibilityGender: draft.groupEligibilityGender === id ? null : id })
              }
              accessibilityPrefix="Gender"
            />
          </View>
          <AppText variant="meta">
            {draft.groupEligibilityGender
              ? 'Saved with your profile. Change or clear it here at any time.'
              : 'Not set, so men-only and women-only groups cannot be created or joined yet.'}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sections: {
    gap: spacing.xxl,
  },
  card: {
    gap: spacing.lg,
  },
  toggles: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  slot: {
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  section: {
    gap: spacing.md,
  },
  filterRow: {
    // The chip rail runs to the screen edge so it reads as scrollable.
    marginRight: -layout.screenPadding,
  },
});
