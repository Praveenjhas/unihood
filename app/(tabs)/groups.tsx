import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AppText,
  Button,
  EmptyState,
  ErrorState,
  FilterRow,
  IconButton,
  ListSkeleton,
  Notice,
  Screen,
  ScreenHeader,
  SearchField,
  SectionHeading,
  SegmentedControl,
  type SegmentedControlOption,
} from '../../src/components';
import { GROUP_CATEGORIES, useInterestCatalog } from '../../src/data';
import { useAuth } from '../../src/features/auth';
import { GroupCard, fetchGroupsPage, type GroupListMode, type GroupQueryOptions } from '../../src/features/groups';
import {
  DEFAULT_RADIUS_METERS,
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
import type { Group, GroupCategoryId } from '../../src/types';

/**
 * The two listings the switch offers.
 *
 * "All groups" is deliberately not a third segment any more (Phase 6). A segmented
 * control is for the question the screen is built around, and that question is
 * "what is near me and matched to me"; the whole directory is still reachable - as
 * an explicit, labelled state with a way back (see the banner below) - which is
 * what keeps it an escape hatch rather than an equal-looking tab.
 */
const VIEW_OPTIONS: readonly SegmentedControlOption<GroupListMode>[] = [
  { id: 'nearby', label: 'Nearby' },
  { id: 'mine', label: 'My groups' },
];

const MODE_HINTS: Record<GroupListMode, string> = {
  nearby: 'Groups anchored within your radius — those sharing one of your interests first, then the closest.',
  all: 'Every group you are eligible to discover, in name order.',
  mine: 'Groups you are an active member of, wherever they are now.',
};

/** The id of the one chip that switches the interest *match* on. */
const MATCH_INTEREST_ID = 'matched';

/**
 * A single chip that means "only groups whose interest I share".
 *
 * A filter row rather than a switch so it reads in the same language as the
 * interest chips beside it - and because it is a filter on the *result*, not a
 * setting.
 */
const MATCH_OPTIONS: readonly { id: string; label: string }[] = [
  { id: MATCH_INTEREST_ID, label: 'Matched to my interests' },
];

/** What to say when a listing succeeds but comes back empty. */
interface GroupsEmptyState {
  icon: 'grid-outline' | 'compass-outline' | 'people-outline';
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
}

interface GroupResultsProps {
  options: GroupQueryOptions;
  /**
   * The first page, owned by the screen rather than by this list: the screen is what
   * renders the refresh control, and a query created in here could not be reached by
   * it. The list still owns its own pagination below.
   */
  result: AsyncQueryResult<Awaited<ReturnType<typeof fetchGroupsPage>>>;
  emptyState: GroupsEmptyState;
  /** The viewer's own interests, so a matched interest can be tinted on the card. */
  viewerInterestIds: readonly string[];
  /** Offered when nearby discovery cannot run, so the member is never stuck. */
  onBrowseAll: () => void;
  onOpenGroup: (id: string) => void;
}

/**
 * The result list, including its own pagination.
 *
 * Mounted with `key={queryKey}`, so a new listing remounts it and the pages loaded
 * for the previous one cannot leak into the next - which is why there is no
 * reset-the-state effect below.
 */
function GroupResults({
  options,
  result,
  emptyState,
  viewerInterestIds,
  onBrowseAll,
  onOpenGroup,
}: GroupResultsProps) {
  const [more, setMore] = useState<Group[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const groups = [...(result.data?.groups ?? []), ...more];
  // The first page is the authority until a second one has been loaded.
  const offsetForNextPage = nextOffset ?? result.data?.nextOffset ?? null;
  const hasMore = offsetForNextPage !== null;

  const loadMore = () => {
    if (offsetForNextPage === null || isLoadingMore) return;
    setIsLoadingMore(true);
    setMoreError(null);

    void fetchGroupsPage({ ...options, offset: offsetForNextPage })
      .then((page) => {
        setMore((current) => [...current, ...page.groups]);
        setNextOffset(page.nextOffset);
      })
      .catch((caught) => setMoreError(describeError(caught)))
      .finally(() => setIsLoadingMore(false));
  };

  if (result.status === 'loading') return <ListSkeleton rows={4} />;

  if (result.status === 'error') {
    // Nearby discovery needs a stored fix; that is a state to explain and route
    // around, not a failure to retry. Every other error keeps the retry button.
    if (hasApiErrorCode(result.error, 'location_required')) {
      return (
        <EmptyState
          icon="navigate-outline"
          title="Nearby needs a location"
          message="Unihood can only sort groups by distance when you have shared a recent location from your profile. Your groups are all still here."
          action={{ label: 'Browse all groups', onPress: onBrowseAll }}
        />
      );
    }

    return (
      <ErrorState
        message="We couldn't load groups just now."
        onRetry={result.retry}
        detail={result.error ? describeError(result.error) : undefined}
      />
    );
  }

  if (groups.length === 0) return <EmptyState {...emptyState} />;

  return (
    <View style={styles.list}>
      {groups.map((group) => (
        <GroupCard
          key={group.id}
          group={group}
          viewerInterestIds={viewerInterestIds}
          onPress={() => onOpenGroup(group.id)}
        />
      ))}

      {moreError ? <AppText variant="meta">{moreError}</AppText> : null}

      {hasMore ? (
        <Button
          label={isLoadingMore ? 'Loading' : 'Load more'}
          variant="ghost"
          fullWidth
          loading={isLoadingMore}
          onPress={loadMore}
        />
      ) : null}
    </View>
  );
}

const MODE_TITLES: Record<GroupListMode, string> = {
  nearby: 'Nearby groups',
  all: 'All groups',
  mine: 'Your groups',
};

/**
 * Groups — the directory, served by the API, now leaning on interest as much as
 * distance.
 *
 * Two listings share one screen because they are two ways of asking the same
 * question: what is near me, and what am I already part of. The whole directory is
 * still reachable - it is the escape hatch offered when nearby cannot run or comes
 * back empty - but it appears as a named state with a way back rather than as a
 * third tab, so "Nearby" stays the question the screen asks. The search, category
 * and interest controls belong to the two discovery listings, so they are hidden in
 * "My groups" rather than silently ignored.
 *
 * Every group here is a row in MySQL: joining, requesting and leaving all go
 * through the server, and the card reflects what came back rather than what the tap
 * hoped for.
 */
export default function GroupsScreen() {
  const router = useRouter();
  const { profile, isConfigured, refreshProfile } = useAuth();
  const { options: interestOptions } = useInterestCatalog(isConfigured);

  const [mode, setMode] = useState<GroupListMode>('nearby');
  const [query, setQuery] = useState('');
  const [categories, setCategories] = useState<GroupCategoryId[]>([]);
  const [interestIds, setInterestIds] = useState<string[]>([]);
  const [matchMyInterests, setMatchMyInterests] = useState(false);
  const [radiusMeters, setRadiusMeters] = useState(DEFAULT_RADIUS_METERS);

  const debouncedQuery = useDebouncedValue(query);

  // Only the viewer's *own* interests are offered, because the chips are a filter
  // on the group's interest and the match chip asks the server to compare it with
  // this same list: offering the whole catalogue would invite filters whose answer
  // the server cannot verify. Memoised so the chip list's identity is stable.
  const viewerInterestIds = useMemo(() => profile?.interestIds ?? [], [profile?.interestIds]);
  const ownInterestOptions = useMemo(
    () =>
      interestOptions
        .filter((option) => viewerInterestIds.includes(option.id))
        .map((option) => ({ id: option.id, label: option.label })),
    [interestOptions, viewerInterestIds],
  );

  const queryKey = `groups|${mode}|${debouncedQuery.trim().toLowerCase()}|${[...categories].sort().join(',')}|${[
    ...interestIds,
  ]
    .sort()
    .join(',')}|${matchMyInterests ? 'matched' : 'any'}|${radiusMeters}`;

  /**
   * The first page lives here, not in the list below, because the refresh control
   * belongs to this `Screen`: "pull to refresh" has to re-run the query that painted
   * the results, and a query owned by a child cannot be reached from its parent
   * without a ref or a context that would say less than this.
   */
  const listingOptions: GroupQueryOptions = {
    mode,
    query: debouncedQuery,
    categories,
    interestIds,
    matchMyInterests,
    radiusMeters,
  };
  const results = useQuery(() => fetchGroupsPage(listingOptions), { queryKey });
  const { refresh: refreshResults } = results;

  // The profile is refreshed alongside the listing: the Nearby view is anchored on
  // the member's own stored location, so moving it changes this screen's answer.
  const refreshAll = useCallback(() => {
    refreshProfile();
    refreshResults();
  }, [refreshProfile, refreshResults]);

  // Coming back from a group - joined, left, renamed - must not show the membership
  // list from before the change.
  useRefreshOnFocus(refreshAll);

  const toggleCategory = (id: GroupCategoryId) => {
    setCategories((current) =>
      current.includes(id) ? current.filter((category) => category !== id) : [...current, id],
    );
  };

  const toggleInterest = (id: string) => {
    setInterestIds((current) =>
      current.includes(id) ? current.filter((interest) => interest !== id) : [...current, id],
    );
  };

  const clearFilters = () => {
    setQuery('');
    setCategories([]);
    setInterestIds([]);
    setMatchMyInterests(false);
  };

  const emptyState: GroupsEmptyState =
    mode === 'nearby'
      ? {
          icon: 'compass-outline',
          title: 'No groups nearby yet',
          message: `Nothing within ${formatRadiusLabel(radiusMeters)} matches this search. Widen the radius, or browse every group instead.`,
          actionLabel: 'Browse all groups',
          onAction: () => setMode('all'),
        }
      : mode === 'mine'
        ? {
            icon: 'people-outline',
            title: 'You are not in a group yet',
            message: 'Join or start one and it will be waiting here — even when it is nowhere near you.',
            actionLabel: 'Find a group',
            onAction: () => setMode('nearby'),
          }
        : {
            icon: 'grid-outline',
            title: 'No groups match',
            message: 'Nothing here fits that search and category. Clear the filters, or start the group yourself.',
            actionLabel: 'Clear filters',
            onAction: clearFilters,
          };

  // With the match filter on, an empty list almost always means "nothing shares an
  // interest with me yet" rather than "nothing is nearby", so the action offers to
  // drop the match instead of changing view - the answer the member actually wants.
  const viewEmptyState: GroupsEmptyState = matchMyInterests
    ? {
        icon: emptyState.icon,
        title: 'No matched groups yet',
        message:
          'No group in this view has picked one of your interests. Showing every interest again will include the groups that have not picked one.',
        actionLabel: 'Show every interest',
        onAction: () => setMatchMyInterests(false),
      }
    : emptyState;

  return (
    <Screen onRefresh={refreshAll} refreshing={results.isRefreshing}>
      <ScreenHeader
        eyebrow="Directory"
        title="Find your people"
        subtitle="Sports crews, study groups, coding nights and everything between — most groups are open to join today."
        trailing={
          <IconButton name="add" onPress={() => router.push(routes.createGroup)} accessibilityLabel="Start a group" />
        }
      />

      <View style={styles.controls}>
        {mode === 'all' ? (
          // The escape hatch, named as a state rather than hidden: the member
          // arrived here from an empty Nearby view (or a missing location), and the
          // banner is also the way back.
          <Notice
            tone="info"
            message="Browsing every group"
            detail="Nearby is the default view. This is the whole directory, so distance is not part of the order."
            action={{ label: 'Back to nearby', onPress: () => setMode('nearby') }}
          />
        ) : (
          <SegmentedControl
            options={VIEW_OPTIONS}
            value={mode}
            onChange={setMode}
            accessibilityLabel="Group view"
          />
        )}
        <AppText variant="meta">{MODE_HINTS[mode]}</AppText>

        {mode === 'mine' ? null : (
          <>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder="Search groups"
              accessibilityLabel="Search groups"
            />
            <View style={styles.filterRow}>
              <FilterRow
                options={GROUP_CATEGORIES}
                selected={categories}
                onToggle={toggleCategory}
                accessibilityPrefix="Category"
              />
            </View>

            {ownInterestOptions.length > 0 ? (
              <>
                <AppText variant="meta">Interests you picked — groups that claimed one of them.</AppText>
                <View style={styles.filterRow}>
                  <FilterRow
                    options={ownInterestOptions}
                    selected={interestIds}
                    onToggle={toggleInterest}
                    accessibilityPrefix="Interest"
                  />
                </View>
                <View style={styles.filterRow}>
                  <FilterRow
                    options={MATCH_OPTIONS}
                    selected={matchMyInterests ? [MATCH_INTEREST_ID] : []}
                    onToggle={() => setMatchMyInterests((current) => !current)}
                    accessibilityPrefix="Match"
                  />
                </View>
              </>
            ) : null}
          </>
        )}

        {mode === 'nearby' ? (
          <View style={styles.filterRow}>
            <FilterRow
              options={RADIUS_OPTIONS}
              selected={[String(radiusMeters)]}
              onToggle={(id) => setRadiusMeters(Number(id))}
              accessibilityPrefix="Radius"
            />
          </View>
        ) : null}
      </View>

      <View style={styles.results}>
        <SectionHeading title={MODE_TITLES[mode]} />
        <GroupResults
          key={queryKey}
          options={listingOptions}
          result={results}
          emptyState={viewEmptyState}
          viewerInterestIds={viewerInterestIds}
          onBrowseAll={() => setMode('all')}
          onOpenGroup={(id) => router.push(routes.group(id))}
        />
      </View>
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
