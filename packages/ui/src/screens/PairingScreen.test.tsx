import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { PairingScreen } from './PairingScreen';

// Spec 3.3 Mode A is ONE QR and ONE scan: the host shows its QR, the joiner
// scans it. A joiner never displays a QR (hostPairingQr is wired only to the
// host branch), so a host-side SCAN control is a dead affordance -- there is
// nothing on the other device for it to read. The host arms from its own QR
// display instead, with no camera.
describe('PairingScreen', () => {
  const SAS = '112233';

  it('renders the QR and NO scan control for the host role', () => {
    const onScan = jest.fn();
    render(
      <PairingScreen role="host" qrUri="data:image/png;base64,QUJD" onScan={onScan} sas={SAS} />,
    );
    expect(screen.getByLabelText('pairing-qr')).toBeTruthy();
    // No camera on the host path. Neither label may exist, so the dead
    // affordance cannot come back under either name.
    expect(screen.queryByLabelText('scan-joiner')).toBeNull();
    expect(screen.queryByLabelText('scan')).toBeNull();
  });

  it('keeps the join role on the original scan affordance and renders no QR', () => {
    const onScan = jest.fn();
    render(<PairingScreen role="join" qrUri="" onScan={onScan} sas={SAS} />);
    expect(screen.queryByLabelText('pairing-qr')).toBeNull();
    expect(screen.queryByLabelText('scan-joiner')).toBeNull();
    fireEvent.press(screen.getByLabelText('scan'));
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('always shows the SAS', () => {
    render(<PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas={SAS} />);
    expect(screen.getByText(SAS)).toBeTruthy();
  });
});
