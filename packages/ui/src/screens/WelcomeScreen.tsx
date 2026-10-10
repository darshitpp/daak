import React from 'react';
import { Text, View } from 'react-native';
import { Btn, Note, Wordmark } from '../components/ds';
import { Bullets, OnboardingScreen } from '../components/Onboarding';
import { ui } from '../theme';

/**
 * The Welcome screen (design route `welcome`).
 *
 * The three design files print the same words, so the screen has no copy prop.
 * The old per-platform copy contract is gone.
 *
 * Both exits are real. `onGetStarted` goes to the name step. `onSkip` is the
 * host's own skip. A returning user has answered these questions already.
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
          <Btn variant="ghost" block label="I already set this up" testID="welcome-skip" onPress={onSkip} />
        </>
      }
    >
      <View style={ui.heroMark}>
        <Wordmark />
        <Text style={ui.h1}>Send anything to a phone next door</Text>
        <Text style={ui.lead}>
          Photos, videos, documents and text go straight to another device on the same Wi-Fi. Nothing leaves your home network.
        </Text>
      </View>
      <View style={ui.card}>
        <Text style={ui.h3}>Three things to know</Text>
        <Bullets
          items={[
            'No account, no sign-in, no email.',
            'Nothing is stored in the cloud.',
            'Only one device reads what you send.',
          ]}
        />
      </View>
      <Note title="It works offline" body="You never need the internet. Just the Wi-Fi you are on right now." />
    </OnboardingScreen>
  );
}

