import { StyleSheet, Switch, View } from 'react-native';

import { colors, spacing } from '../theme';
import { AppText } from './AppText';

export interface ToggleProps {
  label: string;
  /** One line explaining exactly what the switch shares or hides. */
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

/**
 * Labelled switch row for the profile privacy controls.
 *
 * These two switches decide whether a member is visible at all and whether a
 * location is stored, so the copy beside them is not optional decoration — it is
 * the informed-consent part of the control. The row is not itself pressable: a
 * switch with two hit targets is a classic accidental-opt-in, so only the switch
 * toggles.
 */
export function Toggle({ label, description, value, onChange, disabled = false }: ToggleProps) {
  return (
    <View style={styles.row}>
      {/*
        The text is hidden from screen readers because the switch below carries
        the same words as its own name and hint — otherwise the whole block is
        announced twice.
      */}
      <View
        style={styles.text}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <AppText variant="bodyStrong">{label}</AppText>
        {description ? <AppText variant="meta">{description}</AppText> : null}
      </View>

      <Switch
        accessibilityLabel={label}
        accessibilityHint={description}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: colors.surfaceMuted, true: colors.oliveBorder }}
        thumbColor={value ? colors.olive : colors.surface}
        ios_backgroundColor={colors.surfaceMuted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingVertical: spacing.sm,
  },
  text: {
    flex: 1,
    gap: spacing.xxs,
  },
});
