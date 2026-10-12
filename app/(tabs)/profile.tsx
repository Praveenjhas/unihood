import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AppText,
  Avatar,
  Button,
  Card,
  ErrorState,
  IconButton,
  ListDivider,
  ListRow,
  ListSkeleton,
  Notice,
  Screen,
  ScreenHeader,
  SectionHeading,
  TagRow,
} from '../../src/components';
import { groupCategoryLabel, interestLabelFor } from '../../src/data';
import { useAuth } from '../../src/features/auth';
import { fetchEventsPage } from '../../src/features/events';
import { fetchGroupsPage } from '../../src/features/groups';
import { LocationSharingCard } from '../../src/features/location';
import { describeError, formatInstantWhen, formatMemberCount, routes, useQuery, useRefreshOnFocus } from '../../src/lib';
import { colors, spacing } from '../../src/theme';

/** One figure in the profile stats strip. */
function StatBlock({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.stat}>
      <AppText variant="numeral">{String(value)}</AppText>
      <AppText variant="label" align="center">
        {label}
      </AppText>
    </View>
  );
}

/**
 * Profile — the member's own page, and where every account-level action lives.
 *
 * The row itself comes from `useAuth()` (the provider is the only writer of the
 * profile row), while the memberships and RSVPs below come from the API - so the
 * counts here always agree with the Groups and Events tabs.
 *
 * Storing a location is the most consequential thing in the app, so it gets a
 * whole section with `LocationSharingCard` rather than a switch tucked into a
 * list: the card states the precision, the lifetime and the way to undo it
 * before the OS permission dialog is ever reached.
 */
export default function ProfileScreen() {
  const router = useRouter();
  const { profile, profileError, isProfileLoading, refreshProfile, signOut } = useAuth();
  const [signOutError, setSignOutError] = useState<string | null>(null);

  /**
   * The member's active group memberships, read from the API.
   *
   * Groups are database-backed, so the profile asks the server rather than
   * filtering a local list: the count here and the Groups tab can never disagree.
   */
  const myGroupsQuery = useQuery(() => fetchGroupsPage({ mode: 'mine', limit: 50 }), { queryKey: 'groups|mine|profile' });
  const myGroups = myGroupsQuery.data?.groups ?? [];

  /**
   * The member's own RSVPs, read from the API.
   *
   * The list is "upcoming events I am actively going to", so a cancelled event (or
   * one whose group the member has left) drops out of it by itself - the client is
   * not filtering anything, and the count here cannot disagree with the Going tab.
   *
   * Declared before the early return below, because a hook may not be called
   * conditionally.
   */
  const goingQuery = useQuery(() => fetchEventsPage({ mode: 'going', limit: 5 }), {
    queryKey: 'events|going|profile',
  });
  const goingEvents = goingQuery.data?.events ?? [];

  /**
   * Everything on this screen, re-read together: the profile row from the provider
   * (which owns it) and the two lists from the API.
   *
   * `useQuery` hands back a new result object on every render but a *stable*
   * `refresh` function, so the two are taken out of their wrappers first: that is
   * what keeps this callback - and the focus effect keyed on it - from being
   * re-created on every render, which would re-run all three loaders in a loop.
   */
  const { refresh: refreshGroups } = myGroupsQuery;
  const { refresh: refreshGoing } = goingQuery;

  const refreshAll = useCallback(() => {
    refreshProfile();
    refreshGroups();
    refreshGoing();
  }, [refreshProfile, refreshGroups, refreshGoing]);

  // Coming back from a group, an event or the editor: the counts and the lists must
  // not still be the ones from before the change.
  useRefreshOnFocus(refreshAll);

  // The queries carry their own spinner flags; the profile read reports through the
  // provider's loading state, which is true exactly while the fresh request is out.
  const isRefreshing = myGroupsQuery.isRefreshing || goingQuery.isRefreshing || isProfileLoading;

  const handleSignOut = () => {
    setSignOutError(null);
    void signOut().catch((caught) => setSignOutError(describeError(caught)));
  };

  // The guard only lets a settled, completed profile reach this screen, so this
  // branch is a safety net rather than a normal state.
  if (!profile) {
    return (
      <Screen>
        <ScreenHeader eyebrow="Your profile" title="Loading your profile" />
        <View style={styles.state}>
          {profileError ? (
            <ErrorState message={describeError(profileError)} onRetry={refreshProfile} />
          ) : (
            <ListSkeleton rows={2} />
          )}
          {signOutError ? <Notice tone="danger" message={signOutError} /> : null}
          <Button label="Sign out" variant="ghost" fullWidth onPress={handleSignOut} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      contentStyle={styles.content}
      onRefresh={refreshAll}
      refreshing={isRefreshing}
      footer={
        <>
          <View style={styles.buttonRow}>
            <Button
              label="New group"
              icon="add"
              variant="secondary"
              style={styles.buttonHalf}
              onPress={() => router.push(routes.createGroup)}
            />
            <Button
              label="New event"
              icon="add"
              variant="secondary"
              style={styles.buttonHalf}
              onPress={() => router.push(routes.createEvent)}
            />
          </View>
          <Button
            label="Sign out"
            icon="log-out-outline"
            variant="danger"
            fullWidth
            onPress={handleSignOut}
            accessibilityHint="Signs out on this device and returns to the welcome screen"
          />
        </>
      }
    >
      <ScreenHeader
        eyebrow="Your profile"
        title={profile.displayName}
        hero={<Avatar name={profile.displayName} size="lg" />}
        subtitle={profile.locationLabel ?? 'No area set yet'}
        trailing={
          <IconButton
            name="pencil"
            onPress={() => router.push(routes.editProfile)}
            accessibilityLabel="Edit profile"
          />
        }
      />

      {signOutError ? <Notice tone="danger" message={signOutError} /> : null}

      <Card style={styles.card}>
        <ListRow title="Area" meta={profile.locationLabel ?? 'Not set'} />
        <ListDivider />
        {/* The number is the account's sign-in name. This is the only screen that
            may show it: a public profile never does. */}
        <ListRow title="Phone number" meta={profile.phone ?? 'Not available'} />
        <ListDivider />
        <ListRow title="Discovery" meta={profile.isDiscoverable ? 'You can be found by name' : 'Hidden from People'} />
      </Card>

      <Card style={styles.card}>
        <View style={styles.statsRow}>
          <StatBlock value={myGroups.length} label="Groups" />
          <View style={styles.statDivider} />
          <StatBlock value={goingEvents.length} label="Going" />
          <View style={styles.statDivider} />
          <StatBlock value={profile.interestIds.length} label="Interests" />
        </View>
      </Card>

      <View style={styles.section}>
        <SectionHeading title="About" />
        <Card>
          <AppText variant={profile.bio ? 'bodySecondary' : 'meta'}>
            {profile.bio ??
              'Nothing here yet. A line or two about what you are into gives people somewhere to start.'}
          </AppText>
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeading title="Interests" count={profile.interestIds.length} />
        {profile.interestIds.length > 0 ? (
          <TagRow labels={profile.interestIds.map((interestId) => interestLabelFor(interestId))} variant="soft" />
        ) : (
          <AppText variant="meta">No interests picked yet — they are what People search matches on.</AppText>
        )}
      </View>

      <View style={styles.section}>
        <SectionHeading title="Your nearby area" />
        <LocationSharingCard
          enabled={profile.nearbyDiscoveryEnabled}
          initialUpdatedAt={profile.locationUpdatedAt}
          onChanged={refreshProfile}
        />
        {profile.nearbyDiscoveryEnabled ? null : (
          <Notice
            tone="info"
            message="Nearby discovery is off."
            detail="Turn it on in the profile editor, then save one coarse area to appear in nearby results."
            action={{ label: 'Edit profile', onPress: () => router.push(routes.editProfile) }}
          />
        )}
      </View>

      {myGroupsQuery.status === 'error' ? (
        <Notice
          tone="danger"
          message="We couldn't load your groups just now."
          action={{ label: 'Try again', onPress: myGroupsQuery.retry }}
        />
      ) : null}

      {myGroups.length > 0 ? (
        <View style={styles.section}>
          <SectionHeading
            title="Your groups"
            count={myGroups.length}
            action={{ label: 'Find more', onPress: () => router.push(routes.groups) }}
          />
          <Card style={styles.rowCard}>
            {myGroups.map((group, index) => (
              <View key={group.id}>
                {index > 0 ? <ListDivider /> : null}
                <ListRow
                  title={group.name}
                  meta={`${groupCategoryLabel(group.category)} · ${formatMemberCount(group.memberCount)}`}
                  leading={<Avatar name={group.name} size="sm" />}
                  accessibilityLabel={`Open ${group.name}`}
                  onPress={() => router.push(routes.group(group.id))}
                />
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {goingQuery.status === 'error' ? (
        <Notice
          tone="danger"
          message="We couldn't load the events you're going to just now."
          action={{ label: 'Try again', onPress: goingQuery.retry }}
        />
      ) : null}

      {goingEvents.length > 0 ? (
        <View style={styles.section}>
          <SectionHeading
            title="Going to"
            count={goingEvents.length}
            action={{ label: 'Browse events', onPress: () => router.push(routes.events) }}
          />
          <Card style={styles.rowCard}>
            {goingEvents.map((event, index) => (
              <View key={event.id}>
                {index > 0 ? <ListDivider /> : null}
                <ListRow
                  title={event.title}
                  meta={[formatInstantWhen(event.startAt, event.endAt), event.locationLabel ?? 'Venue to be confirmed']
                    .filter(Boolean)
                    .join(' · ')}
                  leading={<Avatar name={event.title} size="sm" />}
                  accessibilityLabel={`Open ${event.title}`}
                  onPress={() => router.push(routes.event(event.id))}
                />
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionHeading title="Account" />
        <Card style={styles.rowCard}>
          <ListRow
            title="Change password"
            meta="Your number stays the same"
            accessibilityLabel="Change password"
            onPress={() => router.push(routes.changePassword)}
          />
          <ListRow
            title="Delete account"
            meta="Closes your account, and everything you made"
            accessibilityLabel="Delete account"
            onPress={() => router.push(routes.deleteAccount)}
          />
        </Card>
      </View>

      <View style={styles.section}>
        <Button
          label="Edit profile"
          icon="pencil"
          variant="primary"
          fullWidth
          onPress={() => router.push(routes.editProfile)}
        />
        <AppText variant="meta" align="center">
          {profile.phone
            ? `Signed in with ${profile.phone}.`
            : profile.email
              ? `Signed in as ${profile.email}.`
              : 'Signed in.'}{' '}
          Your profile lives in your Unihood account, so it follows you to another device.
        </AppText>
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
    gap: spacing.md,
  },
  card: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  rowCard: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  stat: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xxs,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: colors.border,
  },
  section: {
    gap: spacing.md,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  buttonHalf: {
    flex: 1,
  },
});

