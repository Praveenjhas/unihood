import { useRouter } from 'expo-router';
import { useState } from 'react';
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
} from '../../src/components';
import { EVENT_CATEGORIES, EVENT_FEED_FILTERS } from '../../src/data';
import { EventCard, fetchEventFeed, type EventFeedQueryOptions } from '../../src/features/events';
import { describeError, routes, useDebouncedValue, useQuery, useRefreshOnFocus, type AsyncQueryResult } from '../../src/lib';
import { layout, spacing } from '../../src/theme';
import type { CampusEvent, EventCategoryId, EventFeedFilterId } from '../../src/types';

/** One line of context under the filter switch, so each slice is self-explaining. */
const FILTER_HINTS: Record<EventFeedFilterId, string> = {
  upcoming: 'Everything your groups have coming up, soonest first.',
  'needs-response': 'Events from your groups that you have not answered yet.',
  going: 'The events you have said yes to.',
  'not-going': 'The events you have declined.',
};

const SECTION_TITLES: Record<EventFeedFilterId, string> = {
  upcoming: 'Coming up in your groups',
  'needs-response': 'Waiting on your answer',
  going: 'You are going',
  'not-going': 'You are not going',
};

/** What to say when the feed succeeds but comes back empty. */
interface FeedEmptyState {
  icon: 'calendar-outline' | 'help-circle-outline' | 'checkmark-circle-outline' | 'close-circle-outline';
  title: string;
  message: string;
  actionLabel: string;
  onAction: () => void;
}

interface EventResultsProps {
  options: EventFeedQueryOptions;
  /**
   * The first page, owned by the screen rather than by this list: the screen is what
   * renders the refresh control, and a query created in here could not be reached by
   * it. The list still owns its own pagination below.
   */
  result: AsyncQueryResult<Awaited<ReturnType<typeof fetchEventFeed>>>;
  emptyState: FeedEmptyState;
  onOpenEvent: (id: string) => void;
}

/**
 * The result list, including its own pagination.
 *
 * Mounted with `key={queryKey}`, so a new filter remounts it and the pages loaded for
 * the previous filter cannot leak into the next - which is why there is no
 * reset-the-state effect below.
 */
function EventResults({ options, result, emptyState, onOpenEvent }: EventResultsProps) {
  const [more, setMore] = useState<CampusEvent[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const events = [...(result.data?.events ?? []), ...more];
  // The first page is the authority until a second one has been loaded.
  const offsetForNextPage = nextOffset ?? result.data?.nextOffset ?? null;
  const hasMore = offsetForNextPage !== null;

  const loadMore = () => {
    if (offsetForNextPage === null || isLoadingMore) return;
    setIsLoadingMore(true);
    setMoreError(null);

    void fetchEventFeed({ ...options, offset: offsetForNextPage })
      .then((page) => {
        setMore((current) => [...current, ...page.events]);
        setNextOffset(page.nextOffset);
      })
      .catch((caught) => setMoreError(describeError(caught)))
      .finally(() => setIsLoadingMore(false));
  };

  if (result.status === 'loading') return <ListSkeleton rows={4} />;

  if (result.status === 'error') {
    return (
      <ErrorState
        message="We couldn't load your groups' events just now."
        onRetry={result.retry}
        detail={result.error ? describeError(result.error) : undefined}
      />
    );
  }

  if (events.length === 0) return <EmptyState {...emptyState} />;

  return (
    <View style={styles.list}>
      {events.map((event) => (
        <EventCard key={event.id} event={event} onPress={() => onOpenEvent(event.id)} />
      ))}

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
          accessibilityHint="Appends the next page of events"
        />
      ) : null}
    </View>
  );
}

/**
 * Events — one unified feed of the member's own groups' calendar.
 *
 * Phase 7 replaced the three discovery views (Nearby / My groups / Going) with a
 * single list and four response-state filters. The reason is that the four filters
 * describe the *same* events: an event that appears under Going is the same row that
 * appears under All upcoming, only the member's answer differs. Nearby discovery had
 * nothing to filter and asked a different question ("what is happening near me?"),
 * which the API still answers for callers that want it.
 *
 * What appears here is decided entirely by the server: upcoming (scheduled, not yet
 * ended) events belonging to groups the member is an **active** member of. A private
 * group's event is therefore invisible to everyone else, a pending join request
 * reveals nothing, and a member with no groups gets an empty page rather than someone
 * else's calendar.
 */
export default function EventsScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<EventFeedFilterId>('upcoming');
  const [query, setQuery] = useState('');
  const [categories, setCategories] = useState<EventCategoryId[]>([]);

  const debouncedQuery = useDebouncedValue(query, 250);

  const queryKey = `events|feed|${filter}|${debouncedQuery}|${[...categories].sort().join(',')}`;

  const feedOptions: EventFeedQueryOptions = { filter, query: debouncedQuery, categories };
  const results = useQuery(() => fetchEventFeed(feedOptions), { queryKey });
  const { refresh: refreshFeed } = results;

  // Every RSVP and every cancellation is a server-side change to this feed, so the
  // screen re-reads it whenever it is returned to.
  useRefreshOnFocus(refreshFeed);

  const toggleCategory = (id: string) => {
    setCategories((current) =>
      current.includes(id as EventCategoryId)
        ? current.filter((entry) => entry !== id)
        : [...current, id as EventCategoryId],
    );
  };

  const clearFilters = () => {
    setQuery('');
    setCategories([]);
  };

  const emptyState: FeedEmptyState =
    filter === 'upcoming'
      ? {
          icon: 'calendar-outline',
          title: 'Nothing scheduled',
          message:
            'None of your groups has an upcoming event. Join another group to see their calendar, or host something yourself.',
          actionLabel: 'Find a group',
          onAction: () => router.push(routes.groups),
        }
      : filter === 'needs-response'
        ? {
            icon: 'checkmark-circle-outline',
            title: 'All caught up',
            message: 'Every upcoming event from your groups has an answer from you. New ones will appear here.',
            actionLabel: 'See everything',
            onAction: () => setFilter('upcoming'),
          }
        : filter === 'going'
          ? {
              icon: 'help-circle-outline',
              title: 'No RSVPs yet',
              message: "Say yes to an event and it will be waiting here. Only events you're going to appear.",
              actionLabel: "See what's on",
              onAction: () => setFilter('upcoming'),
            }
          : {
              icon: 'close-circle-outline',
              title: 'Nothing declined',
              message: 'Events you mark as Not going are listed here, so a group event is never easy to forget.',
              actionLabel: "See what's on",
              onAction: () => setFilter('upcoming'),
            };

  return (
    <Screen onRefresh={refreshFeed} refreshing={results.isRefreshing}>
      <ScreenHeader
        eyebrow="What's on"
        title="Your groups' calendar"
        subtitle="Upcoming events from the groups you are an active member of - answer Going or Not going and it appears under the right filter."
        trailing={
          <IconButton name="add" onPress={() => router.push(routes.createEvent)} accessibilityLabel="Create an event" />
        }
      />

      <View style={styles.controls}>
        <SegmentedControl
          options={EVENT_FEED_FILTERS}
          value={filter}
          onChange={setFilter}
          accessibilityLabel="Event response"
        />
        <AppText variant="meta">{FILTER_HINTS[filter]}</AppText>

        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search events, venues or hosts"
          accessibilityLabel="Search events"
        />
        <View style={styles.filterRow}>
          <FilterRow
            options={EVENT_CATEGORIES}
            selected={categories}
            onToggle={toggleCategory}
            accessibilityPrefix="Category"
          />
        </View>

        {categories.length > 0 || query.trim().length > 0 ? (
          <Button label="Clear filters" variant="ghost" size="sm" onPress={clearFilters} />
        ) : null}
      </View>

      <View style={styles.results}>
        <SectionHeading title={SECTION_TITLES[filter]} />
        <EventResults
          key={queryKey}
          options={feedOptions}
          result={results}
          emptyState={emptyState}
          onOpenEvent={(id) => router.push(routes.event(id))}
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

