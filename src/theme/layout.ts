import type { ViewStyle } from 'react-native';

import { colors } from './colors';

/**
 * Spacing scale — a 4pt-ish rhythm with a couple of larger steps for editorial
 * breathing room. Use these instead of raw numbers so screens stay aligned.
 */
export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
} as const;

/**
 * Corner radii. Deliberately restrained: cards use `lg`, controls use `md`,
 * only genuinely chip-shaped elements use `pill`.
 */
export const radii = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

/**
 * Elevation. Campus Editorial prefers hairline borders over shadows, so these
 * are intentionally near-invisible and used only where a surface must lift
 * (e.g. the sticky RSVP bar).
 */
export const shadows: Record<'none' | 'hairline' | 'raised', ViewStyle> = {
  none: {},
  hairline: {
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  raised: {
    shadowColor: colors.ink,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.07,
    shadowRadius: 14,
    elevation: 4,
  },
};

/** Shared layout constants. */
export const layout = {
  /** Horizontal page padding used by every screen. */
  screenPadding: 20,
  /** Comfortable minimum tap target. */
  minTapTarget: 44,
  /** Standard control height (buttons, search fields). */
  controlHeight: 48,
  /** Compact control height. */
  controlHeightSm: 38,
  /** Avatar sizes. */
  avatarSm: 36,
  avatarMd: 52,
  avatarLg: 72,
  /** Widest comfortable reading measure for long-form copy. */
  readingWidth: 560,
} as const;

export type SpacingToken = keyof typeof spacing;
export type RadiusToken = keyof typeof radii;
