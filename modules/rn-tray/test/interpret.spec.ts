import { describe, expect, it } from 'vitest';
import { interpretTraySelection } from '../js/menu';

describe('interpretTraySelection', () => {
  it('maps menu ids onto typed actions', () => {
    expect(interpretTraySelection('send:abc')).toEqual({ kind: 'send', deviceId: 'abc' });
    expect(interpretTraySelection('transfer:t1')).toEqual({ kind: 'transfer', transferId: 't1' });
    expect(interpretTraySelection('dashboard')).toEqual({ kind: 'dashboard' });
    expect(interpretTraySelection('quit')).toEqual({ kind: 'quit' });
  });

  it('returns null for unknown ids', () => {
    expect(interpretTraySelection('nope')).toBeNull();
  });
});
