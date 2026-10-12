/**
 * Unihood — "Campus Editorial" palette.
 *
 * A restrained, paper-toned palette. Content is meant to be the loudest thing on
 * screen, so colours are quiet: warm paper, dark ink, and a single muted olive
 * used sparingly for accents and selected states.
 *
 * Do not add new colours to a screen — extend this file instead so the whole app
 * stays on one system.
 */
export const colors = {
  /** App background — warm off-white paper. */
  paper: '#F7F6F2',
  /** Primary text and primary actions. */
  ink: '#252A36',
  /** Restrained accent. Use for selection, not decoration. */
  olive: '#555C4D',
  /** Hairline borders and dividers. */
  border: '#E5E3DD',
  /** Primary elevated surface (cards, fields). */
  surface: '#FFFFFF',
  /** Secondary muted surface (insets, neutral tags, skeletons). */
  surfaceMuted: '#EFEEE8',
  /** Secondary text: metadata, descriptions, inactive labels. */
  textSecondary: '#706F68',

  // ---- Derived tints (all desaturated, no neon, no gradients) ----
  /** Soft olive wash for selected chips and accent tags. */
  oliveSoft: '#E7E9DE',
  /** Border paired with `oliveSoft`. */
  oliveBorder: '#C7CBB8',
  /** Deeper olive used for text on `oliveSoft`. */
  oliveDeep: '#3F463A',
  /** Text/icon colour used on top of `ink` fills. */
  onInk: '#F7F6F2',
  /** Text/icon colour used on top of `olive` fills. */
  onOlive: '#FCFBF8',
  /** Slightly stronger border for controls that need definition. */
  borderStrong: '#D9D6CD',
  /** Muted terracotta for destructive actions and error states. */
  danger: '#8E4A3C',
  /** Soft terracotta surface for error panels. */
  dangerSoft: '#F2E6E2',
  /** Overlay used behind modal-ish surfaces. */
  scrim: 'rgba(37, 42, 54, 0.35)',
  transparent: 'transparent',
} as const;

export type ColorToken = keyof typeof colors;
