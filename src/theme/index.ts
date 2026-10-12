import { colors } from './colors';
import { fontAssets } from './fontAssets';
import { layout, radii, shadows, spacing } from './layout';
import { fonts, text } from './typography';

/**
 * Unihood design system — "Campus Editorial".
 *
 * Import tokens from here (`src/theme`) rather than from the individual files so
 * refactors stay local to this folder.
 */
export { colors, type ColorToken } from './colors';
export { fonts, text, type TextToken } from './typography';
export { layout, radii, shadows, spacing, type RadiusToken, type SpacingToken } from './layout';
export { fontAssets } from './fontAssets';

/** Single object for consumers that prefer a grouped theme. */
export const theme = {
  colors,
  fonts,
  text,
  spacing,
  radii,
  shadows,
  layout,
  fontAssets,
} as const;

export type Theme = typeof theme;
