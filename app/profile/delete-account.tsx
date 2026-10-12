import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Button, Card, Field, Notice, Screen, ScreenHeader, SectionHeading } from '../../src/components';
import { useAuth } from '../../src/features/auth';
import { describeError, hasApiErrorCode, routes } from '../../src/lib';
import { spacing } from '../../src/theme';

/**
 * The word the member has to type before the button works.
 *
 * The API checks the same literal, so the two cannot drift into "the form let me but
 * the server did not": this screen builds the habit, and the server keeps the rule.
 */
const CONFIRM_WORD = 'DELETE';

/**
 * Delete account.
 *
 * Three things have to be true before anything is destroyed: the member got here
 * deliberately, they typed the word, and they proved they own the account by giving
 * its password - because a live session is not proof of ownership.
 *
 * There is no success state to render. The API deletes the account and every session
 * on it, the provider clears the stored session, and the root guard swaps this whole
 * tree for the welcome screen - so the form is left in its submitting state instead
 * of flashing back into view for a frame.
 *
 * The refusal worth acting on is the one about groups: a group you own that still has
 * other active members cannot be left ownerless, so the API names the groups in the
 * way and this screen offers the way to them.
 */
export default function DeleteAccountScreen() {
  const router = useRouter();
  const { profile, deleteAccount } = useAuth();

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** True when the refusal was "you still own groups that have other members". */
  const [blockedByOwnership, setBlockedByOwnership] = useState(false);

  const confirmationMatches = confirmation.trim() === CONFIRM_WORD;
  const canSubmit = !isSubmitting && password.length > 0 && confirmationMatches;

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(routes.profile);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    setBlockedByOwnership(false);

    try {
      await deleteAccount({ password, confirm: confirmation.trim() });
      // Deliberately nothing here: the session is gone with the account, so the guard
      // is already rendering the welcome screen and this screen is being unmounted.
    } catch (caught) {
      setBlockedByOwnership(hasApiErrorCode(caught, 'ownership_transfer_required'));
      setErrorMessage(describeError(caught));
      setIsSubmitting(false);
    }
  };

  return (
    <Screen
      contentStyle={styles.content}
      footer={
        <>
          <Button
            label="Delete my account"
            icon="trash-outline"
            variant="danger"
            fullWidth
            loading={isSubmitting}
            disabled={!canSubmit}
            onPress={() => void submit()}
            accessibilityHint="Permanently closes your account and signs this device out"
          />
          <Button label="Cancel" variant="ghost" fullWidth disabled={isSubmitting} onPress={goBack} />
        </>
      }
    >
      <ScreenHeader
        eyebrow="Your account"
        title="Delete account"
        subtitle="This cannot be undone, and nothing you made is kept."
        onBack={goBack}
      />

      {errorMessage ? (
        <Notice
          tone="danger"
          message={errorMessage}
          action={
            blockedByOwnership ? { label: 'Open my groups', onPress: () => router.push(routes.groups) } : undefined
          }
        />
      ) : null}

      <View style={styles.section}>
        <SectionHeading title="What goes" />
        <Card style={styles.card}>
          <AppText variant="bodySecondary">
            Your profile and the interests on it, the location you shared, every group membership, the messages you sent,
            every RSVP you gave, and every event you created.
          </AppText>
          <AppText variant="meta">
            Your number is released, so it can start a new account later. A group you own that still has other members
            stops the deletion until you hand it on or remove them; a group nobody else is in is archived on the way out.
          </AppText>
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeading title="Confirm it is you" />
        <Card style={styles.card}>
          <Field
            label="Your password"
            value={password}
            onChangeText={setPassword}
            placeholder="The one you sign in with"
            secureTextEntry
            autoComplete="current-password"
            editable={!isSubmitting}
          />

          <Field
            label={`Type ${CONFIRM_WORD} to confirm`}
            value={confirmation}
            onChangeText={setConfirmation}
            placeholder={CONFIRM_WORD}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="go"
            editable={!isSubmitting}
            onSubmitEditing={() => void submit()}
            invalid={confirmation.length > 0 && !confirmationMatches}
            helper={
              confirmation.length > 0 && !confirmationMatches
                ? `Type ${CONFIRM_WORD}, in capitals.`
                : 'Capitals, exactly as written above.'
            }
          />
        </Card>
      </View>

      <AppText variant="meta" align="center">
        {profile?.phone
          ? `You are closing the account that signs in with ${profile.phone}.`
          : 'You are closing this account.'}
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.xxl,
  },
  section: {
    gap: spacing.md,
  },
  card: {
    gap: spacing.lg,
  },
});
