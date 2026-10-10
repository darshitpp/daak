import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { WelcomeScreen } from './WelcomeScreen';

// The design prints one set of words for iPhone, Android, and macOS
// (index.html, android.html, macos.html). The screen has no copy prop.
describe('Welcome', () => {
  it('shows the words of the design', () => {
    render(<WelcomeScreen onGetStarted={() => {}} onSkip={() => {}} />);
    expect(screen.getByText('Send anything to a phone next door')).toBeTruthy();
    expect(
      screen.getByText(
        'Photos, videos, documents and text go straight to another device on the same Wi-Fi. Nothing leaves your home network.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Three things to know')).toBeTruthy();
    expect(screen.getByText('No account, no sign-in, no email.')).toBeTruthy();
    expect(screen.getByText('Nothing is stored in the cloud.')).toBeTruthy();
    expect(screen.getByText('Only one device reads what you send.')).toBeTruthy();
    expect(screen.getByText('It works offline')).toBeTruthy();
    expect(screen.getByText('You never need the internet. Just the Wi-Fi you are on right now.')).toBeTruthy();
  });

  it('shows the wordmark', () => {
    render(<WelcomeScreen onGetStarted={() => {}} onSkip={() => {}} />);
    expect(screen.getByLabelText('Daak')).toBeTruthy();
  });

  it('runs both exits', () => {
    const started = jest.fn();
    const skip = jest.fn();
    render(<WelcomeScreen onGetStarted={started} onSkip={skip} />);
    expect(screen.getByText('Get started')).toBeTruthy();
    expect(screen.getByText('I already set this up')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('welcome-get-started'));
    fireEvent.press(screen.getByLabelText('welcome-skip'));
    expect(started).toHaveBeenCalledTimes(1);
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it('shows none of the old platform words', () => {
    render(<WelcomeScreen onGetStarted={() => {}} onSkip={() => {}} />);
    for (const gone of [
      'Send photos, files, and text',
      'Send a file to the room next door',
      'I already paired this phone',
      'Look around first',
      'Works with the internet off',
    ]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });
});

