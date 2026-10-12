import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AppText,
  Button,
  Card,
  Field,
  FilterRow,
  Notice,
  SectionHeading,
  SegmentedControl,
} from '../../components';
import { interestLabelFor, useInterestCatalog } from '../../data';
import {
  GROUP_AUDIENCE_OPTIONS,
  GROUP_CATEGORIES,
  GROUP_VISIBILITY_OPTIONS,
  groupAudienceHint,
  groupVisibilityHint,
} from '../../data/groupCategories';
import { venueLabelProblem } from '../../lib';
import { layout, spacing } from '../../theme';
import {
  GROUP_DESCRIPTION_MAX_LENGTH,
  GROUP_LOCATION_LABEL_MAX_LENGTH,
  GROUP_NAME_MAX_LENGTH,
  GROUP_NAME_MIN_LENGTH,
  type GroupAudience,
  type GroupCategoryId,
  type GroupDraft,
  type GroupVisibility,
} from '../../types';
import { useAuth } from '../auth';
import { useGroupLocationAnchor } from './useGroupLocationAnchor';

/**
 * The id of the "no interest" chip.
 *
 * `FilterRow` selects by id and a `null` cannot be one, so the empty choice needs a
 * name. It is deliberately not an interest id (ids are `[a-z][a-z0-9_]*` slugs
 * with at least two characters) and it is never sent to the API: the handler below
 * turns it back into `null`.
 */
const NO_INTEREST_ID = 'none';

export interface GroupFormProps {
  draft: GroupDraft;
  /** Receives the changed fields only - never a whole replacement draft. */
  onChange: (patch: Partial<GroupDraft>) => void;
  /** True when the stored group already has an anchor (edit screen only). */
  existingAnchor?: boolean;
  /** Blocks every control while a save is in flight. */
  disabled?: boolean;
}

/**
 * The create/edit form, shared by both screens.
 *
 * One form rather than two, because the fields are identical and the rules that
 * matter (lengths, the audience rule, "a private group needs approval") are enforced
 * by the server either way; here they are only explained.
 *
 * The location control is the one place in the app where a *group* gets a
 * coordinate, and it is deliberately explicit: the member taps "Use my current
 * location", one coarse fix is read, and the point is handed to the caller as part
 * of the draft. Nothing is written to the member's own location record, and a group
 * created without a tap simply has no anchor.
 */
export function GroupForm({ draft, onChange, existingAnchor = false, disabled = false }: GroupFormProps) {
  const anchor = useGroupLocationAnchor();
  const { profile, isConfigured } = useAuth();
  const { options: catalogOptions } = useInterestCatalog(isConfigured);

  // Only the member's *own* interests are offered. The server matches a group's
  // interest against each viewer's own list, so offering the whole catalogue would
  // let an owner claim a match nobody can have.
  //
  // Memoised so its identity is stable: the chip list below depends on it, and a
  // `?? []` inside the dependency array would make that memo recompute on every
  // render for no reason.
  const ownInterestIds = useMemo(() => profile?.interestIds ?? [], [profile?.interestIds]);
  const interestChoices = useMemo(() => {
    const own = catalogOptions
      .filter((option) => ownInterestIds.includes(option.id))
      .map((option) => ({ id: option.id, label: option.label }));

    // A group's interest can be one its owner has since removed from their own
    // profile. It still has to be visible - and clearable - in the editor, so it
    // is appended with a label from the catalogue rather than silently dropped.
    if (draft.interestId !== null && !own.some((option) => option.id === draft.interestId)) {
      own.push({ id: draft.interestId, label: interestLabelFor(draft.interestId) });
    }

    return [{ id: NO_INTEREST_ID, label: 'No interest' }, ...own];
  }, [catalogOptions, ownInterestIds, draft.interestId]);

  const nameLength = draft.name.trim().length;
  const hasName = nameLength >= GROUP_NAME_MIN_LENGTH;
  const descriptionLength = draft.description.length;
  const hasDescription = draft.description.trim().length > 0;

  // A freshly read fix wins; otherwise the stored anchor counts until it is removed.
  const hasAnchor = draft.latitude !== null || (existingAnchor && !draft.removeLocation);

  const [askedForVenue, setAskedForVenue] = useState(false);
  const venueRules = { required: hasAnchor || askedForVenue, maxLength: GROUP_LOCATION_LABEL_MAX_LENGTH };
  const venueProblem = venueLabelProblem(draft.locationLabel ?? '', venueRules);

  const applyCurrentLocation = async () => {
    // A pin with no readable name is refused by the API, so the tap that would drop
    // one asks for the name first (see `EventForm`, which says the same thing).
    if (venueLabelProblem(draft.locationLabel ?? '', { ...venueRules, required: true }) !== null) {
      setAskedForVenue(true);
      return;
    }

    const fix = await anchor.readOneFix();
    if (!fix) return;
    onChange({ latitude: fix.latitude, longitude: fix.longitude, removeLocation: false });
  };

  const clearAnchor = () => {
    anchor.reset();
    onChange({ latitude: null, longitude: null, removeLocation: true });
  };

  return (
    <View style={styles.sections}>
      <Card style={styles.card}>
        <Field
          label="Group name"
          value={draft.name}
          onChangeText={(name) => onChange({ name })}
          placeholder="e.g. Riverside Runners"
          autoCapitalize="words"
          maxLength={GROUP_NAME_MAX_LENGTH}
          editable={!disabled}
          helper={hasName ? undefined : `At least ${GROUP_NAME_MIN_LENGTH} characters.`}
          invalid={!hasName && nameLength > 0}
        />

        <Field
          label="Short description"
          value={draft.description}
          onChangeText={(description) => onChange({ description })}
          placeholder="One or two lines on what the group is for."
          multiline
          maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
          editable={!disabled}
          helper={`${descriptionLength} of ${GROUP_DESCRIPTION_MAX_LENGTH} characters`}
          invalid={!hasDescription && descriptionLength > 0}
        />
      </Card>

      <View style={styles.section}>
        <SectionHeading title="Category" />
        <AppText variant="meta">Pick the one that fits best. People filter the directory by these.</AppText>
        {/* Single choice: tapping the active chip keeps it rather than clearing it. */}
        <View style={styles.filterRow}>
          <FilterRow<GroupCategoryId>
            options={GROUP_CATEGORIES}
            selected={[draft.category]}
            onToggle={(id) => {
              if (id !== draft.category) onChange({ category: id });
            }}
            accessibilityPrefix="Category"
          />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeading title="Primary interest" />
        <AppText variant="meta">
          Pick one of your own interests. Nearby discovery ranks groups that share an interest with the viewer first, and
          people can filter by it. A group with no interest is still listed everywhere - it is simply ranked after the
          matches.
        </AppText>

        {ownInterestIds.length > 0 ? (
          // Single choice: tapping the active chip keeps it rather than clearing it,
          // and the first chip is how the owner says "none".
          <View style={styles.filterRow}>
            <FilterRow<string>
              options={interestChoices}
              selected={[draft.interestId ?? NO_INTEREST_ID]}
              onToggle={(id) => {
                const next = id === NO_INTEREST_ID ? null : id;
                if (next !== draft.interestId) onChange({ interestId: next });
              }}
              accessibilityPrefix="Primary interest"
            />
          </View>
        ) : (
          <Notice
            tone="info"
            message="Add interests to your own profile first"
            detail="A group's interest is matched against what each member picked, so it has to come from your own list. Add a few in your profile and come back."
          />
        )}
      </View>

      <View style={styles.section}>
        <SectionHeading title="Who can join" />
        <SegmentedControl<GroupVisibility>
          options={GROUP_VISIBILITY_OPTIONS}
          value={draft.visibility}
          onChange={(visibility) => onChange({ visibility })}
          accessibilityLabel="Group visibility"
        />
        <AppText variant="meta">{groupVisibilityHint(draft.visibility)}</AppText>

        <AppText variant="metaStrong" style={styles.subLabel}>
          Audience
        </AppText>
        <View style={styles.filterRow}>
          <FilterRow<GroupAudience>
            options={GROUP_AUDIENCE_OPTIONS}
            selected={[draft.audience]}
            onToggle={(id) => {
              if (id !== draft.audience) onChange({ audience: id });
            }}
            accessibilityPrefix="Audience"
          />
        </View>
        <AppText variant="meta">{groupAudienceHint(draft.audience)}</AppText>

        {draft.visibility === 'private' || draft.audience !== 'everyone' ? (
          <Notice
            tone="info"
            message={draft.visibility === 'private' ? 'Private groups need approval.' : 'Audience limits who can join.'}
            detail={
              draft.visibility === 'private'
                ? 'People can still find a preview and ask to join, but a member only gets in once you or an administrator approves the request.'
                : 'Eligibility is decided by each member’s own setting in their profile. You can create this group only if your own setting matches, and members who do not match cannot find or join it.'
            }
          />
        ) : null}
      </View>

      <View style={styles.section}>
        <SectionHeading title="Where it meets" />
        <Card style={styles.card}>
          <Field
            label="Location label"
            value={draft.locationLabel ?? ''}
            onChangeText={(value) => onChange({ locationLabel: value.length > 0 ? value : null })}
            placeholder="e.g. Riverside Park, north gate"
            autoCapitalize="words"
            maxLength={GROUP_LOCATION_LABEL_MAX_LENGTH}
            editable={!disabled}
            helper={venueProblem ?? "A human-readable place, shown on the group's card and page."}
            invalid={venueProblem !== null}
          />

          <AppText variant="meta">
            Add a location to make the group discoverable nearby. The point is stored with the group - never taken
            from your own saved location - and only one coarse reading is used.
          </AppText>

          {anchor.errorMessage ? (
            <Notice
              tone="danger"
              message={anchor.errorMessage}
              action={
                anchor.permission === 'granted'
                  ? { label: 'Try again', onPress: () => void applyCurrentLocation() }
                  : undefined
              }
            />
          ) : null}

          <AppText variant="meta">
            {hasAnchor
              ? `Nearby discovery: on - ${
                  draft.latitude !== null ? 'anchored to the reading you just took.' : 'anchored to the saved position.'
                }`
              : 'Nearby discovery: off - the group will not appear in nearby results.'}
          </AppText>

          <View style={styles.anchorActions}>
            <Button
              label={hasAnchor ? 'Update location' : 'Use my current location'}
              icon="navigate-outline"
              variant="secondary"
              loading={anchor.isWorking}
              disabled={disabled}
              onPress={() => void applyCurrentLocation()}
              style={styles.anchorButton}
              accessibilityHint="Reads one coarse position and uses it as the group's meeting point"
            />
            <Button
              label="Remove"
              icon="trash-outline"
              variant="danger"
              disabled={!hasAnchor || disabled || anchor.isWorking}
              onPress={clearAnchor}
              style={styles.anchorButton}
              accessibilityHint="Removes the group's location so it is not discoverable nearby"
            />
          </View>
        </Card>
      </View>
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
  section: {
    gap: spacing.md,
  },
  subLabel: {
    marginTop: spacing.xs,
  },
  filterRow: {
    // The chip rail runs to the screen edge so it reads as scrollable.
    marginRight: -layout.screenPadding,
  },
  anchorActions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  anchorButton: {
    flex: 1,
  },
});
