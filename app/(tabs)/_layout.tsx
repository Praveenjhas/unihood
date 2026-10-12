import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router/js-tabs';
import { StyleSheet } from 'react-native';

import type { IoniconName } from '../../src/components';
import { colors, spacing, text } from '../../src/theme';

/**
 * Tab definitions. Order here is the order on screen: People first, because
 * discovery is the reason to open a campus social app.
 *
 * Icons are Ionicons outline (inactive) / filled (active) so the current tab is
 * readable without relying on colour alone.
 */
const TABS: readonly { name: string; label: string; icon: IoniconName; iconActive: IoniconName }[] = [
  { name: 'index', label: 'People', icon: 'people-outline', iconActive: 'people' },
  { name: 'groups', label: 'Groups', icon: 'grid-outline', iconActive: 'grid' },
  { name: 'events', label: 'Events', icon: 'calendar-outline', iconActive: 'calendar' },
  { name: 'profile', label: 'Profile', icon: 'person-outline', iconActive: 'person' },
];

/**
 * Bottom tab navigator.
 *
 * `expo-router/js-tabs` is imported explicitly: it is the cross-platform JS tab
 * bar, whereas the root `Tabs` export maps to the platform-native tab bar. The
 * JS bar is what the design needs here — the label styling below only exists on
 * that implementation.
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.ink,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: styles.tabBar,
        // Built from the type scale so tab labels stay in the design system.
        tabBarLabelStyle: {
          fontFamily: text.label.fontFamily,
          fontSize: text.label.fontSize,
          letterSpacing: text.label.letterSpacing,
        },
        tabBarItemStyle: styles.tabItem,
      }}
    >
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.label,
            tabBarLabel: tab.label,
            tabBarAccessibilityLabel: tab.label,
            tabBarIcon: ({ color, focused, size }) => (
              <Ionicons name={focused ? tab.iconActive : tab.icon} size={size ?? 22} color={color} />
            ),
          }}
        />
      ))}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  tabItem: {
    // A little top padding lifts the icon off the hairline border.
    paddingTop: spacing.xs,
  },
});
