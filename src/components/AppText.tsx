import { Text, type TextProps } from 'react-native';

import { text as textTokens, type TextToken } from '../theme';

export interface AppTextProps extends TextProps {
  /** Which step of the type scale to use. Defaults to `body`. */
  variant?: TextToken;
  /** Overrides the token's colour — e.g. a label sitting on an `ink` fill. */
  color?: string;
  align?: 'left' | 'center' | 'right';
}

/**
 * The only text primitive in the app.
 *
 * Content and hierarchy come from the `text` scale in `src/theme/typography.ts`
 * rather than from inline font styles, which is what keeps every screen looking
 * like one publication. If you need a size that is not in the scale, add a token
 * instead of passing `fontSize` through `style`.
 */
export function AppText({ variant = 'body', color, align, style, ...rest }: AppTextProps) {
  return <Text {...rest} style={[textTokens[variant], color ? { color } : null, align ? { textAlign: align } : null, style]} />;
}
