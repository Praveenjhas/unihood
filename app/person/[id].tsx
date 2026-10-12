import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import {
  AppText,
  Avatar,
  Card,
  EmptyState,
  ErrorState,
  ListDivider,
  ListRow,
  ListSkeleton,
  Notice,
  Screen,
  ScreenHeader,
  SectionHeading,
  Tag,
} from '../../src/components';
import { interestLabelFor } from '../../src/data';
import { useAuth } from '../../src/features/auth';
import {
  PersonNotAvailableError,
  fetchPerson,
  interestsMatchedFirst,
  sharedInterestsOf,
} from '../../src/features/people';
import { describeError, formatApproximateDistance, pluralize, routes, useQuery } from '../../src/lib';
import { spacing } from '../../src/theme';

/**
 * A member's public profile — the destination of every tap in People.
 *
 * Everything here comes from `get_public_profile`, which returns a deliberately
 * narrow projection: no email, no coordinates, and a distance only when both
 * sides consented and both hold a recent fix. A missing distance is therefore a
 * privacy outcome, not an error, and is worded that way.
 *
 * "This member is not available" and "the request failed" are different answers:
 * the first will not change if you try again, so it gets an explanation and a way
 * back rather than a retry button that can never succeed.
 */
export default function PersonDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useAuth();
  const personId = id ?? '';

  const personQuery = useQuery(() => fetchPerson(personId), {
    queryKey: `person|${personId}`,
    enabled: personId.length > 0,
  });

  // Deep links can open a detail route with nothing behind it, so the back
  // control falls back to the tab instead of popping an empty stack.
  const goBack = () => (router.canGoBack() ? router.back() : router.replace(routes.people));

  if (personQuery.status === 'loading') {
    return (
      <Screen>
        <ScreenHeader title="Loading profile" onBack={goBack} />
        <View style={styles.state}>
          <ListSkeleton rows={2} />
        </View>
      </Screen>
    );
  }

  const unavailable =
    personQuery.status === 'error' ? personQuery.error instanceof PersonNotAvailableError : false;

  if (unavailable) {
    return (
      <Screen>
        <ScreenHeader title="Profile not available" onBack={goBack} />
        <EmptyState
          icon="lock-closed-outline"
          title="This profile is not shared"
          message="They may have turned discovery off, or the id in this link no longer exists. People search still shows everyone who is visible."
          action={{ label: 'Back to People', onPress: goBack }}
        />
      </Screen>
    );
  }

  if (personQuery.status === 'error' || !personQuery.data) {
    return (
      <Screen>
        <ScreenHeader title="Profile not available" onBack={goBack} />
        <ErrorState
          message="We couldn't open that profile."
          detail={describeError(personQuery.error)}
          onRetry={personQuery.retry}
        />
      </Screen>
    );
  }

  const person = personQuery.data;
  const viewerInterestIds = profile?.interestIds ?? [];
  // The API's own answer, which is the signal the list was ranked by; the viewer's
  // cached interests are only a fallback inside the helper.
  const sharedInterests = sharedInterestsOf(person, viewerInterestIds);
  const distance = formatApproximateDistance(person.distanceMeters);
  const meta = [person.locationLabel, distance].filter(Boolean).join(' · ');

  return (
    <Screen contentStyle={styles.content}>
      <ScreenHeader
        eyebrow="Member profile"
        hero={<Avatar name={person.displayName} size="lg" />}
        title={person.displayName}
        subtitle={meta || 'No area or distance shared with you.'}
        onBack={goBack}
      />

      {person.sharedInterestCount > 0 ? (
        <Notice
          tone="info"
          message={`You have ${pluralize(person.sharedInterestCount, 'interest')} in common.`}
          detail="Shared interests are what People search ranks by, so this is probably why you are looking at each other."
        />
      ) : null}

      {person.bio ? (
        <View style={styles.section}>
          <SectionHeading title="About" />
          <Card>
            <AppText variant="bodySecondary">{person.bio}</AppText>
          </Card>
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionHeading title="Interests" count={person.interestIds.length} />
        {person.interestIds.length > 0 ? (
          <View style={styles.tags}>
            {interestsMatchedFirst(person, sharedInterests).map((interestId) => (
              <Tag
                key={interestId}
                label={interestLabelFor(interestId)}
                // Tinted when you share it: the tag row doubles as the answer
                // to "why am I seeing this person?".
                variant={sharedInterests.has(interestId) ? 'soft' : 'neutral'}
              />
            ))}
          </View>
        ) : (
          <AppText variant="meta">No interests picked yet.</AppText>
        )}
      </View>

      <View style={styles.section}>
        <SectionHeading title="Details" />
        <Card style={styles.rowCard}>
          <ListRow title="Area" meta={person.locationLabel ?? 'Not shared'} />
          <ListDivider />
          <ListRow
            title="Distance"
            meta={distance ?? 'Not shared — both of you have to opt in to nearby discovery'}
          />
        </Card>
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
  tags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
  },
  rowCard: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
});
