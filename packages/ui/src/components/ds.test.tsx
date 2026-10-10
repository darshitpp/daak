import React from 'react';
import { render, screen } from '@testing-library/react-native';
import type { DeviceInfo } from '@daak/core';
import { Status, byPresence, deviceLabel, presenceOf } from './ds';

const base = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '' };

describe('presenceOf', () => {
  it('maps the three engine states to the design words', () => {
    expect(presenceOf({ presence: 'online', online: true })).toMatchObject({ tone: 'ok', label: 'On this network', rank: 0 });
    expect(presenceOf({ presence: 'away', online: true })).toMatchObject({ tone: 'warn', label: 'Away', rank: 1 });
    expect(presenceOf({ presence: 'offline', online: false })).toMatchObject({ tone: 'off', label: 'Not on this network', rank: 2 });
  });

  // `away` has online === true, so a reader of `online` alone would call it
  // "On this network". `presence` must win.
  it('lets presence win over the online flag', () => {
    expect(presenceOf({ presence: 'away', online: true }).label).toBe('Away');
  });

  // A daemon that predates P1 sends no presence. The old three-way reading stays.
  it('falls back to the online flag when presence is absent', () => {
    expect(presenceOf({ online: true })).toMatchObject({ tone: 'ok', rank: 0 });
    expect(presenceOf({ online: false })).toMatchObject({ tone: 'off', rank: 2 });
    expect(presenceOf({})).toMatchObject({ tone: 'warn', label: 'Ready when connected', rank: 3 });
  });
});

describe('byPresence', () => {
  it('sorts online, then away, then offline, then by name', () => {
    const mk = (name: string, presence: DeviceInfo['presence']): DeviceInfo => ({ ...base, deviceId: name, name, presence });
    const list = [mk('Zed', 'offline'), mk('Bea', 'away'), mk('Cy', 'online'), mk('Al', 'online'), mk('Di', 'offline')];
    expect([...list].sort(byPresence).map((d) => d.name)).toEqual(['Al', 'Cy', 'Bea', 'Di', 'Zed']);
  });
});

describe('deviceLabel', () => {
  // P1: a paired device with no label has name ''. The UI must not show a blank row.
  it('names a device with an empty or blank name by its id prefix', () => {
    expect(deviceLabel({ deviceId: 'abcdef0123456789abcdef0123456789', name: '' })).toBe('Device abcdef01');
    expect(deviceLabel({ deviceId: 'abcdef0123456789abcdef0123456789', name: '   ' })).toBe('Device abcdef01');
  });
  it('keeps a real name', () => {
    expect(deviceLabel({ deviceId: 'aa', name: ' Pixel 9 ' })).toBe('Pixel 9');
  });
});

describe('Status', () => {
  it('always carries the word, never the colour alone', () => {
    render(<Status tone="warn" label="Away" />);
    expect(screen.getByText('Away')).toBeTruthy();
  });
});

