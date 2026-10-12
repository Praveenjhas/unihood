import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AppText,
  Button,
  EmptyState,
  ErrorState,
  FilterRow,
  ListSkeleton,
  Notice,
  Screen,
  ScreenHeader,
  SearchField,
  SectionHeading,
  SegmentedControl,
  type IoniconName,
  type SegmentedControlOption,
} from '../../src/components';
import { useInterestCatalog } from '../../src/data';
import { useAuth } from '../../src/features/auth';
import { PersonCard, fetchPeoplePage, type DiscoveryOptions } from '../../src/features/people';
import {
  DEFAULT_RADIUS_METERS,
  MAX_RADIUS_METERS,
  RADIUS_OPTIONS,
  describeError,
  formatRadiusLabel,
  hasApiErrorCode,
  routes,
  useDebouncedValue,
  useQuery,
  useRefreshOnFocus,
  type AsyncQueryResult,
} from '../../src/lib';
import { layout, spacing } from '../../src/theme';
import type { PeopleSearchField, Person } from '../../src/types';

/**
 * The two things the words in the search box can mean.
 *
 * People is a nearby search with two segments rather than two modes: geography is
 * always applied, and the switch only decides what a search term is compared
 * against. "Everyone, everywhere" is gone on purpose - this is an app for meeting
 * the people around you - so a member with nothing saved gets the way to save an
 * area instead of a list of strangers.
 */
const SEARCH_FIELD_OPTIONS: readonly SegmentedControlOption<PeopleSearchField>[] = [
  { id: 'name', label: 'Name' },
  { id: 'skill', label: 'Skill' },
];

const SEARCH_FIELD_HINTS: Record<PeopleSearchField, string> = {
  name: 'People whose name matches, closest first — shared interests still come first.',
  skill: 'People who picked the interest you type — pick a suggestion, or type any interest in the catalogue.',
};

/**
 * The largest radius the server honours, used as the escape hatch in the empty
 * state: when nothing turns up, the first thing worth trying is a wider circle.
 */
const WIDEST_RADIUS_METERS = MAX_RADIUS_METERS;

/** The id of the one chip that switches the interest *match* on. */
const MATCH_INTEREST_ID = 'matched';

/**
 * A single chip meaning "only members who share an interest with me".
 *
 * Sent to the server as `matched=true`, so the comparison runs against the
 * member's *stored* interests - this screen never sends its own list, which is what
 * makes the filter a server rule rather than a client convention.
 */
const MATCH_OPTIONS: readonly { id: string; label: string }[] = [
  { id: MATCH_INTEREST_ID, label: 'Matched to my interests' },
];

/**
 * A location-shaped refusal, as something the member can act on.
 *
 * The server refuses a nearby search for exactly two reasons - no saved area, or
 * nearby discovery switched off - and each has its own next step. Turning the code
 * into a sentence and a button is the difference between a dead end and one tap,
 * and it is why the list does not fall back to "everyone on Unihood": that answer
 * would be a different product, quietly, in the one moment the member is most
 * likely to be confused.
 */
interface PeopleBlocker {
  icon: IoniconName;
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
}

/** Maps a failed discovery request onto the fix it needs, or `null` if there is none. */
function blockerForError(error: unknown, openProfile: () => void): PeopleBlocker | null {
  if (hasApiErrorCode(error, 'nearby_disabled')) {
    return {
      icon: 'location-outline',
      title: 'Nearby discovery is off',
      message:
        'People results are measured from your own nearby area. Turn nearby discovery on in your profile and save one coarse area — then this list fills in.',
      actionLabel: 'Open profile',
      onAction: openProfile,
    };
  }

  if (hasApiErrorCode(error, 'location_required')) {
    return {
      icon: 'navigate-outline',
      title: 'Set your nearby area',
      message:
        'People search only shows members close enough to actually meet, so it starts from one saved area of yours. It takes a tap, is rounded to about 11 m, and stays until you change it.',
      actionLabel: 'Add my area',
      onAction: openProfile,
    };
  }

  return null;
}

/** What to say when a query succeeds but comes back empty. */
interface PeopleEmptyState {
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
}

interface PeopleResultsProps {
  options: DiscoveryOptions;
  /**
   * The first page, owned by the screen rather than by this list: the screen is what
   * renders the refresh control, and a query created in here could not be reached by
   * it. The list still owns its own pagination below.
   */
  result: AsyncQueryResult<Awaited<ReturnType<typeof fetchPeoplePage>>>;
  /** The viewer's own interests, so shared tags can be lifted to the front. */
  viewerInterestIds: readonly string[];
  emptyState: PeopleEmptyState;
  /**
   * Set when the request failed for a location reason, so the list shows the fix
   * instead of a retry that cannot succeed until the member acts.
   */
  blocker: PeopleBlocker | null;
  onOpenPerson: (id: string) => void;
}

/**
 * The result list, including its own pagination.
 *
 * Mounted with `key={queryKey}`, so a new search remounts it and the loaded
 * pages cannot leak from the previous one — which is why there is no
 * reset-the-state effect anywhere below.
 */
function PeopleResults({ options, result, viewerInterestIds, emptyState, blocker, onOpenPerson }: PeopleResultsProps) {
  const [more, setMore] = useState<Person[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const people = [...(result.data?.people ?? []), ...more];
  // The first page is the authority until a second one has been loaded.
  const offsetForNextPage = nextOffset ?? result.data?.nextOffset ?? null;
  const hasMore = offsetForNextPage !== null;

  const loadMore = () => {
    if (offsetForNextPage === null || isLoadingMore) return;
    setIsLoadingMore(true);
    setMoreError(null);

    void fetchPeoplePage({ ...options, offset: offsetForNextPage })
      .then((page) => {
        setMore((current) => [...current, ...page.people]);
        setNextOffset(page.nextOffset);
      })
      .catch((caught) => setMoreError(describeError(caught)))
      .finally(() => setIsLoadingMore(false));
  };

  if (result.status === 'loading') return <ListSkeleton rows={4} />;

  if (result.status === 'error') {
    if (blocker) {
      return (
        <EmptyState
          icon={blocker.icon}
          title={blocker.title}
          message={blocker.message}
          action={{ label: blocker.actionLabel, onPress: blocker.onAction }}
        />
      );
    }

    return (
      <ErrorState
        message="We couldn't load people just now."
        detail={describeError(result.error)}
        onRetry={result.retry}
      />
    );
  }

  return (
    <View style={styles.results}>
      <SectionHeading title="People" count={people.length} />

      {people.length === 0 ? (
        <EmptyState
          icon="people-outline"
          title={emptyState.title}
          message={emptyState.message}
          action={{ label: emptyState.actionLabel, onPress: emptyState.onAction }}
        />
      ) : (
        <>
          <View style={styles.list}>
            {people.map((person) => (
              <PersonCard
                key={person.id}
                person={person}
                viewerInterestIds={viewerInterestIds}
                onPress={() => onOpenPerson(person.id)}
              />
            ))}
          </View>

          {moreError ? (
            <Notice tone="danger" message={moreError} action={{ label: 'Try again', onPress: loadMore }} />
          ) : null}

          {hasMore && !moreError ? (
            <Button
              label="Load more"
              icon="chevron-down"
              variant="secondary"
              fullWidth
              loading={isLoadingMore}
              onPress={loadMore}
              accessibilityHint="Appends the next page of results"
            />
          ) : null}
        </>
      )}
    </View>
  );
}

/**
 * People — the discovery home of the app.
 *
 * Nearby is not a mode here, it is the premise: every result is measured from the
 * member's own saved area, and the server refuses the request outright when there
 * is no area to measure from. That refusal is shown as the fix it needs (see
 * `blockerForError`) rather than as an empty list, because an empty list with no
 * explanation reads like a bug.
 *
 * The one switch left is what the words in the box mean - a name or a skill - sent
 * to the server as `by`, so the two questions never blend into one answer. Typing
 * only re-queries once it pauses, so the skeleton does not flash on every keystroke.
 */
export default function PeopleScreen() {
  const router = useRouter();
  const { profile, isConfigured, refreshProfile } = useAuth();
  const { options: interestOptions } = useInterestCatalog(isConfigured);

  const [query, setQuery] = useState('');
  const [searchField, setSearchField] = useState<PeopleSearchField>('name');
  const [interestIds, setInterestIds] = useState<string[]>([]);
  const [matchSharedInterests, setMatchSharedInterests] = useState(false);
  const [radiusMeters, setRadiusMeters] = useState(DEFAULT_RADIUS_METERS);

  const debouncedQuery = useDebouncedValue(query);
  const sortedInterests = [...interestIds].sort().join(',');
  const queryKey = `people|${searchField}|${debouncedQuery.trim().toLowerCase()}|${sortedInterests}|${
    matchSharedInterests ? 'matched' : 'any'
  }|${radiusMeters}`;

  /**
   * The first page lives here, not in the list below, because the refresh control
   * belongs to this `Screen`: "pull to refresh" has to re-run the query that painted
   * the results, and a query owned by a child cannot be reached from its parent
   * without a ref or a context that would say less than this.
   */
  const discoveryOptions: DiscoveryOptions = {
    searchField,
    query: debouncedQuery,
    interestIds,
    matchSharedInterests,
    radiusMeters,
  };
  const results = useQuery(() => fetchPeoplePage(discoveryOptions), { queryKey });
  const { refresh: refreshResults } = results;

  // The profile is refreshed alongside the list: results are ranked by shared
  // interests and every distance is measured from the member's own area, so a
  // profile change is a change to this screen's answer.
  const refreshAll = useCallback(() => {
    refreshProfile();
    refreshResults();
  }, [refreshProfile, refreshResults]);

  // Coming back from a profile (a person page, the editor) must not show a list that
  // predates the change.
  useRefreshOnFocus(refreshAll);

  const toggleInterest = (id: string) => {
    setInterestIds((current) =>
      current.includes(id) ? current.filter((interest) => interest !== id) : [...current, id],
    );
  };

  /**
   * The Skill segment's suggestions, taken from the *catalogue*.
   *
   * The member is looking for a word here rather than for a person, and the API
   * matches exactly these labels and slugs - so what appears under the box is what
   * the search can answer with. The whole catalogue is the source, never the
   * member's own interests, because a skill nobody around them has picked yet is
   * still a legitimate question (and the API is what filters by it).
   */
  const skillSuggestions = useMemo(() => {
    if (searchField !== 'skill') return [];
    const term = query.trim().toLowerCase();
    if (term.length === 0) return [];

    return interestOptions
      .filter((option) => !interestIds.includes(option.id))
      .filter((option) => option.label.toLowerCase().includes(term) || option.id.includes(term))
      .slice(0, 6);
  }, [searchField, query, interestOptions, interestIds]);

  /**
   * Picking a suggestion is a filter, not more typing: "show me the people who
   * picked this" is exactly what the interest filter asks the API for, and the chip
   * rail below then shows the choice in force. The box is emptied in the same tap so
   * the two controls can never disagree about what is being searched.
   */
  const selectSkill = (id: string) => {
    setInterestIds([id]);
    setQuery('');
  };

  const clearFilters = () => {
    setQuery('');
    setInterestIds([]);
    setMatchSharedInterests(false);
  };

  /**
   * A search that turned up nothing has two likely causes - a narrower circle than
   * the campus, or a filter doing its job - so the empty state offers whichever
   * undo is more probable. Widening comes first while a narrower radius is in
   * force: it changes nothing the member deliberately set.
   */
  const emptyState: PeopleEmptyState = {
    title: searchField === 'name' ? 'No one by that name' : 'No one with that skill yet',
    message:
      searchField === 'name'
        ? `Nobody within ${formatRadiusLabel(radiusMeters)} is discoverable under that name. Check the spelling, widen the circle, or try searching a skill instead.`
        : `Nobody within ${formatRadiusLabel(radiusMeters)} has picked an interest matching that. Try a broader word, widen the circle, or switch to Name.`,
    actionLabel: radiusMeters < WIDEST_RADIUS_METERS ? 'Widen the circle' : 'Clear filters',
    onAction: radiusMeters < WIDEST_RADIUS_METERS ? () => setRadiusMeters(WIDEST_RADIUS_METERS) : clearFilters,
  };

  // With the match filter on, an empty list almost always means "nobody around me
  // has picked an interest of mine yet", so the action drops the match - the change
  // the member actually wants to make.
  const viewEmptyState: PeopleEmptyState = matchSharedInterests
    ? {
        title: 'No shared interests yet',
        message:
          'Nobody nearby has picked one of your interests. Showing every interest again will include the members you have nothing in common with yet.',
        actionLabel: 'Show every interest',
        onAction: () => setMatchSharedInterests(false),
      }
    : emptyState;

  // Only a failed request can tell us the search has nowhere to run from, and the
  // two codes it can fail with need different answers - so the refusal is read here
  // and handed to the list as a plan, not as an error string.
  const blocker =
    results.status === 'error' ? blockerForError(results.error, () => router.push(routes.profile)) : null;

  return (
    <Screen onRefresh={refreshAll} refreshing={results.isRefreshing}>
      <ScreenHeader
        eyebrow={profile?.locationLabel ?? 'Nearby'}
        title="Who's around today?"
        subtitle="Search by name or by skill — every result is close enough to actually meet up."
      />

      <View style={styles.controls}>
        <SegmentedControl
          options={SEARCH_FIELD_OPTIONS}
          value={searchField}
          onChange={(next) => setSearchField(next)}
          accessibilityLabel="Search people by"
        />
        <AppText variant="meta">{SEARCH_FIELD_HINTS[searchField]}</AppText>

        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder={searchField === 'name' ? 'Search a name' : 'Search a skill or interest'}
          accessibilityLabel={
            searchField === 'name' ? 'Search people by display name' : 'Search people by skill or interest'
          }
        />

        {skillSuggestions.length > 0 ? (
          <View style={styles.filterRow}>
            <FilterRow
              options={skillSuggestions}
              selected={[]}
              onToggle={selectSkill}
              accessibilityPrefix="Suggested interest"
            />
          </View>
        ) : null}

        <View style={styles.filterRow}>
          <FilterRow
            options={RADIUS_OPTIONS}
            selected={[String(radiusMeters)]}
            onToggle={(id) => setRadiusMeters(Number(id))}
            accessibilityPrefix="Radius"
          />
        </View>
        <AppText variant="meta">
          {profile?.locationLabel
            ? `Measured from your saved area near ${profile.locationLabel}.`
            : 'Measured from your saved area.'}
        </AppText>

        <View style={styles.filterRow}>
          <FilterRow
            options={interestOptions}
            selected={interestIds}
            onToggle={toggleInterest}
            accessibilityPrefix="Interest"
          />
        </View>

        {(profile?.interestIds?.length ?? 0) > 0 ? (
          <View style={styles.filterRow}>
            <FilterRow
              options={MATCH_OPTIONS}
              selected={matchSharedInterests ? [MATCH_INTEREST_ID] : []}
              onToggle={() => setMatchSharedInterests((current) => !current)}
              accessibilityPrefix="Match"
            />
          </View>
        ) : null}
      </View>

      <PeopleResults
        key={queryKey}
        options={discoveryOptions}
        result={results}
        viewerInterestIds={profile?.interestIds ?? []}
        emptyState={viewEmptyState}
        blocker={blocker}
        onOpenPerson={(id) => router.push(routes.person(id))}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  controls: {
    marginTop: spacing.xl,
    gap: spacing.md,
  },
  filterRow: {
    // The chip rail runs to the screen edge so it reads as scrollable.
    marginRight: -layout.screenPadding,
  },
  results: {
    marginTop: spacing.xxl,
    gap: spacing.md,
  },
  list: {
    gap: spacing.md,
  },
});
