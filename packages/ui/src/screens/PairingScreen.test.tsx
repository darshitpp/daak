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
    expect(screen.queryByTestId('scan-joiner')).toBeNull();
    expect(screen.queryByTestId('scan')).toBeNull();
  });

  it('keeps the join role on the scan control and renders no QR', () => {
    const onScan = jest.fn();
    render(<PairingScreen role="join" qrUri="" onScan={onScan} sas={SAS} />);
    expect(screen.queryByLabelText('pairing-qr')).toBeNull();
    fireEvent.press(screen.getByTestId('scan'));
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('offers a reject control only once a SAS is shown and a handler exists', () => {
    const onReject = jest.fn();
    const { rerender } = render(
      <PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas="" onReject={onReject} />,
    );
    expect(screen.queryByTestId('reject')).toBeNull();
    rerender(<PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas={SAS} onReject={onReject} />);
    fireEvent.press(screen.getByTestId('reject'));
    expect(onReject).toHaveBeenCalledTimes(1);
    rerender(<PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas={SAS} />);
    expect(screen.queryByTestId('reject')).toBeNull();
  });

  // Commit 552459d. A new pairing is pending until the user confirms it.
  it('offers a confirm control only once a SAS is shown and a handler exists', () => {
    const onConfirm = jest.fn();
    const { rerender } = render(
      <PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas="" onConfirm={onConfirm} />,
    );
    expect(screen.queryByTestId('confirm')).toBeNull();
    rerender(<PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas={SAS} onConfirm={onConfirm} />);
    fireEvent.press(screen.getByTestId('confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    rerender(<PairingScreen role="host" qrUri="u" onScan={jest.fn()} sas={SAS} />);
    expect(screen.queryByTestId('confirm')).toBeNull();
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
    fireEvent.press(screen.getAllByTestId('scan')[0]);
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

  // The design title and body stay. The engine's own message shows in a small
  // separate line, because the apps keep no log and a release build otherwise
  // hides the reason (field test 2026-10-11: a QR scan failed with no reason).
  it('shows the design error title, the engine message in its own line, and runs Try again', () => {
    const retry = jest.fn();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    render(<PairingScreen role="join" qrUri="" onScan={noop} sas="" error="camera denied" onRetry={retry} />);
    expect(screen.getByText("We couldn't read that code.")).toBeTruthy();
    expect(screen.getByText('Make sure their screen is showing the code, then try again.')).toBeTruthy();
    expect(screen.getByTestId('pairing-error-detail')).toHaveTextContent('camera denied');
    expect(warn).toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('pair-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('shows no QR when the host failed', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    render(<PairingScreen role="host" qrUri="" onScan={noop} sas="" error="engine not started" onRetry={noop} />);
    expect(screen.queryByLabelText('pairing-qr')).toBeNull();
    // The host reads no code, so the joiner title does not fit.
    expect(screen.getByText("We couldn't make your code.")).toBeTruthy();
    expect(screen.queryByText("We couldn't read that code.")).toBeNull();
    expect(screen.getByText('Make sure this device is on Wi-Fi, then try again.')).toBeTruthy();
    warn.mockRestore();
  });

  // Design index.html:567: a quiet, block button under the number.
  it('host: offers Show a new code only with a SAS, and calls onNewCode', () => {
    const onNewCode = jest.fn();
    const { rerender } = render(
      <PairingScreen role="host" qrUri="u" onScan={noop} sas="" onNewCode={onNewCode} />,
    );
    expect(screen.queryByTestId('pair-newcode')).toBeNull();
    rerender(<PairingScreen role="host" qrUri="u" onScan={noop} sas="482917" onNewCode={onNewCode} />);
    expect(screen.getByText('Show a new code')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pair-newcode'));
    expect(onNewCode).toHaveBeenCalledTimes(1);
  });

  // Design pair-scan-panel: the scan frame line sits above the hold-steady hint.
  it('join: shows the scan frame line next to the hold-steady hint', () => {
    render(<PairingScreen role="join" qrUri="" onScan={noop} sas="" />);
    expect(screen.getByText('Their square should fill the frame.')).toBeTruthy();
    expect(screen.getByText('Hold steady for a second.')).toBeTruthy();
  });

  // The design has no "derived from both devices' keys" sentence.
  it('never prints the derived-from-keys sentence', () => {
    render(<PairingScreen role="host" qrUri="u" onScan={noop} sas="482917" />);
    expect(screen.queryByText(/derived from both devices/)).toBeNull();
  });
});

// Design `pair-code-panel`. The flow owns the phase, the poll, and the picker
// filter. The screen draws one panel and reads its values from props.
describe('PairingScreen code pairing', () => {
  const noop = jest.fn();
  const HOST = { role: 'host', qrUri: 'u', onScan: noop, sas: '' } as const;
  const JOIN = { role: 'join', qrUri: '', onScan: noop, sas: '' } as const;
  const ARMED = { state: 'armed', remainingMs: 120_000, triesLeft: 3 } as const;
  const ID = 'aa'.repeat(16);
  const DEVICES = [{ deviceId: ID, name: 'Kitchen Tablet' }];

  // The code option is the third one. A daemon-backed build has no code
  // pairing, so the screen draws no code panel there.
  it('shows the code panel only when the flow gives a code mode and support', () => {
    const { rerender } = render(
      <PairingScreen {...HOST} codeSupported codeMode="show" code="482917" />,
    );
    expect(screen.getByTestId('pair-code-panel')).toBeTruthy();
    rerender(<PairingScreen {...HOST} codeSupported={false} codeMode="show" code="482917" />);
    expect(screen.queryByTestId('pair-code-panel')).toBeNull();
    // No code mode: the QR panel is back, as before.
    rerender(<PairingScreen {...HOST} qrUri="data:image/png;base64,QUJD" />);
    expect(screen.getByLabelText('pairing-qr')).toBeTruthy();
    expect(screen.queryByTestId('pair-code-panel')).toBeNull();
  });

  // The check number replaces the code. The panel goes, so the host no longer
  // shows a blank code under a stale heading.
  it('host: a check number takes the code panel off the screen', () => {
    render(<PairingScreen {...HOST} codeSupported codeMode="show" code="482917" sas="112233" />);
    expect(screen.queryByTestId('pair-code-panel')).toBeNull();
    expect(screen.getByTestId('pairing-sas')).toBeTruthy();
  });

  // The joiner's Continue goes with the panel, so a second tap cannot start a
  // second pair call that then fails under the check number.
  it('join: a check number takes the panel and the Continue button off the screen', () => {
    const onCodeSubmit = jest.fn();
    render(
      <PairingScreen
        {...JOIN}
        codeSupported
        codeMode="enter"
        codeDevices={DEVICES}
        onCodeSubmit={onCodeSubmit}
        sas="112233"
      />,
    );
    expect(screen.queryByTestId('pair-code-panel')).toBeNull();
    expect(screen.queryByTestId('pair-code-submit')).toBeNull();
    expect(screen.getByTestId('pairing-sas')).toBeTruthy();
  });

  // A code-only host holds no QR. The heading and the frame go together, so the
  // check number is not followed by an empty square.
  it('host: no QR and no heading when this host holds no square', () => {
    render(<PairingScreen role="host" qrUri="" onScan={noop} sas="112233" />);
    expect(screen.queryByLabelText('pairing-qr')).toBeNull();
    expect(screen.queryByText('Show this to the other device')).toBeNull();
  });

  it('host: shows the code, the own name, the two minute hint, and the countdown', () => {
    const onCodeNew = jest.fn();
    render(
      <PairingScreen
        {...HOST}
        codeSupported
        codeMode="show"
        code="482917"
        selfName="Darshit's iPhone"
        codeStatus={ARMED}
        onCodeNew={onCodeNew}
      />,
    );
    expect(screen.getByText('Show the code')).toBeTruthy();
    expect(screen.getByText('Enter a code')).toBeTruthy();
    expect(screen.getByText('Show this code to the other device')).toBeTruthy();
    expect(screen.getByText("Darshit's iPhone")).toBeTruthy();
    expect(screen.getByText('482 917')).toBeTruthy();
    expect(screen.getByText('This code works for 2 minutes.')).toBeTruthy();
    expect(screen.getByTestId('pair-code-countdown')).toHaveTextContent(/2:00/);
    // The QR panel belongs to the other path.
    expect(screen.queryByLabelText('pairing-qr')).toBeNull();
    fireEvent.press(screen.getByTestId('pair-code-new'));
    expect(onCodeNew).toHaveBeenCalledTimes(1);
  });

  // Review Focus 6: the engine is the only clock. The countdown is a reading
  // of the poll and the screen remembers no time of its own.
  it('host: the countdown text follows remainingMs', () => {
    const { rerender } = render(
      <PairingScreen {...HOST} codeSupported codeMode="show" code="482917" codeStatus={ARMED} />,
    );
    expect(screen.getByTestId('pair-code-countdown')).toHaveTextContent(/2:00/);
    rerender(
      <PairingScreen
        {...HOST}
        codeSupported
        codeMode="show"
        code="482917"
        codeStatus={{ state: 'armed', remainingMs: 8000, triesLeft: 3 }}
      />,
    );
    expect(screen.getByTestId('pair-code-countdown')).toHaveTextContent(/0:08/);
  });

  it('host: a dead code shows the note for its state and one new-code button', () => {
    const onCodeNew = jest.fn();
    const props = { ...HOST, codeSupported: true, codeMode: 'show', code: '482917', onCodeNew } as const;
    const { rerender } = render(
      <PairingScreen {...props} codeStatus={{ state: 'expired', remainingMs: 0, triesLeft: 0 }} />,
    );
    expect(screen.getByText('That code expired.')).toBeTruthy();
    expect(screen.queryByText('Too many tries.')).toBeNull();
    // The dead code goes, with its own copy and its own countdown.
    expect(screen.queryByTestId('pair-code-value')).toBeNull();
    expect(screen.queryByTestId('pair-code-countdown')).toBeNull();
    rerender(<PairingScreen {...props} codeStatus={{ state: 'exhausted', remainingMs: 0, triesLeft: 0 }} />);
    expect(screen.getByText('Too many tries.')).toBeTruthy();
    expect(screen.queryByText('That code expired.')).toBeNull();
    fireEvent.press(screen.getByTestId('pair-code-dead-new'));
    expect(onCodeNew).toHaveBeenCalledTimes(1);
  });

  it('join: six cells, and Continue waits for six digits and calls onCodeSubmit', () => {
    const onCodeSubmit = jest.fn();
    render(
      <PairingScreen
        {...JOIN}
        codeSupported
        codeMode="enter"
        codeDevices={DEVICES}
        onCodeSubmit={onCodeSubmit}
      />,
    );
    expect(screen.getByText('Enter the pairing code')).toBeTruthy();
    expect(screen.getByText('Pick the device that shows the code.')).toBeTruthy();
    // The cells are pictures of the digits. The input holds the value and is
    // the control a reader uses, so the cells are hidden from a screen reader.
    expect(screen.getAllByTestId('pair-code-cell', { includeHiddenElements: true })).toHaveLength(6);
    const input = screen.getByTestId('pair-code-input');
    fireEvent.changeText(input, '48291');
    expect(screen.getByTestId('pair-code-submit')).toBeDisabled();
    fireEvent.press(screen.getByTestId('pair-code-submit'));
    expect(onCodeSubmit).not.toHaveBeenCalled();
    fireEvent.changeText(input, '4829a7x1');
    // The letters are dropped.
    fireEvent.press(screen.getByTestId('pair-code-submit'));
    expect(onCodeSubmit).toHaveBeenCalledWith('482971');
  });

  // A double tap must not burn two attempts (design review).
  it('join: Continue is disabled while the flow is busy', () => {
    const onCodeSubmit = jest.fn();
    const props = { ...JOIN, codeSupported: true, codeMode: 'enter', codeDevices: DEVICES, onCodeSubmit } as const;
    const { rerender } = render(<PairingScreen {...props} codeBusy />);
    fireEvent.changeText(screen.getByTestId('pair-code-input'), '482917');
    expect(screen.getByTestId('pair-code-submit')).toBeDisabled();
    fireEvent.press(screen.getByTestId('pair-code-submit'));
    expect(onCodeSubmit).not.toHaveBeenCalled();
    rerender(<PairingScreen {...props} />);
    expect(screen.getByTestId('pair-code-submit')).not.toBeDisabled();
    rerender(<PairingScreen {...props} codeBusy />);
    expect(screen.getByTestId('pair-code-submit')).toBeDisabled();
  });

  it('join: an empty picker names no device and says what to check', () => {
    render(<PairingScreen {...JOIN} codeSupported codeMode="enter" codeDevices={[]} />);
    expect(screen.getByText('No devices found. Check both devices are on the same Wi-Fi.')).toBeTruthy();
  });

  it('join: picking a device calls onCodePick with its id', () => {
    const onCodePick = jest.fn();
    render(
      <PairingScreen
        {...JOIN}
        codeSupported
        codeMode="enter"
        codeDevices={DEVICES}
        codePick={ID}
        onCodePick={onCodePick}
      />,
    );
    fireEvent.press(screen.getByTestId('pair-code-pick-' + ID));
    expect(onCodePick).toHaveBeenCalledWith(ID);
  });

  // A LAN can hold two devices with one name. The short id tells them apart,
  // so the user does not pick the wrong one. A unique name needs no id.
  it('join: a repeated device name adds a short id, and a unique name adds none', () => {
    const twinA = 'aa'.repeat(16);
    const twinB = 'bb'.repeat(16);
    const { rerender } = render(
      <PairingScreen
        {...JOIN}
        codeSupported
        codeMode="enter"
        codeDevices={[
          { deviceId: twinA, name: 'Kitchen Tablet' },
          { deviceId: twinB, name: 'Kitchen Tablet' },
        ]}
      />,
    );
    // The visible short id stays. It is hidden from a reader, because the
    // button carries the name and the short id together, as ONE element.
    expect(screen.getByTestId('pair-code-id-' + twinA, { includeHiddenElements: true })).toHaveTextContent(
      /aaaaaaaa/,
    );
    expect(screen.getByTestId('pair-code-id-' + twinB, { includeHiddenElements: true })).toHaveTextContent(
      /bbbbbbbb/,
    );
    expect(screen.getByTestId('pair-code-pick-' + twinA).props.accessibilityLabel).toBe(
      'Kitchen Tablet aaaaaaaa',
    );
    expect(screen.getByTestId('pair-code-pick-' + twinB).props.accessibilityLabel).toBe(
      'Kitchen Tablet bbbbbbbb',
    );
    rerender(
      <PairingScreen
        {...JOIN}
        codeSupported
        codeMode="enter"
        codeDevices={[{ deviceId: twinA, name: 'Kitchen Tablet' }]}
      />,
    );
    expect(screen.queryByTestId('pair-code-id-' + twinA, { includeHiddenElements: true })).toBeNull();
    // A unique name needs no short id, so the button carries the name alone.
    expect(screen.getByTestId('pair-code-pick-' + twinA).props.accessibilityLabel).toBe('Kitchen Tablet');
  });

  // The joiner learns one thing from a failure and nothing more. A wrong code,
  // a dead code, and a network fault look the same from there.
  it('join: a failure shows the neutral note, and not the QR note', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <PairingScreen {...JOIN} codeSupported codeMode="enter" codeDevices={DEVICES} error="wrong code" />,
    );
    expect(screen.getByText('That did not work.')).toBeTruthy();
    expect(
      screen.getByText('Check the six digits, and check the other device is still showing its code.'),
    ).toBeTruthy();
    expect(screen.queryByText("We couldn't read that code.")).toBeNull();
    warn.mockRestore();
  });

  it('the code panel offers a way back to the choices', () => {
    const onCodeBack = jest.fn();
    render(<PairingScreen {...HOST} codeSupported codeMode="show" code="482917" onCodeBack={onCodeBack} />);
    expect(screen.getByText('Choose another way')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pair-code-back'));
    expect(onCodeBack).toHaveBeenCalledTimes(1);
  });

  it('shows the peer name at the check number, above the hint', () => {
    const { rerender } = render(<PairingScreen {...JOIN} sas="482917" />);
    expect(screen.queryByText('Pairing with Darshit MacBook')).toBeNull();
    rerender(<PairingScreen {...JOIN} sas="482917" peerName="Darshit MacBook" />);
    expect(screen.getByText('Pairing with Darshit MacBook')).toBeTruthy();
    expect(screen.getByTestId('pairing-sas')).toBeTruthy();
  });
});

