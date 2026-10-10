import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { WelcomeScreen } from './WelcomeScreen';

/**
 * THE WELCOME SCREEN'S PER-PLATFORM COPY CONTRACT.
 *
 * WHY THIS IS ITS OWN FILE. The cases belong to the Welcome block of
 * OnboardingScreens.test.tsx, but that file also imports CantReachScreen and
 * UpdateRequiredScreen, and those are still untracked work from an earlier
 * session. Putting these cases there would have meant committing a suite for
 * three screens that have nothing to do with this change. A file per screen is
 * the same shape the rest of this package already uses.
 *
 * WHAT IS BEING PINNED. The Open Design project holds four surfaces and the
 * three onboarding shells disagree about every line of this screen. The
 * difference must arrive as data, because packages/ui is locked to zero
 * platform conditionals. These cases prove the prop is honoured field by
 * field, that `null` omits a block, and that a caller which passes nothing
 * still gets the words the screen shipped with.
 */

describe('the welcome copy contract', () => {
  // The iPhone reference. Every field differs from the default, so this one
  // case pins the whole shape and, with it, that a replaced field leaves no
  // default text behind.
  it('takes the whole copy from its caller, field by field', () => {
    render(
      <WelcomeScreen
        onGetStarted={() => {}}
        onSkip={() => {}}
        copy={{
          heading: 'Send anything to a phone next door',
          lead: 'Photos, videos, documents and text go straight to another device on the same Wi-Fi.',
          bulletsTitle: 'Three things to know',
          bullets: [
            'No account, no sign-in, no email.',
            'Nothing is stored in the cloud.',
            'Only one device reads what you send.',
          ],
          note: {
            title: 'It works offline',
            body: 'You never need the internet. Just the Wi-Fi you are on right now.',
          },
          skipLabel: 'I already set this up',
        }}
      />,
    );
    expect(screen.getByText('Send anything to a phone next door')).toBeTruthy();
    expect(screen.getByText('No account, no sign-in, no email.')).toBeTruthy();
    expect(screen.getByText('It works offline')).toBeTruthy();
    // A field the caller replaces must leave no default text behind.
    expect(screen.queryByText('Send photos, files, and text')).toBeNull();
    expect(screen.queryByText('No account, no sign-up, no cloud.')).toBeNull();
    expect(screen.queryByText('Works with the internet off')).toBeNull();
  });

  it('labels the second exit from the caller copy', () => {
    render(
      <WelcomeScreen
        onGetStarted={() => {}}
        onSkip={() => {}}
        copy={{ skipLabel: 'Look around first' }}
      />,
    );
    expect(screen.getByText('Look around first')).toBeTruthy();
    expect(screen.queryByText('I already paired this phone')).toBeNull();
  });

  // The macOS reference drops the card entirely. A per-field contract cannot
  // express that with three empty bullets, so the card needs an explicit off
  // switch, and `null` has to mean absent rather than "use the default".
  it('drops the three-things card when the caller sets it to null', () => {
    render(
      <WelcomeScreen
        onGetStarted={() => {}}
        onSkip={() => {}}
        copy={{ bulletsTitle: null, bullets: null }}
      />,
    );
    expect(screen.queryByText('Three things to know')).toBeNull();
    expect(screen.queryByText('Both devices sit on the same Wi-Fi.')).toBeNull();
    // Everything else still renders: dropping the card must not blank the
    // screen.
    expect(screen.getByText('Send photos, files, and text')).toBeTruthy();
  });

  // The macOS note is ONE sentence. `Note` renders a body line
  // unconditionally, so a note with no body is how that surface says its
  // sentence, and it must not leave a stray empty row.
  it('renders a note that has a title and no body', () => {
    render(
      <WelcomeScreen
        onGetStarted={() => {}}
        onSkip={() => {}}
        copy={{ note: { title: 'No internet, no sign-up, no waiting.', body: '' } }}
      />,
    );
    expect(screen.getByText('No internet, no sign-up, no waiting.')).toBeTruthy();
  });

  it('omits the note when the caller sets it to null', () => {
    render(
      <WelcomeScreen
        onGetStarted={() => {}}
        onSkip={() => {}}
        copy={{ note: null }}
      />,
    );
    expect(screen.queryByText('Works with the internet off')).toBeNull();
    expect(screen.queryByText(/Airplane mode is fine/)).toBeNull();
  });

  // The macOS reference has no wordmark on this screen: its sidebar already
  // carries one, and the prototype notes that showing it twice read as a bug.
  it('omits the wordmark when the caller sets wordmark to false', () => {
    render(
      <WelcomeScreen
        onGetStarted={() => {}}
        onSkip={() => {}}
        copy={{ wordmark: false }}
      />,
    );
    expect(screen.queryByLabelText('Daak')).toBeNull();
  });

  // The per-field fallback, which is what makes the whole contract safe: a
  // caller that passes one field must not lose the other five.
  it('keeps every default field when the caller passes no copy at all', () => {
    render(<WelcomeScreen onGetStarted={() => {}} onSkip={() => {}} />);
    expect(screen.getByText('Send photos, files, and text')).toBeTruthy();
    expect(screen.getByText('Three things to know')).toBeTruthy();
    expect(screen.getByText('Works with the internet off')).toBeTruthy();
    expect(screen.getByText('I already paired this phone')).toBeTruthy();
  });
});

describe('the welcome wordmark', () => {
  it('shows the mark and the letters aak by default', () => {
    render(<WelcomeScreen onGetStarted={() => {}} onSkip={() => {}} />);
    expect(screen.getByTestId('wordmark-mark')).toBeTruthy();
    expect(screen.getByText('aak')).toBeTruthy();
  });

  it('omits the wordmark when the copy sets wordmark to false', () => {
    render(<WelcomeScreen onGetStarted={() => {}} onSkip={() => {}} copy={{ wordmark: false }} />);
    expect(screen.queryByTestId('wordmark-mark')).toBeNull();
  });
});

