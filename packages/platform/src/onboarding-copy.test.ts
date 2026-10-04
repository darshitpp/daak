import { describe, expect, it } from 'vitest';

import {
  ANDROID_WELCOME_COPY,
  IOS_WELCOME_COPY,
  MACOS_WELCOME_COPY,
  welcomeCopyFor,
} from './onboarding-copy';

/**
 * The three Open Design references disagree about the welcome screen. These
 * pin the exact words of each one, so a later edit cannot quietly drift back
 * to the Android text on a Mac or an iPhone.
 *
 * The reference source of truth is the design project, which is read-only:
 *   src/platforms/Android.jsx  -- sc-welcome
 *   src/platforms/Iphone.jsx   -- welcome
 *   src/platforms/Macos.jsx    -- data-screen="welcome"
 */

describe('the iOS welcome copy', () => {
  it('uses the iPhone reference words, not the Android ones', () => {
    expect(IOS_WELCOME_COPY.heading).toBe('Send anything to a phone next door');
    expect(IOS_WELCOME_COPY.lead).toBe(
      'Photos, videos, documents and text go straight to another device on the same Wi-Fi. Nothing leaves your home network.',
    );
  });

  it('carries the iPhone three promises', () => {
    expect(IOS_WELCOME_COPY.bullets).toEqual([
      'No account, no sign-in, no email.',
      'Nothing is stored in the cloud.',
      'Only one device reads what you send.',
    ]);
  });

  it('says "It works offline", and exits with "I already set this up"', () => {
    expect(IOS_WELCOME_COPY.note).toEqual({
      title: 'It works offline',
      body: 'You never need the internet. Just the Wi-Fi you are on right now.',
    });
    expect(IOS_WELCOME_COPY.skipLabel).toBe('I already set this up');
  });
});

describe('the macOS welcome copy', () => {
  it('uses the macOS heading and lead', () => {
    expect(MACOS_WELCOME_COPY.heading).toBe('Send a file to the room next door');
    expect(MACOS_WELCOME_COPY.lead).toBe(
      'Photos, videos, documents and text go straight to another device on the same Wi-Fi. Nothing leaves your home network, and no account is needed.',
    );
  });

  // The macOS welcome has NO three-things card. Rendering an empty card, or
  // the Android bullets inside it, would put the phone's promises on a Mac.
  it('drops the three-things card entirely', () => {
    expect(MACOS_WELCOME_COPY.bulletsTitle).toBeNull();
    expect(MACOS_WELCOME_COPY.bullets).toBeNull();
  });

  // The macOS note is one line. Its title carries the whole sentence, so the
  // body must be an empty string rather than undefined, which would render a
  // title with no text under it in a component that expects a body.
  it('renders the note as a single line', () => {
    expect(MACOS_WELCOME_COPY.note).toEqual({
      title: 'No internet, no sign-up, no waiting.',
      body: '',
    });
  });

  it('has the eyebrow, no wordmark, and the "Look around first" exit', () => {
    expect(MACOS_WELCOME_COPY.eyebrow).toBe('Welcome');
    expect(MACOS_WELCOME_COPY.wordmark).toBe(false);
    expect(MACOS_WELCOME_COPY.skipLabel).toBe('Look around first');
  });
});

describe('the Android welcome copy', () => {
  // Android is the reference the shared screen's defaults came from, so its
  // constant must be the screen's defaults, not a second set of words.
  it('is what the shared screen already renders with no copy at all', () => {
    expect(ANDROID_WELCOME_COPY).toEqual({});
  });
});

describe('picking the copy for the running platform', () => {
  // The mobile app ships ONE bundle for both phones, so the copy cannot be
  // decided at build time. It is decided here, on the running platform.
  it('gives iOS the iPhone words', () => {
    expect(welcomeCopyFor('ios')).toBe(IOS_WELCOME_COPY);
  });

  it('gives Android the shared defaults', () => {
    expect(welcomeCopyFor('android')).toBe(ANDROID_WELCOME_COPY);
  });

  // An unknown or missing value must not throw and must not silently render
  // the phone's words on a platform that is neither. The defaults are the
  // words the shared screen already shipped, so this is the safe direction.
  it('falls back to the shared defaults for anything it does not know', () => {
    expect(welcomeCopyFor('windows')).toBe(ANDROID_WELCOME_COPY);
    expect(welcomeCopyFor(undefined)).toBe(ANDROID_WELCOME_COPY);
  });
});
