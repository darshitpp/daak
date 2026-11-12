import { describe, expect, it } from 'vitest';
import { describePlatform } from './deviceinfo';

describe('describePlatform', () => {
  it('names the Android release, the API level, and the model', () => {
    const out = describePlatform({
      OS: 'android',
      Version: 36,
      constants: { Release: '16', Manufacturer: 'Acme', Model: 'Phone X1', reactNativeVersion: { major: 0, minor: 76, patch: 1 } },
    });
    expect(out).toBe('os: android 16 (API 36)\ndevice: Acme Phone X1\nreact_native: 0.76.1\n');
  });

  it('names the Apple system and the idiom', () => {
    const out = describePlatform({ OS: 'ios', Version: '27.0', constants: { systemName: 'iOS', interfaceIdiom: 'phone' } });
    expect(out).toBe('os: iOS 27.0\ndevice: phone\n');
  });

  it('gives only the OS line when the constants are empty, and never throws', () => {
    expect(describePlatform({ OS: 'macos', Version: '15.1' })).toBe('os: macos 15.1\n');
    expect(describePlatform({ OS: 'ios', Version: '1', constants: { get systemName(): string { throw new Error('x'); } } })).toBe('');
  });
});
