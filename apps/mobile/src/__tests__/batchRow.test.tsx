import { batchHost } from '../SendFlow';

// batchDriver() throws NOT_READY before the engine builds the driver. The
// thread screen must not crash in that time.
jest.mock('@daak/platform', () => ({}));
const mockDriver = jest.fn();
jest.mock('../bootstrap', () => ({
  batchDriver: () => mockDriver(),
  onBatchChange: jest.fn(),
}));

describe('batchHost', () => {
  it('the host status returns null when the driver is not ready (NOT_READY)', () => {
    mockDriver.mockImplementation(() => { throw new Error('NOT_READY'); });
    expect(batchHost.status('aa')).toBeNull();
  });

  it('the host status returns the driver status when the driver is ready', () => {
    const st = { share: 'x', batch: 1, of: 2, paused: false, remaining: 1, bytesDone: 0, bytesTotal: 1 };
    mockDriver.mockImplementation(() => ({ status: (id: string) => (id === 'aa' ? st : null) }));
    expect(batchHost.status('aa')).toBe(st);
  });

  it('the host status does not hide an error other than NOT_READY', () => {
    mockDriver.mockImplementation(() => { throw new Error('BOOM'); });
    expect(() => batchHost.status('aa')).toThrow('BOOM');
  });
});
