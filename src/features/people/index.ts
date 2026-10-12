/**
 * People (member discovery) feature.
 *
 * Unlike Groups and Events, this feature is live: it reads from the
 * `search_people` / `nearby_people` / `get_public_profile` RPCs and therefore
 * needs an authenticated session. There is no mock catalog here on purpose —
 * inventing people for a location-based social app would be the one thing the
 * product cannot afford to fake.
 */
export {
  fetchPeoplePage,
  fetchPerson,
  PEOPLE_PAGE_SIZE,
  PersonNotAvailableError,
  type DiscoveryOptions,
} from './peopleRepo';
// `PersonCard` plus the two helpers the person detail screen shares with it, so the
// tint on a card and the tint on a profile can never disagree about what is shared.
export { PersonCard, interestsMatchedFirst, sharedInterestsOf, type PersonCardProps } from './PersonCard';
