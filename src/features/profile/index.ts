/**
 * Profile feature — the signed-in member's own row.
 *
 * Reads and writes go through `profileRepo`, the single mapping layer between
 * `public.profiles` + `profile_interests` and the `Profile` / `ProfileDraft`
 * types. Writes are funnelled through the `save_my_profile` RPC so the length and
 * consent limits live in one place (the database) instead of being re-implemented
 * per screen.
 */
export { fetchMyProfile, saveMyProfile } from './profileRepo';
export { ProfileForm, type ProfileFormProps } from './ProfileForm';
