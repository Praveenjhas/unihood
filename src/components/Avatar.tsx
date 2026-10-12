import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { initialsFromName } from '../lib/format';
import { colors, layout, type TextToken } from '../theme';
import { AppText } from './AppText';

const AVATAR_SIZES = {
  sm: layout.avatarSm,
  md: layout.avatarMd,
  lg: layout.avatarLg,
} as const;

export type AvatarSize = keyof typeof AVATAR_SIZES;

/** Type-scale variant per avatar size, so initials never set their own font size. */
const SIZE_VARIANTS: Record<AvatarSize, TextToken> = {
  sm: 'label',
  md: 'heading',
  lg: 'title',
};

/**
 * Two tones, taken straight from the palette. Alternate them deterministically
 * from the name so a list has rhythm without turning into a colour wheel.
 */
const TONES = [
  { background: colors.surfaceMuted, foreground: colors.ink },
  { background: colors.oliveSoft, foreground: colors.oliveDeep },
] as const;

/** Small stable string hash — the same name always gets the same tone. */
function toneIndex(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 100000;
  }
  return hash % TONES.length;
}

export interface AvatarProps {
  name: string;
  size?: AvatarSize;
  style?: StyleProp<ViewStyle>;
}

/**
 * Initials avatar. Phase 1 shows no photos, which is also the honest default for
 * a new social product: nobody has uploaded one yet.
 */
export function Avatar({ name, size = 'md', style }: AvatarProps) {
  const dimension = AVATAR_SIZES[size];
  const tone = TONES[toneIndex(name)];

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.base,
        { width: dimension, height: dimension, borderRadius: dimension / 2, backgroundColor: tone.background },
        style,
      ]}
    >
      <AppText variant={SIZE_VARIANTS[size]} color={tone.foreground}>
        {initialsFromName(name)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
