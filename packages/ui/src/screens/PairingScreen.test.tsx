import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { PairingScreen } from './PairingScreen';

// Spec 3.3 Mode A is ONE QR and ONE scan: the host shows its QR, the joiner
// scans it. A joiner never displays a QR, so a host-side SCAN control would be
// a dead affordance. The host arms from its own QR display, with no camera.
describe('PairingScreen', () => {
  const SAS = '112233';
  const SHOWN = '112 233';

  it('renders the QR and NO scan control for the host role', () => {
    render(<PairingScreen role="host" qrUri="data:image/png;base64,QUJD" onScan={jest.fn()} sas={SAS} />);
    expect(screen.getByLabelText('pairing-qr')).toBeTruthy();
    expect(screen.queryByLabelText('scan-joiner')).toBeNull();
    expect(screen.queryByLabelText('scan')).toBeNull();
  });

  it('keeps the join role on the scan control and renders no QR', () => {
    const onScan = jest.fn();
    render(<PairingScreen role="join" qrUri="" onScan={onScan} sas={SAS} />);
    expect(screen.queryByLabelText('pairing-qr')).toBeNull();
    fireEvent.press(screen.getByLabelText('scan'));
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('offers a reject control only once a SAS is shown and a handler exists', () => {
    const onReject = jest.fn();
    const { rerender } = render(
      <PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas="" onReject={onReject} />,
    );
    expect(screen.queryByLabelText('reject')).toBeNull();
    rerender(<PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas={SAS} onReject={onReject} />);
    fireEvent.press(screen.getByLabelText('reject'));
    expect(onReject).toHaveBeenCalledTimes(1);
    rerender(<PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas={SAS} />);
    expect(screen.queryByLabelText('reject')).toBeNull();
  });

  // Commit 552459d. A new pairing is pending until the user confirms it.
  it('offers a confirm control only once a SAS is shown and a handler exists', () => {
    const onConfirm = jest.fn();
    const { rerender } = render(
      <PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas="" onConfirm={onConfirm} />,
    );
    expect(screen.queryByLabelText('confirm')).toBeNull();
    rerender(<PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas={SAS} onConfirm={onConfirm} />);
    fireEvent.press(screen.getByLabelText('confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    rerender(<PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas={SAS} />);
    expect(screen.queryByLabelText('confirm')).toBeNull();
  });

  it('drops its own appbar when a host is already drawing one', () => {
    render(<PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas={SAS} />);
    expect(screen.getByText('Pair a device')).toBeTruthy();
    const { unmount } = render(<PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas={SAS} embedded />);
    expect(screen.queryByText('Pair a device')).toBeNull();
    unmount();
  });

  it('keeps every control when embedded', () => {
    const onScan = jest.fn();
    render(<PairingScreen role="host" qrUri="data:image/png;base64,QUJD" onScan={onScan} sas={SAS} embedded />);
    expect(screen.getByLabelText('pairing-qr')).toBeTruthy();
    expect(screen.getByText(SHOWN)).toBeTruthy();
    const join = render(<PairingScreen role="join" qrUri="" onScan={onScan} sas={SAS} embedded />);
    fireEvent.press(screen.getAllByLabelText('scan')[0]);
    expect(onScan).toHaveBeenCalledTimes(1);
    join.unmount();
  });
});

describe('PairingScreen words of the design', () => {
  const noop = jest.fn();

  it('host: shows the heading, the QR hint, and the SAS sentence', () => {
    render(<PairingScreen role="host" qrUri="u" onScan={noop} sas="482917" />);
    expect(screen.getByText('Show this to the other device')).toBeTruthy();
    expect(screen.getByText('Point their camera at this square.')).toBeTruthy();
    expect(screen.getByText('Read this number out loud. Check it matches theirs.')).toBeTruthy();
    expect(screen.getByText('482 917')).toBeTruthy();
    expect(screen.getByText('Both devices need to be on the same Wi-Fi.')).toBeTruthy();
    expect(screen.queryByText('Read this out loud. Both screens must match.')).toBeNull();
  });

  // The design buttons are "They match" (confirms the pending pairing) and
  // "Does not match" (refuses it). See Ledger item 16.
  it('names the confirm button "They match" and the reject button "Does not match"', () => {
    render(
      <PairingScreen role="join" qrUri="" onScan={noop} sas="482917" onConfirm={noop} onReject={noop} />,
    );
    expect(screen.getByText('They match')).toBeTruthy();
    expect(screen.getByText('Does not match')).toBeTruthy();
    expect(screen.queryByText('Finish pairing')).toBeNull();
    expect(screen.queryByText('Does not match - remove')).toBeNull();
  });

  it('host: shows no SAS sentence before a SAS arrives', () => {
    render(<PairingScreen role="host" qrUri="u" onScan={noop} sas="" />);
    expect(screen.queryByText('Read this number out loud. Check it matches theirs.')).toBeNull();
    expect(screen.queryByText('Why check the numbers')).toBeNull();
  });

  // Review Focus 3. The number in the sentence is the number on the screen.
  it('host: the expander explains with the same grouped number, leading zeros kept', () => {
    render(<PairingScreen role="host" qrUri="u" onScan={noop} sas="004217" />);
    expect(screen.getByText('004 217')).toBeTruthy();
    expect(screen.getByText('Why check the numbers')).toBeTruthy();
    expect(screen.queryByTestId('pair-why')).toBeNull();
    fireEvent.press(screen.getByTestId('pair-why-toggle'));
    expect(screen.getByText('If both screens show 004 217, only your two devices are in the room.')).toBeTruthy();
  });

  it('host: shows a SAS that is not 6 digits as received', () => {
    render(<PairingScreen role="host" qrUri="u" onScan={noop} sas="12345" />);
    expect(screen.getByText('12345')).toBeTruthy();
  });

  it('host: shows "Making your code…" and no QR while the code is made', () => {
    render(<PairingScreen role="host" qrUri="" onScan={noop} sas="" busy="making" />);
    expect(screen.getByText('Making your code…')).toBeTruthy();
    expect(screen.queryByLabelText('pairing-qr')).toBeNull();
  });

  it('join: shows the heading and the hold-steady hint before a SAS', () => {
    render(<PairingScreen role="join" qrUri="" onScan={noop} sas="" />);
    expect(screen.getByText('Point the camera at their square')).toBeTruthy();
    expect(screen.getByText('Hold steady for a second.')).toBeTruthy();
  });

  it('join: shows "Reading their code…" and hides the hint while the code is read', () => {
    render(<PairingScreen role="join" qrUri="" onScan={noop} sas="" busy="reading" />);
    expect(screen.getByText('Reading their code…')).toBeTruthy();
    expect(screen.queryByText('Hold steady for a second.')).toBeNull();
  });

  it('join: shows the matching sentence and the grouped number, with no expander', () => {
    render(<PairingScreen role="join" qrUri="" onScan={noop} sas="482917" />);
    expect(screen.getByText('Their screen shows the same number. Check it matches yours.')).toBeTruthy();
    expect(screen.getByText('482 917')).toBeTruthy();
    expect(screen.queryByText('Why check the numbers')).toBeNull();
  });

  it('shows the design error title, keeps the real message, and runs Try again', () => {
    const retry = jest.fn();
    render(<PairingScreen role="join" qrUri="" onScan={noop} sas="" error="camera denied" onRetry={retry} />);
    expect(screen.getByText("We couldn't read that code.")).toBeTruthy();
    expect(screen.getByText(/Make sure their screen is showing the code, then try again\. camera denied/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText('pair-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows no QR when the host failed', () => {
    render(<PairingScreen role="host" qrUri="" onScan={noop} sas="" error="engine not started" onRetry={noop} />);
    expect(screen.queryByLabelText('pairing-qr')).toBeNull();
    expect(screen.getByText(/engine not started/)).toBeTruthy();
    // The host reads no code, so the joiner title does not fit.
    expect(screen.getByText("We couldn't make your code.")).toBeTruthy();
    expect(screen.queryByText("We couldn't read that code.")).toBeNull();
    expect(screen.getByText(/Make sure this device is on Wi-Fi, then try again\./)).toBeTruthy();
  });
});

