import React from 'react';
import { Text, View } from 'react-native';
import { Btn, Note, Wordmark } from '../components/ds';
import { Bullets, OnboardingScreen } from '../components/Onboarding';
import { ui } from '../theme';

/**
 * The prototype's screen 1 (sc-welcome, data-screen="welcome").
 *
 * The copy is the prototype's, because the copy IS the design: "never through
 * the internet" and "no account, no sign-up, no cloud" are the three promises
 * the product rests on, and rewriting them would be re-deciding the
 * positioning rather than porting the screen.
 *
 * Two exits, both real. onGetStarted goes forward into naming. onSkip is the
 * prototype's "I already paired this phone" link, wired to the app's own
 * skip rather than invented here: a returning user has already answered these
 * questions and must not be made to answer them again.
 *
 * There is no appbar title, so OnboardingScreen renders none -- the
 * prototype's welcome appbar is the wordmark alone, which Hero renders.
 */
export function WelcomeScreen({ onGetStarted, onSkip }: {
  onGetStarted: () => void;
  onSkip: () => void;
}) {
  return (
    <OnboardingScreen
      testID="screen-welcome"
      actions={
        <>
          <Btn variant="primary" block label="Get started" testID="welcome-get-started" onPress={onGetStarted} />
          <Btn variant="ghost" block label="I already paired this phone" testID="welcome-skip" onPress={onSkip} />
        </>
      }
    >
      <Wordmark />
      <View style={ui.stack}>
        <Text style={ui.h1}>Send photos, files, and text</Text>
        <Text style={ui.lead}>
          Everything goes straight to another device in the same room, never through the internet.
        </Text>
      </View>
      <View style={ui.card}>
        <Text style={ui.h3}>Three things to know</Text>
        <Bullets
          items={[
            'Both devices sit on the same Wi-Fi.',
            'No account, no sign-up, no cloud.',
            'Files travel straight between the two devices.',
          ]}
        />
      </View>
      <Note
        title="Works with the internet off"
        body="Airplane mode is fine. Only your own Wi-Fi is ever used."
      />
    </OnboardingScreen>
  );
}
