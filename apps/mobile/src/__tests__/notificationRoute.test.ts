import { peerOfPayload } from '../notification-route';

describe('peerOfPayload', () => {
  it('reads the sender of an inbox entry', () => {
    expect(peerOfPayload(JSON.stringify({ peerDeviceId: 'ab'.repeat(16) }))).toBe('ab'.repeat(16));
  });
  it.each(['', 'not json', '[]', 'null', '{}', JSON.stringify({ peerDeviceId: 5 }), JSON.stringify({ peerDeviceId: 'zz' })])(
    'names nobody for %j',
    (payload) => {
      expect(peerOfPayload(payload)).toBeUndefined();
    },
  );
});

