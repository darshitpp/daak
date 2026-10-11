import { readFileSync } from 'fs';
import { join } from 'path';

// Field test 2026-10-11: the camera screen of the pairing scan had no way back.
//
//   iOS      a full-screen black view with no control at all. A camera that was
//            unavailable or denied rejected the promise and LEFT the view up.
//   Android  the system Back gesture worked, but nothing on screen said so.
//
// The fix is a visible Cancel on both, the same error code on both
// (E_SCAN_CANCELLED, which PairingFlow reads as "go back, no error"), and on iOS
// a dismissal on every error path.
//
// Source-level pin, the same discipline as iosOpenUrlDelegate.test.ts: no
// native test target runs here, and the screen shows only on a real device.
const read = (p: string) => readFileSync(join(__dirname, '../../../../modules/rn-qrscanner', p), 'utf8');

// Comment lines are stripped first, so an assertion is about the code and not the prose.
const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

describe('iOS scanner', () => {
  const vc = code(read('ios/ScannerViewController.swift'));
  const mod = code(read('ios/DaakQrScanner.swift'));

  it('draws a visible Cancel button that reports a cancellation', () => {
    expect(vc).toMatch(/UIButton/);
    expect(vc).toMatch(/"Cancel"/);
    expect(vc).toMatch(/onCancel/);
    // The session stops off the main thread, as startRunning starts off it.
    expect(vc).toMatch(/stopRunning/);
  });

  it('rejects with E_SCAN_CANCELLED after it dismisses, the code Android uses', () => {
    expect(mod).toMatch(/E_SCAN_CANCELLED/);
    expect(mod.indexOf('dismiss(animated: true)')).toBeGreaterThan(-1);
  });

  it('dismisses the camera screen when the camera is unavailable or denied', () => {
    // The old code rejected and left the black view up, with no way out.
    expect(mod).toMatch(/dismiss\(animated: true\)\s*\{\s*reject\("E_CAMERA"/);
    expect(vc).toMatch(/authorizationStatus\(for: \.video\)/);
    expect(vc).toMatch(/camera permission denied/);
  });
});

describe('Android scanner', () => {
  const act = code(read('android/src/main/java/dev/darshit/daak/qrscanner/ScannerActivity.kt'));

  it('puts a visible Cancel button over the preview', () => {
    expect(act).toMatch(/FrameLayout/);
    expect(act).toMatch(/Button\(this\)/);
    expect(act).toMatch(/"Cancel"/);
  });

  it('ends the activity as a cancellation when Cancel is pressed', () => {
    // RESULT_CANCELED with no EXTRA_ERROR is what the module maps to E_SCAN_CANCELLED.
    const click = act.slice(act.indexOf('setOnClickListener'));
    expect(click).toMatch(/RESULT_CANCELED/);
    expect(click).toMatch(/finish\(\)/);
    expect(click.slice(0, click.indexOf('finish()'))).not.toMatch(/EXTRA_ERROR/);
  });

  it('keeps the Cancel button out from under the status bar', () => {
    expect(act).toMatch(/WindowInsetsCompat/);
  });
});
