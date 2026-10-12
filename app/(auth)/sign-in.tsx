import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import {
  AppText,
  Button,
  Card,
  Field,
  FilterRow,
  Notice,
  Screen,
  ScreenHeader,
  SegmentedControl,
} from '../../src/components';
import { DEFAULT_PHONE_COUNTRY, PHONE_COUNTRIES, countryFlag, countryForDialCode } from '../../src/data';
import { MIN_PASSWORD_LENGTH, registerWithPassword, signInWithPassword } from '../../src/features/auth';
import { describeError, routes } from '../../src/lib';
import { spacing } from '../../src/theme';

/**
 * Which credential the screen is collecting.
 *
 * Two modes and no third: `create` adds a name and a confirmation field, and
 * everything else is the same form. There is no one-time-code path any more —
 * every account is created with a password, and the phone number is only ever the
 * name a member signs in with.
 */
type Mode = 'sign-in' | 'create';

type StepNotice = { tone: 'info' | 'success' | 'danger'; message: string; detail?: string };

/** The two modes, in the order a member meets them. */
const MODE_OPTIONS = [
  { id: 'sign-in' as const, label: 'Sign in' },
  { id: 'create' as const, label: 'Create an account' },
];

/** Country chips: `🇮🇳 +91`. The id is the ISO code so two countries can share +1. */
const COUNTRY_OPTIONS = PHONE_COUNTRIES.map((country) => ({
  id: country.iso,
  label: `${countryFlag(country.iso)} ${country.dialCode}`,
}));

/** Digits only, so a pasted `+91 98765-43210` still works. */
const digitsOnly = (value: string): string => value.replace(/\D+/g, '').slice(0, 15);

/**
 * Sign in, or create an account — a phone number and a password.
 *
 * One screen rather than two routes for the same reason it always was: the two
 * halves share every field but the name, and there is no state to restore or deep
 * link to arrive from. The mode switch is a segmented control because the choice
 * is exclusive and obvious, not a filter. The welcome screen's "Create my account"
 * button arrives as `?mode=create`, which only chooses where the control starts.
 *
 * The screen never navigates on success. `signInWithPassword` / `registerWithPassword`
 * store the session; `AuthProvider` sees it through `subscribeToSession`, and the
 * root guard is what swaps this stack for onboarding (a new account) or the app (a
 * returning one). Navigating here as well would race that guard and could bounce
 * the member straight back out.
 */
export default function SignInScreen() {
  const router = useRouter();
  /** Set by the welcome screen's "Create my account" button. */
  const { mode: modeParam } = useLocalSearchParams<{ mode?: string }>();

  // Seeded once from the route: after that the segmented control owns the value,
  // so a later re-render cannot drag the member back to the mode they arrived in.
  const [mode, setMode] = useState<Mode>(() => (modeParam === 'create' ? 'create' : 'sign-in'));
  const [dialCode, setDialCode] = useState(DEFAULT_PHONE_COUNTRY.dialCode);
  const [nationalNumber, setNationalNumber] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<StepNotice | null>(null);

  // A screen can be left mid-request; a late response must not set state on an
  // unmounted screen.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const selectedCountry = countryForDialCode(dialCode);
  const digits = digitsOnly(nationalNumber);
  const dialDigits = digitsOnly(dialCode);
  // Deliberately loose: the server is the authority on whether a number is a real
  // E.164 value, and a stricter client rule would only reject numbers the API
  // accepts.
  const phoneLooksUsable = dialDigits.length >= 1 && digits.length >= 4;
  const nameLooksUsable = displayName.trim().length > 0;
  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const passwordsDisagree = confirmPassword.length > 0 && confirmPassword !== password;
  const credentialLooksReady = phoneLooksUsable && password.length > 0;
  const createLooksReady = mode !== 'create' || (nameLooksUsable && !passwordTooShort && confirmPassword === password);
  const canSubmit = !isSubmitting && credentialLooksReady && createLooksReady;

  const phoneInput = { countryCode: `+${dialDigits}`, nationalNumber: digits };

  /** Switching modes clears the last answer: it described the other form. */
  const switchMode = (next: Mode) => {
    setMode(next);
    setErrorMessage(null);
    setNotice(null);
  };

  /** Back leaves the screen; the welcome screen behind it is the way in again. */
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(routes.welcome);
  };

  const submitPassword = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    setNotice(null);

    try {
      if (mode === 'create') {
        const result = await registerWithPassword({ phone: phoneInput, password, displayName });
        if (!mountedRef.current) return;

        // Left in the submitting state on purpose: the guard is about to unmount
        // this screen, and re-enabling the button first would flash an editable
        // form. This notice is what explains the frame before that.
        setNotice({
          tone: 'success',
          message: 'Account created — setting up your profile.',
          detail: result.onboardingRequired ? 'Three quick steps and you are in.' : undefined,
        });
        return;
      }

      await signInWithPassword({ phone: phoneInput, password });
      if (!mountedRef.current) return;

      setNotice({ tone: 'success', message: 'Welcome back.', detail: 'Fetching your profile…' });
    } catch (caught) {
      if (!mountedRef.current) return;

      setErrorMessage(describeError(caught));
      setIsSubmitting(false);
    }
  };

  const primaryLabel = mode === 'create' ? 'Create my account' : 'Sign in';

  return (
    <Screen
      contentStyle={styles.content}
      footer={
        <>
          <Button
            label={primaryLabel}
            icon={mode === 'create' ? 'person-add-outline' : 'log-in-outline'}
            variant="primary"
            fullWidth
            loading={isSubmitting}
            disabled={!canSubmit}
            onPress={() => void submitPassword()}
            accessibilityHint={
              mode === 'create' ? 'Creates the account and signs you in' : 'Checks the password and signs you in'
            }
          />

          <Button label="Back" variant="ghost" fullWidth disabled={isSubmitting} onPress={goBack} />
        </>
      }
    >
      <ScreenHeader
        eyebrow={mode === 'create' ? 'New here' : 'Welcome back'}
        title={mode === 'create' ? 'Create your account' : 'Sign in'}
        subtitle={
          mode === 'create'
            ? 'Your name, your number and a password. The number is how you sign in from now on.'
            : 'Your number and your password. New here? Creating an account takes a minute.'
        }
        onBack={goBack}
      />

      {errorMessage ? <Notice tone="danger" message={errorMessage} /> : null}
      {notice ? <Notice tone={notice.tone} message={notice.message} detail={notice.detail} /> : null}

      <SegmentedControl
        options={MODE_OPTIONS}
        value={mode}
        onChange={switchMode}
        accessibilityLabel="Sign in or create an account"
      />

      <Card style={styles.card}>
        <Field
          label="Country code"
          value={dialCode}
          onChangeText={(value) => setDialCode(`+${digitsOnly(value).slice(0, 3)}`)}
          placeholder="+91"
          keyboardType="phone-pad"
          editable={!isSubmitting}
          helper={selectedCountry ? selectedCountry.name : 'Pick one below, or type the code.'}
        />

        <View style={styles.chipRail}>
          <FilterRow
            options={COUNTRY_OPTIONS}
            selected={selectedCountry ? [selectedCountry.iso] : []}
            onToggle={(iso) => {
              const next = PHONE_COUNTRIES.find((country) => country.iso === iso);
              if (next) setDialCode(next.dialCode);
            }}
            accessibilityPrefix="Country code"
          />
        </View>

        <Field
          label="Phone number"
          value={nationalNumber}
          onChangeText={(value) => setNationalNumber(digitsOnly(value))}
          placeholder="98765 43210"
          keyboardType="phone-pad"
          autoComplete="tel"
          editable={!isSubmitting}
          invalid={nationalNumber.length > 0 && !phoneLooksUsable}
          helper={
            nationalNumber.length > 0 && !phoneLooksUsable
              ? 'That number looks too short.'
              : mode === 'create'
                ? 'This is your sign-in name, and it is not shown to anyone else.'
                : 'Without the country code, and without a leading 0.'
          }
        />
      </Card>

      <Card style={styles.card}>
        {mode === 'create' ? (
          <Field
            label="Your name"
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="How other members see you"
            autoCapitalize="words"
            autoComplete="name"
            maxLength={60}
            editable={!isSubmitting}
            invalid={displayName.length > 0 && !nameLooksUsable}
            helper={displayName.length > 0 && !nameLooksUsable ? 'A name is required.' : 'Up to 60 characters.'}
          />
        ) : null}

        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          placeholder={mode === 'create' ? `At least ${MIN_PASSWORD_LENGTH} characters` : 'Your password'}
          secureTextEntry
          autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          returnKeyType={mode === 'create' ? 'next' : 'go'}
          editable={!isSubmitting}
          invalid={passwordTooShort}
          helper={passwordTooShort ? `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
          onSubmitEditing={() => {
            if (mode === 'sign-in') void submitPassword();
          }}
        />

        {mode === 'create' ? (
          <Field
            label="Confirm password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder="Type it once more"
            secureTextEntry
            autoComplete="new-password"
            returnKeyType="go"
            editable={!isSubmitting}
            invalid={passwordsDisagree}
            onSubmitEditing={() => void submitPassword()}
            helper={passwordsDisagree ? 'Those two passwords do not match.' : 'It has to match exactly.'}
          />
        ) : null}

        <AppText variant="meta">
          {mode === 'create'
            ? 'The password goes through a one-way hash before it is stored, so nobody at Unihood can read it back. It is never kept on this device either.'
            : 'Signing in with the number you registered. The password is checked on the server and is never stored on this device.'}
        </AppText>
      </Card>
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
  chipRail: {
    // The rail runs to the screen edge so it reads as scrollable.
    marginRight: -spacing.xl,
  },
});
