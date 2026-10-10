import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { NameDeviceScreen } from './NameDeviceScreen';
import { PermissionsScreen } from './PermissionsScreen';
import { CantReachScreen } from './CantReachScreen';
import { UpdateRequiredScreen } from './UpdateRequiredScreen';

describe('Name this device', () => {
  const noop = () => {};

  it('shows the design words and the hint before the user touches the field', () => {
    render(<NameDeviceScreen name="" onNameChange={noop} onContinue={noop} />);
    expect(screen.getByText('Name this device')).toBeTruthy();
    expect(screen.getByText('Other devices on your Wi-Fi will see this name so you can pick the right one.')).toBeTruthy();
    expect(screen.getByText('Device name')).toBeTruthy();
    expect(screen.getByText('Short names are easier to spot. You can change this later.')).toBeTruthy();
    expect(screen.getByText('Three quick steps left.')).toBeTruthy();
    // The design checks the name on blur and on Continue, not on first render.
    expect(screen.queryByTestId('name-error')).toBeNull();
    expect(screen.queryByText('Step 1 of 3')).toBeNull();
  });

  it('keeps Continue enabled, shows the error, and does not continue with a blank name', () => {
    const next = jest.fn();
    render(<NameDeviceScreen name="   " onNameChange={noop} onContinue={next} />);
    expect(screen.getByLabelText('name-next').props.accessibilityState?.disabled).not.toBe(true);
    fireEvent.press(screen.getByLabelText('name-next'));
    expect(screen.getByTestId('name-error')).toBeTruthy();
    expect(screen.getByText('Give this device a name so people can tell it apart.')).toBeTruthy();
    expect(screen.queryByText('Short names are easier to spot. You can change this later.')).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it('shows the error when the field loses focus while it is blank', () => {
    render(<NameDeviceScreen name="" onNameChange={noop} onContinue={noop} />);
    fireEvent(screen.getByTestId('name-input'), 'blur');
    expect(screen.getByTestId('name-error')).toBeTruthy();
  });

  it('clears the error as soon as the user types', () => {
    const { rerender } = render(<NameDeviceScreen name="" onNameChange={noop} onContinue={noop} />);
    fireEvent(screen.getByTestId('name-input'), 'blur');
    expect(screen.getByTestId('name-error')).toBeTruthy();
    rerender(<NameDeviceScreen name="S" onNameChange={noop} onContinue={noop} />);
    expect(screen.queryByTestId('name-error')).toBeNull();
    expect(screen.getByText('Short names are easier to spot. You can change this later.')).toBeTruthy();
  });

  it('passes the keystrokes up and continues with a typed name', () => {
    const change = jest.fn();
    const next = jest.fn();
    render(<NameDeviceScreen name="Seawood Otter" onNameChange={change} onContinue={next} />);
    fireEvent.changeText(screen.getByTestId('name-input'), 'Study Pi');
    fireEvent.press(screen.getByLabelText('name-next'));
    expect(change).toHaveBeenCalledWith('Study Pi');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('limits the name to 18 characters', () => {
    render(<NameDeviceScreen name="" onNameChange={noop} onContinue={noop} />);
    expect(screen.getByTestId('name-input').props.maxLength).toBe(18);
  });

  it('lets the host replace or remove the footer sentence', () => {
    const { rerender } = render(
      <NameDeviceScreen name="" onNameChange={noop} onContinue={noop} footer="Two quick steps left." />,
    );
    expect(screen.getByText('Two quick steps left.')).toBeTruthy();
    expect(screen.queryByText('Three quick steps left.')).toBeNull();
    rerender(<NameDeviceScreen name="" onNameChange={noop} onContinue={noop} footer={null} />);
    expect(screen.queryByText('Two quick steps left.')).toBeNull();
  });
});
describe('Permissions', () => {
  const off = { key: 'alerts', title: 'Alerts when a file arrives', sub: 'A short banner so you know something came in.', state: 'off' as const };
  const noop = () => {};

  it('shows the words of the design and one row', () => {
    render(<PermissionsScreen rows={[off]} onContinue={noop} />);
    expect(screen.getByText('Optional alerts')).toBeTruthy();
    expect(
      screen.getByText('Daak finds other devices on your Wi-Fi by itself. Alerts are optional — skip them or turn them on now.'),
    ).toBeTruthy();
    expect(screen.getByText('Alerts when a file arrives')).toBeTruthy();
    expect(screen.getByText('A short banner so you know something came in.')).toBeTruthy();
    expect(screen.getByText('You can change this later in Settings.')).toBeTruthy();
    expect(screen.queryByText('Step 2 of 3')).toBeNull();
    expect(screen.queryByText('Two quick permissions')).toBeNull();
  });

  it('never blocks Continue', () => {
    const next = jest.fn();
    render(<PermissionsScreen rows={[off]} onContinue={next} />);
    expect(screen.getByLabelText('permissions-continue').props.accessibilityState?.disabled).not.toBe(true);
    fireEvent.press(screen.getByLabelText('permissions-continue'));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('says whether alerts are on or off', () => {
    const { rerender } = render(<PermissionsScreen rows={[off]} onContinue={noop} />);
    expect(screen.getByTestId('permissions-hint').props.children).toBe('Alerts are off. You can continue without them.');
    rerender(<PermissionsScreen rows={[{ ...off, state: 'on' }]} onContinue={noop} />);
    expect(screen.getByTestId('permissions-hint').props.children).toBe('Alerts are on.');
  });

  // A host that cannot change the grant sets the row to 'unavailable'. The
  // screen then makes no claim about the state.
  it('shows no on or off sentence for a row the host cannot change', () => {
    render(<PermissionsScreen rows={[{ ...off, state: 'unavailable' }]} onContinue={noop} />);
    expect(screen.queryByTestId('permissions-hint')).toBeNull();
    expect(screen.getByTestId('perm-alerts').props.onPress).toBeUndefined();
  });

  it('makes a row pressable only when the host gives it a handler', () => {
    const press = jest.fn();
    render(<PermissionsScreen rows={[{ ...off, onPress: press }]} onContinue={noop} />);
    fireEvent.press(screen.getByTestId('perm-alerts'));
    expect(press).toHaveBeenCalledTimes(1);
  });
});

describe('Cant reach any devices', () => {
  const noop = () => {};

  it('shows the design title, lead, and eyebrow', () => {
    render(<CantReachScreen onRetry={noop} onOpenSettings={noop} />);
    expect(screen.getByText('No connection')).toBeTruthy();
    expect(screen.getByText("Daak can't reach any devices")).toBeTruthy();
    expect(screen.getByText("Daak only works between devices on the same Wi-Fi. Right now it can't find one.")).toBeTruthy();
  });

  // Ruling D6. Nothing in this codebase reads the Wi-Fi name. The design shows
  // a mock name. The screen must say "this Wi-Fi".
  it('never names a network', () => {
    render(<CantReachScreen onRetry={noop} onOpenSettings={noop} deviceNoun="phone" />);
    expect(screen.queryByText(/Home-5G/)).toBeNull();
    expect(screen.getByText('Looking on this Wi-Fi')).toBeTruthy();
    expect(
      screen.getByText('This phone is on this Wi-Fi. The devices you paired need to be on this Wi-Fi too.'),
    ).toBeTruthy();
  });

  it('uses the device noun the host gives, and "device" when it gives none', () => {
    const { rerender } = render(<CantReachScreen onRetry={noop} onOpenSettings={noop} deviceNoun="Mac" />);
    expect(screen.getByText('This Mac is on this Wi-Fi. The devices you paired need to be on the same network too.')).toBeTruthy();
    rerender(<CantReachScreen onRetry={noop} onOpenSettings={noop} />);
    expect(screen.getByText('This device is on this Wi-Fi. The devices you paired need to be on this Wi-Fi too.')).toBeTruthy();
  });

  it('says conversations and not Inbox in the reassurance', () => {
    render(<CantReachScreen onRetry={noop} onOpenSettings={noop} />);
    expect(screen.getByText('Still fine')).toBeTruthy();
    expect(screen.getByText('Your paired devices are still paired.')).toBeTruthy();
    expect(screen.getByText('Everything already in your conversations is untouched.')).toBeTruthy();
    expect(screen.queryByText(/Inbox/)).toBeNull();
  });

  it('runs the retry and the settings route', () => {
    const retry = jest.fn();
    const settings = jest.fn();
    render(<CantReachScreen onRetry={retry} onOpenSettings={settings} />);
    fireEvent.press(screen.getByLabelText('cant-reach-retry'));
    fireEvent.press(screen.getByLabelText('cant-reach-settings'));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it('reads "Checking" on the button while a retry runs', () => {
    render(<CantReachScreen onRetry={noop} onOpenSettings={noop} retrying />);
    expect(screen.getByText('Checking')).toBeTruthy();
    expect(screen.queryByText('Looking again')).toBeNull();
  });

  // The design shows this hint after the first retry that finds nobody.
  it('shows the still-nothing hint after the first retry ends, and not before', () => {
    const hint = 'Still nothing on this Wi-Fi. Wait a few seconds, then look again.';
    const { rerender } = render(<CantReachScreen onRetry={noop} onOpenSettings={noop} />);
    expect(screen.queryByText(hint)).toBeNull();
    rerender(<CantReachScreen onRetry={noop} onOpenSettings={noop} retrying />);
    expect(screen.queryByText(hint)).toBeNull();
    rerender(<CantReachScreen onRetry={noop} onOpenSettings={noop} retrying={false} />);
    expect(screen.getByText(hint)).toBeTruthy();
  });

  it('shows the waiting rows with a size and the design hint', () => {
    const one = [{ transferId: 't1', label: 'To aabbccdd', bytesTotal: 2048 }];
    const { rerender } = render(<CantReachScreen onRetry={noop} onOpenSettings={noop} queued={one} />);
    expect(screen.getByText('Waiting to send')).toBeTruthy();
    expect(screen.getByText('To aabbccdd')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(screen.getByText('1 item will go by itself as soon as Daak finds the network again.')).toBeTruthy();
    rerender(
      <CantReachScreen
        onRetry={noop}
        onOpenSettings={noop}
        queued={[...one, { transferId: 't2', label: 'To 11223344', bytesTotal: 10 }]}
      />,
    );
    expect(screen.getByText('2 items will go by itself as soon as Daak finds the network again.')).toBeTruthy();
  });

  it('shows no waiting block when nothing waits', () => {
    render(<CantReachScreen onRetry={noop} onOpenSettings={noop} />);
    expect(screen.queryByText('Waiting to send')).toBeNull();
  });

  it('shows a real engine error when the check itself failed', () => {
    render(<CantReachScreen onRetry={noop} onOpenSettings={noop} error="the engine did not answer" />);
    expect(screen.getByLabelText('cant-reach-error')).toBeTruthy();
    expect(screen.getByText('the engine did not answer')).toBeTruthy();
    expect(screen.queryByText('Looking on this Wi-Fi')).toBeNull();
  });

  it('mounts the tips only once the disclosure is opened', () => {
    render(<CantReachScreen onRetry={noop} onOpenSettings={noop} />);
    expect(screen.queryByTestId('cant-reach-more')).toBeNull();
    fireEvent.press(screen.getByTestId('cant-reach-more-toggle'));
    expect(screen.getByTestId('cant-reach-more')).toBeTruthy();
    expect(screen.getByText('Turn Wi-Fi off, then back on.')).toBeTruthy();
    expect(
      screen.getByText('Check the other devices are on this Wi-Fi, not a guest network or mobile data.'),
    ).toBeTruthy();
  });
});

describe('Update needed', () => {
  const peer = {
    peerDeviceId: 'aa'.repeat(16),
    peerName: "Darshit's Pixel",
    peerVersion: 5,
    ourVersion: 3,
  };

  // The prototype's card reads "Version 0.4.2 (build 1180)". None of those
  // numbers exist in this codebase, so their absence is the assertion.
  it('shows the two real engine versions and none of the prototype build numbers', () => {
    render(<UpdateRequiredScreen peers={[peer]} onDismiss={() => {}} onOpenSettings={() => {}} />);
    expect(screen.getByText('File mover version 3')).toBeTruthy();
    expect(screen.getByText('File mover version 5')).toBeTruthy();
    expect(screen.queryByText(/0\.4\.2/)).toBeNull();
    expect(screen.queryByText(/build 1180/)).toBeNull();
  });

  // Two directions, two different problems. Telling a user whose app is
  // current to update the app would be wrong advice.
  it('gives different advice depending on which side is behind', () => {
    const { unmount } = render(
      <UpdateRequiredScreen peers={[peer]} onDismiss={() => {}} onOpenSettings={() => {}} />,
    );
    expect(screen.getByText(/newer than this app/)).toBeTruthy();
    unmount();
    render(
      <UpdateRequiredScreen
        peers={[{ ...peer, peerVersion: 1, ourVersion: 9 }]}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.getByText(/This app is newer than the Daak on another device/)).toBeTruthy();
  });

  it('lists every out-of-step peer, not only the first', () => {
    render(
      <UpdateRequiredScreen
        peers={[peer, { ...peer, peerDeviceId: 'bb'.repeat(16), peerName: 'Study Pi' }]}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    expect(screen.getAllByTestId('update-required-peer')).toHaveLength(1);
    expect(screen.getByText('Study Pi')).toBeTruthy();
  });
});
