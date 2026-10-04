/**
 * The welcome screen's copy, per platform.
 *
 * WHY THIS FILE EXISTS. The Open Design project holds FOUR surfaces and the
 * three onboarding shells do not agree about the welcome screen:
 *
 * - Iphone.jsx says "Send anything to a phone next door" and exits with
 *   "I already set this up".
 * - Android.jsx says "Send photos, files, and text" and exits with "I already
 *   paired this phone".
 * - Macos.jsx says "Send a file to the room next door", carries an eyebrow, has
 *   NO three-things card, and exits with "Look around first".
 *
 * packages/ui is locked to zero platform conditionals, so the divergence
 * cannot be a branch inside the shared screen. It arrives as data. The screen
 * in packages/ui owns the DEFAULTS, which are the Android words, because that
 * is the surface its defaults were written for; this file owns the two sets
 * that differ.
 *
 * The design project is READ-ONLY and is not part of this repository, so the
 * exact strings live here and are pinned by onboarding-copy.test.ts. A change
 * to a string above is a change to the design, not a refactor.
 */

/**
 * The shape of the copy the welcome screen takes. Declared locally rather than
 * imported from @daak/ui, for the reason permission-rows.ts gives: @daak/ui
 * depends on @daak/core and nothing else, and importing upward is the
 * inversion this project has avoided throughout. The two shapes must stay
 * structurally identical, which the shared screen's own tests enforce.
 */
export interface WelcomeCopy {
  heading?: string;
  lead?: string;
  /** null drops the card together with `bullets`. */
  bulletsTitle?: string | null;
  /** null drops the card. */
  bullets?: string[] | null;
  /** null drops the note entirely. */
  note?: { title?: string; body: string } | null;
  primaryLabel?: string;
  skipLabel?: string;
  eyebrow?: string;
  /** false omits the wordmark; the macOS sidebar already carries it. */
  wordmark?: boolean;
}

/**
 * Picks the welcome copy for the running platform.
 *
 * The branch lives HERE and not in packages/ui, because packages/ui is locked
 * to zero platform conditionals and this is the one place where the platform
 * decision is genuinely a platform decision. The default is Android, which is
 * also the shared screen's own default, so an unrecognised value renders the
 * words the screen already shipped with rather than an error.
 */
export function welcomeCopyFor(os: 'ios' | 'android' | string | undefined): WelcomeCopy {
  return os === 'ios' ? IOS_WELCOME_COPY : ANDROID_WELCOME_COPY;
}

/**
 * Android is where the shared screen's defaults came from, so Android passes
 * NOTHING. This constant exists so a caller reads the same three-name pattern
 * on all three platforms, and so the test can assert the invariant that Android
 * adds no words of its own.
 */
export const ANDROID_WELCOME_COPY: WelcomeCopy = {};

/** The iPhone reference's words. */
export const IOS_WELCOME_COPY: WelcomeCopy = {
  heading: 'Send anything to a phone next door',
  lead:
    'Photos, videos, documents and text go straight to another device on the same Wi-Fi. Nothing leaves your home network.',
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
};

/**
 * The macOS reference's words.
 *
 * `bullets: null` is the load-bearing part. The Mac welcome has no card, and a
 * Mac user shown "No account, no sign-up, no cloud" is reading the phone's
 * three promises on a machine that never had them.
 *
 * The note body is an empty string, not omitted. `Note` renders a body line
 * unconditionally, so an omitted body renders a title and a blank row. The Mac
 * reference's note is one sentence, so that sentence is the title.
 */
export const MACOS_WELCOME_COPY: WelcomeCopy = {
  eyebrow: 'Welcome',
  heading: 'Send a file to the room next door',
  lead:
    'Photos, videos, documents and text go straight to another device on the same Wi-Fi. Nothing leaves your home network, and no account is needed.',
  bulletsTitle: null,
  bullets: null,
  note: { title: 'No internet, no sign-up, no waiting.', body: '' },
  skipLabel: 'Look around first',
  wordmark: false,
};
