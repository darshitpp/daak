import React from 'react';
import { Text, View } from 'react-native';
import { Btn, Note, Wordmark } from '../components/ds';
import { Bullets, OnboardingScreen } from '../components/Onboarding';
import { ui } from '../theme';

/**
 * Platform copy overrides.
 *
 * The defaults are the ANDROID reference's words. The three references do not
 * agree, and the screen is shared:
 *
 * - iPhone: "Send anything to a phone next door", and a different set of three
 *   promises, and "I already set this up" for the second exit.
 * - Android: the defaults below.
 * - macOS: no three-things card at all, an eyebrow, and a one-line note.
 *
 * packages/ui must carry zero platform conditionals, so the difference cannot
 * be a branch here. It has to arrive as data from the app, the same way
 * NameDeviceScreen already takes its `copy`.
 *
 * Every field falls back per-field. `null` is meaningful where the reference
 * omits the block entirely: `bulletsTitle: null` with `bullets: null` drops
 * the card, and `note: null` drops the note. An empty string for a note body
 * renders the title alone, which is how the macOS one-line note is expressed.
 */
export interface WelcomeCopy {
  /** The screen's h1. */
  heading?: string;
  /** The paragraph under the heading. */
  lead?: string;
  /** The card's heading. Pass null to omit the card together with `bullets`. */
  bulletsTitle?: string | null;
  /** The card's three promises. Pass null to omit the card. */
  bullets?: string[] | null;
  /** The closing reassurance note. Pass null to omit it entirely. */
  note?: { title?: string; body: string } | null;
  /** The primary button's label. */
  primaryLabel?: string;
  /** The second exit's label. */
  skipLabel?: string;
  /** The macOS eyebrow above the heading. Omitted when unset. */
  eyebrow?: string;
  /** The wordmark. The macOS reference has none; the sidebar carries it. */
  wordmark?: boolean;
}

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
export function WelcomeScreen({ onGetStarted, onSkip, copy }: {
  onGetStarted: () => void;
  onSkip: () => void;
  /** Platform copy. Omitted on Android, which is where the defaults come from. */
  copy?: WelcomeCopy;
}) {
  const heading = copy?.heading ?? 'Send photos, files, and text';
  const lead = copy?.lead ??
    'Everything goes straight to another device in the same room, never through the internet.';
  const bulletsTitle = copy?.bulletsTitle === undefined ? 'Three things to know' : copy.bulletsTitle;
  const bullets = copy?.bullets === undefined
    ? [
        'Both devices sit on the same Wi-Fi.',
        'No account, no sign-up, no cloud.',
        'Files travel straight between the two devices.',
      ]
    : copy.bullets;
  const note = copy?.note === undefined
    ? { title: 'Works with the internet off', body: 'Airplane mode is fine. Only your own Wi-Fi is ever used.' }
    : copy.note;
  const primaryLabel = copy?.primaryLabel ?? 'Get started';
  const skipLabel = copy?.skipLabel ?? 'I already paired this phone';

  return (
    <OnboardingScreen
      testID="screen-welcome"
      actions={
        <>
          <Btn variant="primary" block label={primaryLabel} testID="welcome-get-started" onPress={onGetStarted} />
          <Btn variant="ghost" block label={skipLabel} testID="welcome-skip" onPress={onSkip} />
        </>
      }
    >
      {copy?.wordmark === false ? null : <Wordmark />}
      <View style={ui.stack}>
        {copy?.eyebrow === undefined ? null : <Text style={ui.kvK}>{copy.eyebrow}</Text>}
        <Text style={ui.h1}>{heading}</Text>
        <Text style={ui.lead}>{lead}</Text>
      </View>
      {bullets === null || bulletsTitle === null ? null : (
        <View style={ui.card}>
          {bulletsTitle === null ? null : <Text style={ui.h3}>{bulletsTitle}</Text>}
          <Bullets items={bullets} />
        </View>
      )}
      {note === null ? null : <Note title={note.title} body={note.body} />}
    </OnboardingScreen>
  );
}
