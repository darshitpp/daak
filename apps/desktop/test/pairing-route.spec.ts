import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * macOS could not pair, so it could not send. The desktop engine runs
 * IN-PROCESS (apps/desktop/index.js builds it from @daak/platform/src/engine),
 * so `armHostPairing` already resolves on this platform -- InProcessEngine
 * forwards it to the native module. What was missing was the two halves that
 * make a user able to REACH it:
 *
 *  1. The QR renderer. @daak/rn-qrscanner ships ios/ and android/ sources and
 *     no macos/ one, so nothing on the desktop could turn a pairing bundle into
 *     a scannable image. generateQr() calls TurboModuleRegistry.getEnforcing
 *     at MODULE EVAL, so this fails the whole screen rather than one button.
 *  2. The route. AppShell renders `pair` only when a host passes that slot,
 *     and DaakUiApp has no `pair` prop at all, so the dashboard never had a
 *     place to draw it.
 *
 * Sending requires a `pairings` row (crates/daak-core/src/engine.rs, the
 * session connect closure), so a device that cannot pair can never deliver.
 * These four assertions are the ones that would have caught that.
 */
const DESKTOP = join(__dirname, '..');
const MODULE = join(DESKTOP, '..', '..', 'modules', 'rn-qrscanner');

describe('the desktop app can reach a real pairing flow', () => {
  it('renders a pairing QR on macOS', () => {
    const swift = readFileSync(join(MODULE, 'macos', 'DaakQrScanner.swift'), 'utf8');
    // CoreImage is the macOS spelling of the iOS generator, and the same
    // ERROR_CORRECTION level both mobile sides pin (packages/platform/src/qr.ts)
    // so one side can always read the other.
    expect(swift).toMatch(/CIQRCodeGenerator/);
    expect(swift).toMatch(/inputCorrectionLevel/);
    // A camera is NOT the desktop's job: the host SHOWS a code and the other
    // device scans it. Only generate() is wired.
    expect(swift).not.toMatch(/AVCaptureSession/);
  });

  it('has a podspec at the package root the CLI can see', () => {
    const spec = readFileSync(join(MODULE, 'DaakQrScanner.podspec'), 'utf8');
    expect(spec).toMatch(/s\.name\s*=\s*"DaakQrScanner"/);
    expect(spec).toMatch(/:ios\s*=>/);
    expect(spec).toMatch(/:osx\s*=>/);
    // Per-platform globs, NOT one s.source_files: the two halves do not compile
    // together (ios/ imports UIKit and AVFoundation, which macOS has no UIKit
    // in). guides.cocoapods.org calls this shape out as s.ios.source_files /
    // s.osx.source_files, and it is what DaakSecureStore's root spec already
    // does for the one-platform-same-code case.
    //
    // No leading slash on either directory: a leading path resolves against the
    // spec root again and the pod compiles zero sources.
    expect(spec).toMatch(/s\.ios\.source_files\s*=\s*"ios\/\*\*/);
    expect(spec).toMatch(/s\.osx\.source_files\s*=\s*"macos\/\*\*/);
  });

  it('is named explicitly in react-native.config.js', () => {
    const config = readFileSync(join(DESKTOP, 'react-native.config.js'), 'utf8');
    expect(config).toMatch(/'@daak\/rn-qrscanner'/);
    expect(config).toMatch(/join\(__dirname/);
  });

  it('threads a pair slot from the desktop shell to AppShell', () => {
    // DaakUiApp -> Dashboard -> AppShell. One hop per layer, because a slot
    // that stops half way is a slot that renders nothing.
    const app = readFileSync(join(DESKTOP, '..', '..', 'packages', 'ui', 'src', 'App.tsx'), 'utf8');
    expect(app).toMatch(/pair\?:/);

    const dashboard = readFileSync(
      join(DESKTOP, '..', '..', 'packages', 'ui', 'src', 'modes', 'Dashboard.tsx'),
      'utf8',
    );
    // `pair?:`, not `pair?=`: a TypeScript optional PROP is declared with a
    // colon. The original assertion asked for an equals sign, which no valid
    // prop declaration can contain, so it could never pass.
    expect(dashboard).toMatch(/pair\?:/);
    // Declared is not enough: the value must REACH AppShell, which is the only
    // component that renders it.
    expect(dashboard).toMatch(/pair=\{pair\}/);

    // The desktop shell is what actually supplies it.
    const shells = readFileSync(join(DESKTOP, 'src', 'shells.tsx'), 'utf8');
    expect(shells).toMatch(/pair=\{/);
  });
});
