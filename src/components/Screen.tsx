import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, layout, spacing } from '../theme';

export interface ScreenProps {
  children: ReactNode;
  /** Wrap the content in a vertical ScrollView. Defaults to `true`. */
  scroll?: boolean;
  /**
   * Extra bottom padding, on top of the safe-area inset — used by screens that
   * reserve space for something below the scrolling content (e.g. a floating
   * bar). Prefer `footer` when the bar itself is part of the layout.
   */
  bottomPadding?: number;
  /**
   * Pinned below the scroll area, outside it: the join / RSVP action bars on the
   * detail screens. Because it lives on the page shell rather than inside the
   * scroller, it cannot scroll away or fight the content for space.
   */
  footer?: ReactNode;
  /** Skip the top safe-area inset (screens that render their own header art). */
  edgeToEdge?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  /**
   * Pull-to-refresh for the scroll area. Omitted means there is no refresh control
   * at all, which is the honest state for a screen whose content cannot change
   * underneath it (a form, an onboarding step).
   */
  onRefresh?: () => void;
  /** True while `onRefresh` is in flight: drives the spinner and owns its lifetime. */
  refreshing?: boolean;
}

/**
 * Page shell: paper background, safe-area aware, with the standard horizontal
 * page margin. Every screen goes through this so padding and background can
 * never drift from screen to screen.
 *
 * `ExpoRoot` (expo-router) already mounts the `SafeAreaProvider`, so the insets
 * read here are valid without an extra provider in the root layout.
 */
export function Screen({
  children,
  scroll = true,
  bottomPadding = 0,
  footer,
  edgeToEdge = false,
  contentStyle,
  onRefresh,
  refreshing,
}: ScreenProps) {
  const insets = useSafeAreaInsets();

  const containerStyle: StyleProp<ViewStyle> = [
    styles.container,
    { paddingTop: edgeToEdge ? 0 : insets.top },
    { paddingBottom: insets.bottom + bottomPadding },
  ];

  if (!scroll) {
    return (
      <View style={containerStyle}>
        <View style={[styles.content, styles.fill, contentStyle]}>{children}</View>
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </View>
    );
  }

  return (
    <View style={containerStyle}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.content, contentStyle]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing === true}
              onRefresh={onRefresh}
              // The palette has no blue and no spinner of its own colour, so the
              // one accent is what the indicator wears.
              tintColor={colors.olive}
              colors={[colors.olive]}
              progressBackgroundColor={colors.surface}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  fill: {
    flex: 1,
  },
  content: {
    // A little top breathing room so headings do not collide with the notch.
    paddingTop: spacing.md,
    paddingHorizontal: layout.screenPadding,
  },
  footer: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: layout.screenPadding,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
});
