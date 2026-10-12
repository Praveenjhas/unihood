import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Button, Card, Field, FilterRow, Notice, SectionHeading } from '../../components';
import { EVENT_CATEGORIES } from '../../data/eventCategories';
import { venueLabelProblem } from '../../lib';
import { colors, layout, spacing } from '../../theme';
import {
  EVENT_DESCRIPTION_MAX_LENGTH,
  EVENT_LOCATION_LABEL_MAX_LENGTH,
  MAX_EVENT_PARTICIPANTS,
  EVENT_TITLE_MAX_LENGTH,
  type EventFormValues,
  type Group,
} from '../../types';
import { useGroupLocationAnchor } from '../groups';

export interface EventFormProps {
  values: EventFormValues;
  /** Receives the changed fields only - never a whole replacement form. */
  onChange: (patch: Partial<EventFormValues>) => void;
  /** The groups this member may host for; the picker offers these and nothing else. */
  groups: readonly Group[];
  /**
   * True on the Events tab's create flow (Phase 7): the event must belong to one of
   * the member's groups, so the "No group" option is removed. The group page keeps
   * it, because an event that is already standalone has to stay editable.
   */
  requireGroup?: boolean;
  /** True when the stored event already has an anchor (edit screen only). */
  existingLocation?: boolean;
  /** Blocks every control while a save is in flight. */
  disabled?: boolean;
}

/** The chip id that means "not attached to a group". Never a real group id. */
const NO_GROUP = '__none__';

/**
 * The create/edit form, shared by both screens.
 *
 * One form rather than two, because the fields are identical and the rules that
 * matter (lengths, the time window, the capacity, the group attachment) are
 * enforced by the server either way; here they are only explained.
 *
 * Three deliberate choices:
 *
 *   * **One category.** The chip row is multi-select elsewhere, but an event has
 *     exactly one category, so a tap *sets* it rather than toggling it off.
 *   * **The form does not invent a venue.** The location control is the only place
 *     an event gets a coordinate, and it is a separate, explicit tap: the label
 *     ("Riverside Park, north gate") is what people read, and the point is what
 *     makes the event discoverable nearby. Nothing is taken from the member's own
 *     saved location.
 *   * **Times are typed, locally.** There is no date-picker dependency in this
 *     project, so the fields are plain text in the device's own timezone
 *     (`YYYY-MM-DD` and 24-hour `HH:mm`) and `eventBodyFrom` converts them to the
 *     UTC instants the API stores.
 */
export function EventForm({
  values,
  onChange,
  groups,
  requireGroup = false,
  existingLocation = false,
  disabled = false,
}: EventFormProps) {
  const anchor = useGroupLocationAnchor('event');

  // A freshly read fix wins; otherwise the stored anchor counts until it is removed.
  const hasAnchor = values.latitude !== null || (existingLocation && !values.removeLocation);

  /**
   * The venue name is checked here as well as on the server.
   *
   * A pin with no readable name is refused by the API - "here" is not an address,
   * and the name is the part everyone who is not standing next to it reads. Asking
   * for it at the moment the pin would be dropped is cheaper than a save that
   * cannot work, which is what `askedForVenue` remembers: the field starts showing
   * the requirement the first time the member reaches for a pin without one.
   */
  const [askedForVenue, setAskedForVenue] = useState(false);
  const venueRules = { required: hasAnchor || askedForVenue, maxLength: EVENT_LOCATION_LABEL_MAX_LENGTH };
  const venueProblem = venueLabelProblem(values.locationLabel, venueRules);

  /**
   * The group chips.
   *
   * `requireGroup` (the Events tab's create flow, Phase 7) drops the "No group"
   * option: every event made from there belongs to one of the member's groups, which
   * is what the unified feed can answer for. The group page keeps the standalone
   * option, because an event that is already standalone must stay editable.
   */
  const groupOptions = [
    ...(requireGroup ? [] : [{ id: NO_GROUP, label: 'No group' }]),
    ...groups.map((group) => ({
      id: group.id,
      label: group.visibility === 'private' ? `${group.name} (private)` : group.name,
    })),
  ];

  const applyCurrentLocation = async () => {
    if (venueLabelProblem(values.locationLabel, { ...venueRules, required: true }) !== null) {
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
          label="Event title"
          value={values.title}
          onChangeText={(title) => onChange({ title })}
          placeholder="e.g. Sunday long run"
          autoCapitalize="words"
          maxLength={EVENT_TITLE_MAX_LENGTH}
          editable={!disabled}
        />

        <Field
          label="What is it?"
          value={values.description}
          onChangeText={(description) => onChange({ description })}
          placeholder="A couple of lines on what happens and who it is for."
          multiline
          maxLength={EVENT_DESCRIPTION_MAX_LENGTH}
          editable={!disabled}
          helper={`${values.description.length}/${EVENT_DESCRIPTION_MAX_LENGTH}`}
        />
      </Card>

      <View style={styles.section}>
        <SectionHeading title="Category" />
        <View style={styles.filterRow}>
          <FilterRow
            options={EVENT_CATEGORIES}
            // One category at a time: tapping a chip selects it.
            selected={[values.category]}
            onToggle={(id) => onChange({ category: id })}
            accessibilityPrefix="Category"
          />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeading title="When" />
        <Card style={styles.card}>
          <Field
            label="Date"
            value={values.date}
            onChangeText={(date) => onChange({ date })}
            placeholder="2026-10-10"
            keyboardType="numbers-and-punctuation"
            editable={!disabled}
            helper="Local date as YYYY-MM-DD."
          />
          <View style={styles.timeRow}>
            <View style={styles.timeField}>
              <Field
                label="Starts"
                value={values.startTime}
                onChangeText={(startTime) => onChange({ startTime })}
                placeholder="18:00"
                keyboardType="numbers-and-punctuation"
                editable={!disabled}
                helper="24-hour, e.g. 18:00"
              />
            </View>
            <View style={styles.timeField}>
              <Field
                label="Ends"
                value={values.endTime}
                onChangeText={(endTime) => onChange({ endTime })}
                placeholder="20:00"
                keyboardType="numbers-and-punctuation"
                editable={!disabled}
                helper="Must be after the start"
              />
            </View>
          </View>
          <AppText variant="meta">
            Entered in your device’s timezone and stored as UTC, so everyone sees the same moment.
          </AppText>
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeading title="Where" />
        <Card style={styles.card}>
          <Field
            label="Venue"
            value={values.locationLabel}
            onChangeText={(locationLabel) => onChange({ locationLabel })}
            placeholder="e.g. Riverside Park, north gate"
            autoCapitalize="words"
            maxLength={EVENT_LOCATION_LABEL_MAX_LENGTH}
            editable={!disabled}
            helper={venueProblem ?? 'Shown on the card and the event page.'}
            invalid={venueProblem !== null}
          />

          <AppText variant="meta">
            Add a map position to make the event discoverable nearby. The point is stored with the event - never taken
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
                  values.latitude !== null ? 'anchored to the reading you just took.' : 'anchored to the saved position.'
                }`
              : 'Nearby discovery: off - the event will not appear in nearby results.'}
          </AppText>

          <View style={styles.anchorActions}>
            <Button
              label={hasAnchor ? 'Update location' : 'Use my current location as the venue'}
              icon="navigate-outline"
              variant="secondary"
              loading={anchor.isWorking}
              disabled={disabled}
              onPress={() => void applyCurrentLocation()}
              style={styles.anchorButton}
              accessibilityHint="Reads one coarse position and uses it as the event's venue"
            />
            <Button
              label="Remove"
              icon="trash-outline"
              variant="danger"
              disabled={!hasAnchor || disabled || anchor.isWorking}
              onPress={clearAnchor}
              style={styles.anchorButton}
              accessibilityHint="Removes the event's map position so it is not discoverable nearby"
            />
          </View>
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeading title="Who is it for" />
        <Card style={styles.card}>
          {groups.length === 0 ? (
            <AppText variant="meta">
              {requireGroup
                ? 'You are not in a group yet, so there is nowhere to post this. Join a group first - its members will see the event on their calendar.'
                : 'You are not in a group yet, so this will be a standalone event that anyone eligible can find.'}
            </AppText>
          ) : (
            <>
              <AppText variant="label">Hosted by</AppText>
              <View style={styles.filterRow}>
                <FilterRow
                  options={groupOptions}
                  selected={values.groupId === null ? (requireGroup ? [] : [NO_GROUP]) : [values.groupId]}
                  onToggle={(id) => onChange({ groupId: id === NO_GROUP ? null : id })}
                  accessibilityPrefix="Hosted by"
                />
              </View>
              {requireGroup && values.groupId === null ? (
                <AppText variant="meta" color={colors.danger}>
                  Choose one of your groups before posting.
                </AppText>
              ) : null}
              <AppText variant="meta">
                A private group’s event follows that group’s access rules: only its members can see or sign up for it.
                A public group’s event is discoverable by everyone the group’s audience accepts.
              </AppText>
            </>
          )}

          <Field
            label="Participant limit"
            value={values.maxParticipants}
            onChangeText={(maxParticipants) => onChange({ maxParticipants })}
            placeholder="Leave blank for no limit"
            keyboardType="number-pad"
            editable={!disabled}
            helper={`A whole number up to ${MAX_EVENT_PARTICIPANTS}, or blank.`}
          />
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
  filterRow: {
    // The chip rail runs to the screen edge so it reads as scrollable.
    marginRight: -layout.screenPadding,
  },
  timeRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  timeField: {
    flex: 1,
  },
  anchorActions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  anchorButton: {
    flex: 1,
  },
});
