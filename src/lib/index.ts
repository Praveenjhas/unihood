/**
 * Shared helpers. Import from `src/lib` rather than the individual files.
 */
export {
  formatDayOfMonth,
  formatInstantDay,
  formatInstantTimeRange,
  formatInstantWhen,
  formatMonthShort,
  formatRelativeDay,
  formatShortDate,
  formatTime,
  formatTimeRange,
  formatWeekdayLong,
  isDateString,
  isPastDate,
  isPastInstant,
  isTimeString,
  isoFromLocal,
  parseLocalDate,
  toDateString,
  toLocalDateString,
  toLocalTimeString,
} from './date';
export {
  capacityRatio,
  formatAttendance,
  formatCompactNumber,
  formatMemberCount,
  initialsFromName,
  pluralize,
  truncate,
} from './format';
export { matchesAny, normalizeQuery } from './search';
export { routes, type RouteKey } from './routes';
export { dataSource, env, isBackendConfigured, type DataSourceKind } from './env';
export { useMockQuery, type QueryResult, type QueryStatus } from './useMockQuery';
export { useQuery, type AsyncQueryResult, type AsyncQueryOptions } from './useQuery';
export {
  ApiError,
  BackendNotConfiguredError,
  NetworkError,
  describeError,
  hasApiErrorCode,
  isApiError,
  isBackendNotConfigured,
  isNetworkError,
  toError,
} from './errors';
export {
  AUTH_STORAGE_KEY,
  apiRequest,
  clearSession,
  readSession,
  renewSession,
  saveSession,
  subscribeToSession,
  type ApiRequestOptions,
  type AuthSession,
  type HttpMethod,
  type SessionUser,
} from './apiClient';
export { useDebouncedValue } from './useDebouncedValue';
export { useRefreshOnFocus } from './useRefreshOnFocus';
export {
  COORDINATE_PRECISION_DECIMALS,
  DEFAULT_RADIUS_METERS,
  MAX_RADIUS_METERS,
  MIN_RADIUS_METERS,
  RADIUS_OPTIONS,
  clampRadiusMeters,
  formatApproximateDistance,
  formatLocationAge,
  formatRadiusLabel,
  hasSavedLocation,
  isValidLatitude,
  isValidLongitude,
  type RadiusOption,
} from './geo';
export {
  VENUE_LABEL_MIN_LENGTH,
  VENUE_LABEL_REQUIRED_MESSAGE,
  VENUE_LABEL_UNREADABLE_MESSAGE,
  isMeaningfulVenueLabel,
  venueLabelProblem,
  type VenueLabelRules,
} from './venue';
