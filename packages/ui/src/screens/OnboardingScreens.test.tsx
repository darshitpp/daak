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
    expect(screen.getByTestId('name-next').props.accessibilityState?.disabled).not.toBe(true);
    fireEvent.press(screen.getByTestId('name-next'));
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
    fireEvent.press(screen.getByTestId('name-next'));
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
    expect(screen.getByTestId('permissions-continue').props.accessibilityState?.disabled).not.toBe(true);
    fireEvent.press(screen.getByTestId('permissions-continue'));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('says whether alerts are on or off', () => {
    const { rerender } = render(<PermissionsScreen rows={[off]} onContinue={noop} />);
    expect(screen.getByTestId('permissions-hint').props.children).toBe('Alerts are off. You can continue without them.');
    rerender(<PermissionsScreen rows={[{ ...off, state: 'on' }]} onContinue={noop} />);
    expect(screen.getByTestId('permissions-hint').props.children).toBe('Alerts are on.');
  });

  // A host that cannot read the grant sets the row to 'unavailable'. The row
  // keeps the design hint and its locked switch. The design macos.html shows
  // the hint for the alerts row, and the desktop has no way to read the grant,
  // so the off sentence prints.
  it('shows the design off sentence and a locked switch for a row the host cannot read', () => {
    render(<PermissionsScreen rows={[{ ...off, state: 'unavailable' }]} onContinue={noop} />);
    expect(screen.getByTestId('permissions-hint').props.children).toBe('Alerts are off. You can continue without them.');
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
    // The design phone copy (index.html, cant-reach) says "the same network".
    expect(
      screen.getByText('This phone is on this Wi-Fi. The devices you paired need to be on the same network too.'),
    ).toBeTruthy();
  });

  it('uses the device noun the host gives, and "device" when it gives none', () => {
    const { rerender } = render(<CantReachScreen onRetry={noop} onOpenSettings={noop} deviceNoun="Mac" />);
    expect(screen.getByText('This Mac is on this Wi-Fi. The devices you paired need to be on the same network too.')).toBeTruthy();
    rerender(<CantReachScreen onRetry={noop} onOpenSettings={noop} />);
    expect(screen.getByText('This device is on this Wi-Fi. The devices you paired need to be on the same network too.')).toBeTruthy();
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
    fireEvent.press(screen.getByTestId('cant-reach-retry'));
    fireEvent.press(screen.getByTestId('cant-reach-settings'));
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
    expect(screen.getByTestId('cant-reach-error')).toBeTruthy();
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

describe('Update available', () => {
  const noop = () => {};

  it('shows the design words', () => {
    render(<UpdateRequiredScreen onDismiss={noop} onOpenDownloadPage={noop} />);
    expect(screen.getByText('Update available')).toBeTruthy();
    expect(screen.getByText('A new version of Daak is available')).toBeTruthy();
    expect(
      screen.getByText("Daak updates happen in your browser. This version keeps working until you're ready."),
    ).toBeTruthy();
    expect(screen.getByText('Sending still works')).toBeTruthy();
    expect(
      screen.getByText(
        'Your paired devices and everything already in your conversations are safe. Install when it suits you.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Opens the Daak releases page in your browser.')).toBeTruthy();
  });

  it('no longer claims a pause or offers an in-app update', () => {
    render(<UpdateRequiredScreen onDismiss={noop} onOpenDownloadPage={noop} />);
    expect(screen.queryByText(/Sending and receiving are paused/)).toBeNull();
    expect(screen.queryByText('Daak needs a quick update')).toBeNull();
    expect(screen.queryByText('Update and restart')).toBeNull();
    expect(screen.queryByText('Open Settings to update')).toBeNull();
    expect(screen.queryByText('Check for updates')).toBeNull();
    expect(screen.queryByText('File mover')).toBeNull();
    expect(screen.queryByText(/Takes about 10 seconds/)).toBeNull();
  });

  it('shows the app version in the "This app" row', () => {
    render(<UpdateRequiredScreen onDismiss={noop} onOpenDownloadPage={noop} app={{ version: '1.2.3', build: '45' }} />);
    expect(screen.getByText('This app')).toBeTruthy();
    expect(screen.getByText('Version 1.2.3 (build 45)')).toBeTruthy();
  });

  // The app version loads after the screen opens, or never.
  it('hides the "This app" row until the app version loads, and shows none of the mock numbers', () => {
    render(<UpdateRequiredScreen onDismiss={noop} onOpenDownloadPage={noop} />);
    expect(screen.queryByText('This app')).toBeNull();
    expect(screen.queryByText(/0\.4\.2/)).toBeNull();
    expect(screen.queryByText(/build 1180/)).toBeNull();
    expect(screen.queryByText(/0\.5\.0/)).toBeNull();
  });

  // User decision: the "Latest" row is removed. The card shows only "This app".
  it('has no "Latest" row and no protocol number', () => {
    render(<UpdateRequiredScreen onDismiss={noop} onOpenDownloadPage={noop} app={{ version: '1.2.3', build: '45' }} />);
    expect(screen.queryByText('Latest')).toBeNull();
    expect(screen.queryByText(/Protocol/)).toBeNull();
  });

  // Ruling D2. The action opens the releases page. It does not update the app.
  it('opens the download page, and "Remind me later" and the back arrow dismiss', () => {
    const open = jest.fn();
    const later = jest.fn();
    render(<UpdateRequiredScreen onDismiss={later} onOpenDownloadPage={open} />);
    fireEvent.press(screen.getByTestId('update-open'));
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('update-dismiss'));
    fireEvent.press(screen.getByTestId('onb-back'));
    expect(later).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Open the download page')).toBeTruthy();
    expect(screen.getByText('Remind me later')).toBeTruthy();
  });

  it('shows a fallback note when the page cannot open', async () => {
    const open = jest.fn(async () => {
      throw new Error('no handler');
    });
    render(<UpdateRequiredScreen onDismiss={noop} onOpenDownloadPage={open} />);
    fireEvent.press(screen.getByTestId('update-open'));
    expect(await screen.findByText('Daak could not open the page')).toBeTruthy();
    expect(screen.getByText(/github\.com\/darshitpp\/daak\/releases/)).toBeTruthy();
  });
});
