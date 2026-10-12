/**
 * Shared reference data.
 *
 * Two kinds of catalog live here, and the difference matters:
 * - `interests`, `groupCategories`, `eventCategories` are static vocabularies
 *   compiled into the app (Groups and Events still run on mock data).
 * - `interestsRepo` reads the live `public.interests` table, which is the source
 *   of truth once a session exists.
 * `interestLabelFor` reconciles the two: it labels every id the database can
 * return, falling back to a title-cased slug for vocabulary added server-side.
 *
 * Import from `src/data` rather than the individual files.
 */
export { INTERESTS, interestLabel, interestLabelFor } from './interests';
export {
  DEFAULT_PHONE_COUNTRY,
  PHONE_COUNTRIES,
  countryFlag,
  countryForDialCode,
  type PhoneCountry,
} from './phoneCountries';
export {
  FALLBACK_INTEREST_CATEGORY,
  INTEREST_CATEGORY_IDS,
  interestCategoryLabel,
  interestCategoryOf,
  interestCategoryRank,
  type InterestCategoryId,
} from './interestCategories';
export { fetchInterestCatalog } from './interestsRepo';
export {
  useInterestCatalog,
  type InterestCatalogValue,
  type InterestOption,
} from './useInterestCatalog';
export {
  GROUP_AUDIENCE_OPTIONS,
  GROUP_CATEGORIES,
  GROUP_ELIGIBILITY_OPTIONS,
  GROUP_VISIBILITY_OPTIONS,
  groupAudienceHint,
  groupAudienceLabel,
  groupCategoryLabel,
  groupEligibilityLabel,
  groupRoleLabel,
  groupVisibilityHint,
  groupVisibilityLabel,
  membershipStatusLabel,
} from './groupCategories';
export { EVENT_CATEGORIES, EVENT_FEED_FILTERS, eventCategoryLabel, eventFeedFilterLabel } from './eventCategories';
