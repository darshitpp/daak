import { readFileSync } from 'fs';
import { join } from 'path';

// A peer can only be discovered over the LAN. Both hosts gate that on a
// declaration, and neither declaration existed: AndroidManifest.xml held
// CHANGE_WIFI_MULTICAST_STATE but no Kotlin acquired the lock it authorises, so
// Android dropped every mDNS packet and the peer list stayed empty. iOS and
// macOS had neither NSBonjourServices nor NSLocalNetworkUsageDescription, so
// the system withheld LAN access. Result: both databases read pairings = 0 and
// no send could pass the engine gate. This pins all three.
const module = readFileSync(
  join(__dirname, '../../android/app/src/main/java/dev/darshit/daak/DaakModule.kt'),
  'utf8',
);
const manifest = readFileSync(
  join(__dirname, '../../android/app/src/main/AndroidManifest.xml'),
  'utf8',
);
const iosPlist = readFileSync(join(__dirname, '../../ios/Daak/Info.plist'), 'utf8');
const macPlist = readFileSync(
  join(__dirname, '../../../desktop/macos/Daak-macOS/Info.plist'),
  'utf8',
);

function startBody(): string {
  const start = module.indexOf('override fun start(');
  expect(start).toBeGreaterThan(-1);
  const end = module.indexOf('pairingBundle(', start);
  return module.slice(start, end);
}

describe('LAN discovery declarations', () => {
  it('declares the Android multicast permission', () => {
    expect(manifest).toContain('android.permission.CHANGE_WIFI_MULTICAST_STATE');
  });

  it('holds a multicast lock across the engine start', () => {
    expect(module).toMatch(/createMulticastLock\(/);
    expect(module).toMatch(/\.acquire\(\)/);
    // Acquired before e.start(): a browse packet dropped before the lock is
    // held is a peer the device never learns about.
    const body = startBody();
    expect(body.indexOf('acquireMulticastLock()')).toBeGreaterThan(-1);
    // The call, not the prose: the comment above it names e.start() too.
    expect(body.indexOf('acquireMulticastLock()')).toBeLessThan(
      body.indexOf('e.start(dir.absolutePath'),
    );
  });

  it('releases the multicast lock on shutdown', () => {
    expect(module).toMatch(/\.release\(\)/);
    expect(module).toMatch(/releaseMulticastLock\(\)/);
  });

  it('declares local network access on iOS and macOS', () => {
    for (const plist of [iosPlist, macPlist]) {
      expect(plist).toContain('<key>NSLocalNetworkUsageDescription</key>');
      expect(plist).toContain('<key>NSBonjourServices</key>');
      expect(plist).toContain('<string>_daak._tcp</string>');
    }
  });
});
