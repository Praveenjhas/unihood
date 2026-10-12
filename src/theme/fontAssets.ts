import { Fraunces_400Regular, Fraunces_500Medium, Fraunces_600SemiBold, Fraunces_700Bold } from '@expo-google-fonts/fraunces';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';

/**
 * The exact set of font files loaded at startup. Kept in one place so the
 * loaded weights always match the families referenced in `typography.ts`.
 *
 * Bundle size note: six static weights (~editorial display + UI) is a deliberate
 * trade-off — enough hierarchy to look art-directed, small enough to stay fast.
 */
export const fontAssets = {
  Fraunces_400Regular,
  Fraunces_500Medium,
  Fraunces_600SemiBold,
  Fraunces_700Bold,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
};
