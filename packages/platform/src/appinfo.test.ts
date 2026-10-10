import { describe, expect, it, vi } from 'vitest';
import { formatAppInfo, readAppInfo } from './appinfo';

const unknown = { version: 'unknown', build: 'unknown' };

describe('readAppInfo', () => {
  it('returns the strings that the native module supplies', async () => {
    const source = { appInfo: vi.fn(async () => '{"version":"0.1.0","build":"7"}') };
    await expect(readAppInfo(source)).resolves.toEqual({ version: '0.1.0', build: '7' });
  });

  it('returns unknown when no module is registered', async () => {
    await expect(readAppInfo(null)).resolves.toEqual(unknown);
    await expect(readAppInfo(undefined)).resolves.toEqual(unknown);
  });

  it('returns unknown when the native call rejects', async () => {
    const source = { appInfo: vi.fn(async () => Promise.reject(new Error('E_APPINFO'))) };
    await expect(readAppInfo(source)).resolves.toEqual(unknown);
  });

  it('returns unknown for JSON that is not an object', async () => {
    for (const raw of ['', '{bad', 'null', '42', '[]']) {
      await expect(readAppInfo({ appInfo: async () => raw })).resolves.toEqual(unknown);
    }
  });

  it('replaces an empty or non-string field with unknown, one field at a time', async () => {
    const source = { appInfo: async () => '{"version":"","build":9}' };
    await expect(readAppInfo(source)).resolves.toEqual(unknown);
    const half = { appInfo: async () => '{"version":"0.1.0"}' };
    await expect(readAppInfo(half)).resolves.toEqual({ version: '0.1.0', build: 'unknown' });
  });
});

describe('formatAppInfo', () => {
  it('uses the design format', () => {
    expect(formatAppInfo({ version: '0.1.0', build: '1' })).toBe('Version 0.1.0 (build 1)');
  });
});
