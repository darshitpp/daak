import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { mockPlatformHost } from '../testPlatformMock';
import App from '../App';

// The thread's picker is INJECTED, and the injection point is
// apps/mobile/src/SendFlow.tsx -- the one module in the app that is allowed to
// import @daak/platform for it. If that import, or the prop that carries it,
// ever goes missing, "Add files" renders exactly as it does when it works and
// the tap does nothing. The picker's own behaviour is
// packages/platform/src/share.test.ts's, and sendAndTransfersRoute.test.tsx
// covers the shell's use of an injected function with a local stub -- neither
// drives the real injection point, which is what this does.
jest.mock('@daak/platform', () =>
  mockPlatformHost({ pickFiles: jest.fn(async () => ['/Users/d/Documents/a.pdf']) }),
);

jest.mock('../BackgroundSyncNotice', () => ({
  BackgroundSyncNotice: () => null,
}));
jest.mock('../PairingFlow', () => ({
  PairingFlow: () => null,
}));
jest.mock('../bootstrap', () => ({
  engine: jest.requireActual('@daak/ui').fakeEngine(),
  startEngine: async () => {},
  startEngineOnce: jest.fn(async () => {}),
  drainInbound: jest.fn(async () => {}),
  wireNotificationActions: jest.fn(() => () => {}),
  sendIntentItems: jest.fn(async () => {}),
  // The peer.incompatible fan-out off the ONE engine subscription. Every file
  // that renders App needs it: the import is undefined without it, and the
  // mount effect throws before the shell renders at all.
  onIncompatiblePeer: jest.fn(() => () => {}),
  postReceiveNotifications: jest.fn(async () => true),
  notificationGrant: jest.fn(() => true),
  recordNotificationGrant: jest.fn(),
}));

const { engine } = jest.requireMock('../bootstrap');
const { pickFiles } = jest.requireMock('@daak/platform');

beforeEach(() => {
  jest.clearAllMocks();
});

// THE claim is that a TAP reaches the TurboModule. `toBeDefined` cannot carry
// it -- that holds for any function, called or not, and passed while the tap went
// nowhere. So: assert nothing has called it before the tap (the control is real,
// not already fired at mount), then the exact call the tap produces, then the
// answer coming back out to the screen.
it('reaches the platform picker from a tap on Add files', async () => {
  const pixel = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001', online: true, presence: 'online' as const, paired: true };
  jest.spyOn(engine, 'devices').mockResolvedValue([pixel]);
  render(<App />);
  fireEvent.press(await screen.findByTestId('open-' + pixel.deviceId));
  await waitFor(() => expect(screen.getByTestId('pick-files')).toBeTruthy());
  expect(pickFiles).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('pick-files'));
  // And what the picker returned has to reach the composer -- a picker that
  // resolved into a void is exactly what a broken TurboModule looks like here.
  await waitFor(() => expect(screen.getByText('a.pdf')).toBeTruthy());
  // The TurboModule itself, with the argument the composer needs. `true` =
  // multiple, so the user can select a batch.
  expect(pickFiles).toHaveBeenCalledWith(true);
});

// No Xcode on this host, so the macOS sheet anchor is pinned at the SOURCE
// level -- the same discipline hostArmSwift.test.ts and qrScanner.test.ts hold
// over their native files. Comments are stripped first (R95): this file explains
// these exact identifiers at length, and an unstripped assertion is satisfied by
// the prose rather than the code.
describe('macOS pickDocuments only sheets onto a window that is on screen', () => {
  const code = readFileSync(
    join(__dirname, '..', '..', '..', '..', 'modules', 'rn-share', 'macos', 'RNShare.mm'),
    'utf8',
  ).replace(/\/\/.*$/gm, '');
  const method = code.slice(code.indexOf('RCT_EXPORT_METHOD(pickDocuments'));

  it('requires the window itself to be visible, not just the tray anchor', () => {
    // The bug: `anchorView != nil || window.isVisible` is satisfied by the tray
    // button the moment the tray is installed, so `window` may still be an
    // ordered-out NSApp.mainWindow -- this app's normal LSUIElement state -- and
    // beginSheetModalForWindow: throws NSInvalidArgumentException on the first
    // "Add files" click. The fix gates the sheet arm on window.isVisible alone.
    expect(method).toMatch(/if\s*\(window\s*!=\s*nil\s*&&\s*window\.isVisible\)/);
    // And no arm may be reachable by the tray anchor alone, in either order.
    expect(method).not.toMatch(/anchorView\s*!=\s*nil\s*\|\|\s*window\.isVisible/);
    expect(method).not.toMatch(/window\.isVisible\s*\|\|\s*anchorView\s*!=\s*nil/);
  });

  it('still answers with no window, by falling through to runModal', () => {
    // share() rejects the no-window case because a share sheet needs an anchor.
    // A picker has to WORK without one, so pickDocuments must not have grown a
    // reject: it falls through to runModal, which reads its own result.
    expect(method).toContain('runModal');
    expect(method).not.toContain('reject(');
  });
});
