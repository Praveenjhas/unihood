import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { colors, fonts, radii, spacing } from '../theme';
import { AppText } from './AppText';

export interface FieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
  /** Quiet helper or error line under the input. */
  helper?: string;
  /** Flags the helper text as an error. */
  invalid?: boolean;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  /** Lets the field opt out of autocorrect — e.g. a word typed verbatim. */
  autoCorrect?: TextInputProps['autoCorrect'];
  keyboardType?: TextInputProps['keyboardType'];
  /** Masks the value — password fields. */
  secureTextEntry?: boolean;
  /** Lets the platform offer the right autofill (email, new-password, …). */
  autoComplete?: TextInputProps['autoComplete'];
  returnKeyType?: TextInputProps['returnKeyType'];
  /** Called by the keyboard's action key — used to advance or submit a form. */
  onSubmitEditing?: TextInputProps['onSubmitEditing'];
  /** Focuses the field on mount; at most one field per screen should use it. */
  autoFocus?: boolean;
  /** Greys the input out and blocks editing (e.g. a read-only email). */
  editable?: boolean;
}

/**
 * Labelled single-line/multiline input for the auth forms and the profile
 * editor. Exists so form styling and the label-to-input relationship (including
 * screen readers) are defined once instead of per screen.
 */
export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  maxLength,
  helper,
  invalid = false,
  autoCapitalize = 'sentences',
  autoCorrect,
  keyboardType = 'default',
  secureTextEntry = false,
  autoComplete,
  returnKeyType,
  onSubmitEditing,
  autoFocus = false,
  editable = true,
}: FieldProps) {
  return (
    <View style={styles.container}>
      <AppText variant="label">{label}</AppText>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        multiline={multiline}
        maxLength={maxLength}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        autoComplete={autoComplete}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        autoFocus={autoFocus}
        editable={editable}
        textAlignVertical={multiline ? 'top' : 'center'}
        style={[
          styles.input,
          multiline ? styles.multiline : null,
          invalid ? styles.inputInvalid : null,
          editable ? null : styles.inputReadOnly,
        ]}
      />
      {helper ? (
        <AppText variant="meta" color={invalid ? colors.danger : colors.textSecondary}>
          {helper}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs + 2,
  },
  input: {
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.ink,
  },
  multiline: {
    minHeight: 108,
  },
  inputInvalid: {
    borderColor: colors.danger,
  },
  inputReadOnly: {
    backgroundColor: colors.surfaceMuted,
    color: colors.textSecondary,
  },
});
