/**
 * Groups feature - the API-backed repository, the shared form and the card.
 *
 * The Phase 1 mock catalogue was deleted in Phase 4: the Events tab now names the
 * group hosting an event from the event's own payload, so nothing read the fixture
 * any more.
 */
export { GroupCard, type GroupCardProps } from './GroupCard';
export { GroupForm, type GroupFormProps } from './GroupForm';
export {
  GroupNotAvailableError,
  approveJoinRequest,
  archiveGroup,
  cancelJoinRequest,
  createGroup,
  fetchGroup,
  fetchGroupMembers,
  fetchGroupsPage,
  fetchJoinRequests,
  joinGroup,
  leaveGroup,
  rejectJoinRequest,
  removeMember,
  setMemberRole,
  updateGroup,
  type GroupListMode,
  type GroupQueryOptions,
} from './groupRepo';
export { useGroupLocationAnchor, type AnchorPermissionState, type GroupLocationAnchor } from './useGroupLocationAnchor';
