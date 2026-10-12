import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, spacing } from '../theme';
import { Card } from './Card';

export interface SkeletonBlockProps {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Pulsing placeholder block.
 *
 * The pulse is a native-driver opacity loop, so it runs on the UI thread and
 * costs nothing while the mock query resolves.
 */
export function SkeletonBlock({ width = '100%', height = 14, radius = radii.xs, style }: SkeletonBlockProps) {
  // Created once via a lazy initialiser rather than `useRef(...).current`: a ref
  // read during render is exactly what the React Compiler lint rule forbids, and
  // the animated value is a render-time input here, not a mutable handle.
  const [opacity] = useState(() => new Animated.Value(0.55));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 640, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.55, duration: 640, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return <Animated.View style={[styles.block, { width, height, borderRadius: radius, opacity }, style]} />;
}

export interface ListSkeletonProps {
  rows?: number;
}

/**
 * Card-shaped skeleton rows used while a list query is loading. Mirrors the
 * real card layout (avatar, title, two meta lines) so nothing jumps on load.
 */
export function ListSkeleton({ rows = 3 }: ListSkeletonProps) {
  return (
    <View style={styles.list} accessibilityLabel="Loading content" accessibilityRole="progressbar">
      {Array.from({ length: rows }).map((_, index) => (
        <Card key={`skeleton-${index}`} style={styles.card}>
          <SkeletonBlock width={44} height={44} radius={radii.pill} />
          <View style={styles.lines}>
            <SkeletonBlock width="62%" height={14} />
            <SkeletonBlock width="88%" height={11} />
            <SkeletonBlock width="40%" height={11} />
          </View>
        </Card>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    backgroundColor: colors.surfaceMuted,
  },
  list: {
    gap: spacing.md,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  lines: {
    flex: 1,
    gap: spacing.sm,
  },
});
