import { generateQr, PAIRING_QR_SIZE, pairingBundle, scanQr } from '@daak/platform';
import { fakeEngine } from '@daak/ui';
import { armHostPairing, hostPairingQr, joinWithScan, parsePairingPayload } from '../pairing';

jest.mock('@daak/platform', () => ({
  scanQr: jest.fn(),
  generateQr: jest.fn(),
  pairingBundle: jest.fn(),
  PAIRING_QR_SIZE: 512,
}));

const mockedScan = jest.mocked(scanQr);
const mockedGenerate = jest.mocked(generateQr);
const mockedBundle = jest.mocked(pairingBundle);

// fakeEngine's only device, so a well-formed scan really could pair with it.
const PEER = 'aa'.repeat(16);
const SCANNED = JSON.stringify({ cbor: 'aabbcc', name: 'Pixel 9', device_id: PEER });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('joinWithScan', () => {
  // R88: the secret is the bundle CBOR as hex, NOT the whole scanned payload.
  it('pairs with the parsed cbor hex, never the raw scan payload', async () => {
    const engine = fakeEngine();
    const pair = jest.spyOn(engine, 'pair').mockResolvedValue({ sas: '123456' });
    mockedScan.mockResolvedValue(SCANNED);

    await expect(joinWithScan(engine)).resolves.toEqual({ sas: '123456' });
    // The fourth argument is the bundle's optional address. SCANNED has none,
    // so the joiner falls back to discovery. A host on loopback only and an
    // older link both land here.
    expect(pair).toHaveBeenCalledWith(PEER, 'qr', 'aabbcc', undefined);
  });

  it('rejects a non-JSON scan without calling pair', async () => {
    const engine = fakeEngine();
    const pair = jest.spyOn(engine, 'pair');
    mockedScan.mockResolvedValue('not-json');

    await expect(joinWithScan(engine)).rejects.toThrow();
    expect(pair).not.toHaveBeenCalled();
  });

  it('rejects a payload missing cbor or device_id without calling pair', async () => {
    const engine = fakeEngine();
    const pair = jest.spyOn(engine, 'pair');
    mockedScan.mockResolvedValue(JSON.stringify({ name: 'x', device_id: PEER }));
    await expect(joinWithScan(engine)).rejects.toThrow();
    mockedScan.mockResolvedValue(JSON.stringify({ cbor: 'aa', name: 'x' }));
    await expect(joinWithScan(engine)).rejects.toThrow();
    expect(pair).not.toHaveBeenCalled();
  });

  it('rejects a device_id that is not 32 hex chars', async () => {
    const engine = fakeEngine();
    const pair = jest.spyOn(engine, 'pair');
    mockedScan.mockResolvedValue(JSON.stringify({ cbor: 'aa', name: 'x', device_id: 'zz' }));
    await expect(joinWithScan(engine)).rejects.toThrow();
    expect(pair).not.toHaveBeenCalled();
  });
});

describe('hostPairingQr', () => {
  it('renders the host bundle as a 512px QR and returns both', async () => {
    const bundle = JSON.stringify({ cbor: 'bb', name: 'me', device_id: 'bb'.repeat(16) });
    mockedBundle.mockResolvedValue(bundle);
    mockedGenerate.mockResolvedValue('data:image/png;base64,AAAA');

    await expect(hostPairingQr()).resolves.toEqual({
      uri: 'data:image/png;base64,AAAA',
      bundle,
    });
    expect(mockedBundle).toHaveBeenCalledTimes(1);
    expect(mockedGenerate).toHaveBeenCalledWith(bundle, PAIRING_QR_SIZE);
  });
});

describe('armHostPairing (C2)', () => {
  // Second review: the host does NOT hold the joiner's bundle, because in the
  // QR flow only the JOINER scans. So this arms with no argument and NO camera.
  // The previous version scanned for a bundle no real device can display, which
  // is why host-side pairing was unreachable however green the tests were.
  it('arms the engine with no bundle and never opens the camera', async () => {
    const engine = fakeEngine();
    const armHostPairingSpy = jest.spyOn(engine, 'armHostPairing');

    await armHostPairing(engine);
    expect(armHostPairingSpy).toHaveBeenCalledWith();
    expect(mockedScan).not.toHaveBeenCalled();
  });

  it('propagates an engine failure so the flow can show it', async () => {
    const engine = fakeEngine();
    jest.spyOn(engine, 'armHostPairing').mockRejectedValue(new Error('engine down'));

    await expect(armHostPairing(engine)).rejects.toThrow('engine down');
    expect(mockedScan).not.toHaveBeenCalled();
  });
});

describe('parsePairingPayload', () => {
  it('is a pure function returning { deviceId, cbor }', () => {
    expect(parsePairingPayload(SCANNED)).toEqual({ deviceId: PEER, cbor: 'aabbcc' });
  });

  it('rejects a JSON array or scalar', () => {
    expect(() => parsePairingPayload('[1]')).toThrow();
    expect(() => parsePairingPayload('42')).toThrow();
    expect(() => parsePairingPayload('null')).toThrow();
  });

  // R42c: the host puts its own address in the bundle, and the joiner must
  // pass it through. Without it the joiner resolves the host from discovery,
  // which fails on any network mDNS does not cross -- measured on a NAT-ed
  // Android emulator that saw zero peers while unicast reached the host.
  it('carries the host address through to the engine', async () => {
    const engine = fakeEngine();
    const pair = jest.spyOn(engine, 'pair').mockResolvedValue({ sas: '123456' });
    mockedScan.mockResolvedValue(
      JSON.stringify({ cbor: 'aabbcc', name: 'Pixel 9', device_id: PEER, addr: '192.168.0.226:5199' }),
    );

    await joinWithScan(engine);
    expect(pair).toHaveBeenCalledWith(PEER, 'qr', 'aabbcc', '192.168.0.226:5199');
  });

  // A malformed address must not reach the dialer as a string the engine
  // cannot parse. Failing here beats an error the user cannot act on.
  it('rejects a malformed address rather than passing it to the dialer', () => {
    expect(() =>
      parsePairingPayload(
        JSON.stringify({ cbor: 'aabbcc', name: 'x', device_id: PEER, addr: 'not-an-addr' }),
      ),
    ).toThrow();
  });
});
