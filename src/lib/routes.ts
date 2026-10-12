import type { Href } from 'expo-router';

/**
 * Every navigation target in the app, in one place.
 *
 * Screens never hand-write a path: route strings drifting out of sync with the
 * file tree is the most common source of dead links in a file-based router.
 * Dynamic routes return the object form (`pathname` + `params`) because that is
 * the shape typed routes validate.
 *
 * File map:
 * - `/`                -> app/(tabs)/index.tsx      (People)
 * - `/groups`          -> app/(tabs)/groups.tsx
 * - `/events`          -> app/(tabs)/events.tsx
 * - `/profile`         -> app/(tabs)/profile.tsx
 * - `/onboarding`      -> app/onboarding.tsx
 * - `/setup-required`  -> app/setup-required.tsx
 * - `/profile/edit`    -> app/profile/edit.tsx
 * - `/profile/change-password` -> app/profile/change-password.tsx
 * - `/profile/delete-account`  -> app/profile/delete-account.tsx
 * - `/welcome`         -> app/(auth)/welcome.tsx
 * - `/sign-in`         -> app/(auth)/sign-in.tsx   (phone number + password; also
 *                       create-an-account, via `?mode=create`)
 * - `/person/[id]`     -> app/person/[id].tsx
 * - `/group/[id]`      -> app/group/[id].tsx (detail + membership actions)
 * - `/group/manage/[id]` -> app/group/manage/[id].tsx (requests + members)
 * - `/group/edit/[id]` -> app/group/edit/[id].tsx (owner settings + archiving)
 * - `/group/chat/[id]` -> app/group/chat/[id].tsx (the group's chat, members only)
 * - `/event/[id]`      -> app/event/[id].tsx
 * - `/create/group`    -> app/create/group.tsx
 * - `/create/event`    -> app/create/event.tsx          (event editor)
 *
 * Phase 5 removed `/sign-up`, `/verify-email`, `/forgot-password`,
 * `/reset-password` and `/auth/callback` along with the email/password screens
 * they belonged to. `/sign-in` is where both halves of the phone-and-password
 * flow live - signing in, and creating the account in the first place - so those
 * screens still have nothing to do.
 */
export const routes = {
  people: '/',
  groups: '/groups',
  events: '/events',
  profile: '/profile',
  onboarding: '/onboarding',
  setupRequired: '/setup-required',
  editProfile: '/profile/edit',
  /** Change the password of the signed-in account. */
  changePassword: '/profile/change-password',
  /** Close the signed-in account, after the confirmation screen. */
  deleteAccount: '/profile/delete-account',
  welcome: '/welcome',
  signIn: '/sign-in',
  /**
   * The same screen as `signIn`, opened on "create an account".
   *
   * A query parameter rather than a second route: it is one form with one
   * segmented control, so a separate path would only be a second name for the
   * same screen - and a second thing to keep in sync.
   */
  createAccount: (): Href => ({ pathname: '/sign-in', params: { mode: 'create' } }),
  createGroup: '/create/group',
  createEvent: '/create/event',
  createEventForGroup: (groupId: string): Href => ({
    pathname: '/create/event',
    params: { groupId },
  }),
  editEvent: (id: string): Href => ({ pathname: '/event/edit/[id]', params: { id } }),
  person: (id: string): Href => ({ pathname: '/person/[id]', params: { id } }),
  group: (id: string): Href => ({ pathname: '/group/[id]', params: { id } }),
  manageGroup: (id: string): Href => ({ pathname: '/group/manage/[id]', params: { id } }),
  editGroup: (id: string): Href => ({ pathname: '/group/edit/[id]', params: { id } }),
  groupChat: (id: string): Href => ({ pathname: '/group/chat/[id]', params: { id } }),
  event: (id: string): Href => ({ pathname: '/event/[id]', params: { id } }),
} as const;

export type RouteKey = keyof typeof routes;
