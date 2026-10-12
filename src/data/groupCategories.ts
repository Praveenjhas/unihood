import {
  GROUP_CATEGORY_IDS,
  type GroupAudience,
  type GroupCategory,
  type GroupCategoryId,
  type GroupEligibilityGender,
  type GroupVisibility,
  type MembershipStatus,
} from '../types';

/**
 * The group vocabulary, as labels.
 *
 * Ids are the server's; labels are the app's. The list covers the eight kinds of
 * group the product names (sport and fitness, coding and technology, study and
 * learning, food and social, music, arts, gaming, travel and outdoors, general
 * interests) in the vocabulary the catalogue already used, so nothing that was
 * stored before this phase becomes unlabelled.
 */
const GROUP_CATEGORY_LABELS: Record<GroupCategoryId, string> = {
  sports: 'Sports & fitness',
  coding: 'Coding & tech',
  study: 'Study',
  social: 'Food & social',
  music: 'Music',
  arts: 'Arts & design',
  gaming: 'Gaming',
  travel: 'Travel & outdoors',
  general: 'General',
};

export const GROUP_CATEGORIES: readonly GroupCategory[] = GROUP_CATEGORY_IDS.map((id) => ({
  id,
  label: GROUP_CATEGORY_LABELS[id],
}));

export function groupCategoryLabel(id: GroupCategoryId): string {
  return GROUP_CATEGORY_LABELS[id];
}

export function groupVisibilityLabel(visibility: GroupVisibility): string {
  return visibility === 'private' ? 'Private' : 'Public';
}

/** The one-line explanation used beside the visibility choice and on a detail row. */
export function groupVisibilityHint(visibility: GroupVisibility): string {
  return visibility === 'private'
    ? 'Membership requires approval by the owner or an administrator.'
    : 'Anyone eligible can find the group and join straight away.';
}

const AUDIENCE_LABELS: Record<GroupAudience, string> = {
  everyone: 'Everyone',
  men_only: 'Men only',
  women_only: 'Women only',
};

export function groupAudienceLabel(audience: GroupAudience): string {
  return AUDIENCE_LABELS[audience];
}

export function groupAudienceHint(audience: GroupAudience): string {
  switch (audience) {
    case 'men_only':
      return 'This group is for men only, so it is shown to members whose gender is "Man".';
    case 'women_only':
      return 'This group is for women only, so it is shown to members whose gender is "Woman".';
    case 'everyone':
      return 'Anyone can find and join this group, whatever their gender.';
  }
}

export const GROUP_AUDIENCE_OPTIONS: readonly { id: GroupAudience; label: string }[] = [
  { id: 'everyone', label: AUDIENCE_LABELS.everyone },
  { id: 'men_only', label: AUDIENCE_LABELS.men_only },
  { id: 'women_only', label: AUDIENCE_LABELS.women_only },
];

export const GROUP_VISIBILITY_OPTIONS: readonly { id: GroupVisibility; label: string }[] = [
  { id: 'public', label: 'Public' },
  { id: 'private', label: 'Private' },
];

/** How a stored membership state reads on a card. */
export function membershipStatusLabel(status: MembershipStatus): string {
  switch (status) {
    case 'active':
      return 'Member';
    case 'pending':
      return 'Request pending';
    case 'rejected':
      return 'Request declined';
    case 'removed':
      return 'Removed';
    case 'left':
      return 'Not a member';
  }
}

export function groupRoleLabel(role: 'owner' | 'admin' | 'member'): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Administrator';
    case 'member':
      return 'Member';
  }
}

const ELIGIBILITY_LABELS: Record<GroupEligibilityGender, string> = {
  man: 'Man',
  woman: 'Woman',
  another: 'Another identity',
  prefer_not_to_say: 'Prefer not to say',
};

export function groupEligibilityLabel(value: GroupEligibilityGender): string {
  return ELIGIBILITY_LABELS[value];
}

export const GROUP_ELIGIBILITY_OPTIONS: readonly { id: GroupEligibilityGender; label: string }[] = (
  ['man', 'woman', 'another', 'prefer_not_to_say'] as const
).map((id) => ({ id, label: ELIGIBILITY_LABELS[id] }));
