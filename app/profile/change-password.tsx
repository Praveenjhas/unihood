import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { AppText, Button, Card, Field, Notice, Screen, ScreenHeader } from '../../src/components';
import { MIN_PASSWORD_LENGTH, changeMyPassword } from '../../src/features/auth';
import { describeError, routes } from '../../src/lib';
import { spacing } from '../../src/theme';

/**
 * Change password.
 *
 * The current password is required by the *API*, not by this form: a session is not
 * proof of ownership, so the check happens server-side against the stored scrypt
 * hash, and the sentence the server writes is what the member reads. Everything
 * here that looks like validation (`MIN_PASSWORD_LENGTH`, the confirmation field)
 * exists to save a round trip, not to be the rule.
 *
 * A successful change signs every *other* device out - a live session was opened
 * with the old password, which is what a change is for - and deliberately leaves
 * this one signed in, so the screen stays put and says so rather than navigating.
 *
 * There is no "forgot it?" flow, and this screen says why instead of pretending:
 * Unihood cannot send a code or an email to prove the number belongs to the member,
 * so the only honest answer is for whoever runs the instance to set one.
 */
export default function ChangePasswordScreen() {
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const newPasswordTooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const passwordsDisagree = confirmPassword.length > 0 && confirmPassword !== newPassword;
  // Refused server-side as well, for the same reason as the length rule: this is
  // the cheap check that saves a request, and the wording matches the server's.
  const unchangedPassword = newPassword.length > 0 && newPassword === currentPassword;

  const canSubmit =
    !isSubmitting &&
    currentPassword.length > 0 &&
    newPassword.length >= MIN_PASSWORD_LENGTH &&
    !unchangedPassword &&
    newPassword === confirmPassword;

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(routes.profile);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    setNotice(null);

    try {
      await changeMyPassword({ currentPassword, newPassword });
      // The password is dropped from state the moment it has been accepted; the
      // notice below is the only thing left on screen.
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setNotice('Password changed. Every other device has been signed out.');
    } catch (caught) {
      setErrorMessage(describeError(caught));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Screen
      contentStyle={styles.content}
      footer={
        <>
          <Button
            label="Change password"
            icon="key-outline"
            variant="primary"
            fullWidth
            loading={isSubmitting}
            disabled={!canSubmit}
            onPress={() => void submit()}
            accessibilityHint="Checks your current password, then saves the new one"
          />
          <Button label="Cancel" variant="ghost" fullWidth disabled={isSubmitting} onPress={goBack} />
        </>
      }
    >
      <ScreenHeader
        eyebrow="Your account"
        title="Change password"
        subtitle="Your number stays the same — only the password in front of it changes."
        onBack={goBack}
      />

      {errorMessage ? <Notice tone="danger" message={errorMessage} /> : null}
      {notice ? <Notice tone="success" message={notice} /> : null}

      <Card style={styles.card}>
        <Field
          label="Current password"
          value={currentPassword}
          onChangeText={setCurrentPassword}
          placeholder="The one you sign in with"
          secureTextEntry
          autoComplete="current-password"
          editable={!isSubmitting}
        />

        <Field
          label="New password"
          value={newPassword}
          onChangeText={setNewPassword}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          secureTextEntry
          autoComplete="new-password"
          returnKeyType="next"
          editable={!isSubmitting}
          invalid={newPasswordTooShort || unchangedPassword}
          helper={
            unchangedPassword
              ? 'This is the password you are already using.'
              : newPasswordTooShort
                ? `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`
                : `At least ${MIN_PASSWORD_LENGTH} characters, and not your name or number.`
          }
        />

        <Field
          label="Confirm new password"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          placeholder="Type it once more"
          secureTextEntry
          autoComplete="new-password"
          returnKeyType="go"
          editable={!isSubmitting}
          invalid={passwordsDisagree}
          onSubmitEditing={() => void submit()}
          helper={passwordsDisagree ? 'Those two passwords do not match.' : 'It has to match exactly.'}
        />
      </Card>

      <AppText variant="meta">
        Changing the password signs out every other device, and keeps this one. The new password is hashed on the server
        before it is stored — nobody at Unihood can read it back, and it is never kept on this device.
      </AppText>

      <AppText variant="meta">
        There is no self-service reset: Unihood cannot send a code or an email to prove this number belongs to you. If
        you forget the password, ask whoever runs Unihood to set a new one.
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.xxl,
  },
  card: {
    gap: spacing.lg,
  },
});
