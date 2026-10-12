import type { TextStyle } from 'react-native';

import { colors } from './colors';

/**
 * Font families registered at runtime in `app/_layout.tsx`.
 *
 * Pairing rationale (Campus Editorial):
 * - `Fraunces` is an editorial serif with a warm, slightly quirky personality.
 *   It is reserved for page headings, hero titles and the big date numerals on
 *   event cards, so headings read like a well-art-directed publication.
 * - `Inter` is a neutral, highly legible UI sans used for everything functional:
 *   body copy, labels, metadata, navigation and forms.
 *
 * If a font fails to load (see `useFonts` fallback in `app/_layout.tsx`), React
 * Native silently falls back to the platform default for that family. Copy still
 * reads correctly, hierarchy is preserved by size/weight, and nothing breaks.
 */
export const fonts = {
  display: 'Fraunces_600SemiBold',
  displayMedium: 'Fraunces_500Medium',
  displayRegular: 'Fraunces_400Regular',
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
} as const;

/**
 * Type scale. Sizes are tuned for ~360–412dp Android phones.
 * Avoid ad-hoc font sizes in screens — add a token here instead.
 */
export const text = {
  /** Page headings, e.g. "Who's around today?". */
  display: {
    fontFamily: fonts.display,
    fontSize: 31,
    lineHeight: 37,
    letterSpacing: -0.6,
    color: colors.ink,
  },
  /** Detail-screen hero titles. */
  displaySmall: {
    fontFamily: fonts.display,
    fontSize: 25,
    lineHeight: 31,
    letterSpacing: -0.4,
    color: colors.ink,
  },
  /** Section headings inside a screen. */
  title: {
    fontFamily: fonts.display,
    fontSize: 20,
    lineHeight: 26,
    letterSpacing: -0.2,
    color: colors.ink,
  },
  /** Card titles and list-item titles. */
  heading: {
    fontFamily: fonts.semibold,
    fontSize: 16.5,
    lineHeight: 22,
    letterSpacing: -0.1,
    color: colors.ink,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink,
  },
  bodySecondary: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textSecondary,
  },
  bodyStrong: {
    fontFamily: fonts.medium,
    fontSize: 15,
    lineHeight: 22,
    color: colors.ink,
  },
  /** Metadata lines (campus · year, time · venue). */
  meta: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  metaStrong: {
    fontFamily: fonts.medium,
    fontSize: 13,
    lineHeight: 19,
    color: colors.ink,
  },
  /** Small labels, captions, tab labels. */
  label: {
    fontFamily: fonts.medium,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.1,
    color: colors.textSecondary,
  },
  /**
   * Small tracked label used above a page heading. Use sparingly — at most one
   * per screen — so the app never becomes a wall of uppercase text.
   */
  eyebrow: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.olive,
  },
  button: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0.1,
  },
  buttonSmall: {
    fontFamily: fonts.semibold,
    fontSize: 13.5,
    lineHeight: 18,
    letterSpacing: 0.1,
  },
  tag: {
    fontFamily: fonts.medium,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.1,
  },
  /** Big editorial numeral used in the event date block. */
  numeral: {
    fontFamily: fonts.display,
    fontSize: 24,
    lineHeight: 27,
    letterSpacing: -0.5,
    color: colors.ink,
  },
} as const;

export type TextToken = keyof typeof text;

/** Convenience alias for places that need a `TextStyle` type. */
export type TextStyles = typeof text;
export type { TextStyle };
