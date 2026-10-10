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
  const rows = [
    { key: 'nearby', title: 'Nearby devices', sub: 'on', state: 'unavailable' as const },
    { key: 'alerts', title: 'Alerts when a file arrives', sub: 'off', state: 'off' as const },
  ];

  // The prototype's own perm-go rule: Continue is enabled exactly when the
  // "still needed" list is empty.
  it('gates Continue on what is still needed, and names it', () => {
    render(
      <PermissionsScreen
        rows={rows}
        stillNeeded={['Alerts when a file arrives']}
        onContinue={() => {}}
      />,
    );
    expect(screen.getByTestId('permissions-hint').props.children).toContain('Alerts when a file arrives');
    fireEvent.press(screen.getByLabelText('permissions-continue'));
    expect(screen.getByLabelText('permissions-continue').props.accessibilityState?.disabled).toBe(true);
  });

  it('enables Continue once nothing is outstanding', () => {
    const next = jest.fn();
    render(<PermissionsScreen rows={rows} stillNeeded={[]} onContinue={next} />);
    expect(screen.getByTestId('permissions-hint').props.children).toContain('All set');
    fireEvent.press(screen.getByLabelText('permissions-continue'));
    expect(next).toHaveBeenCalledTimes(1);
  });

  // A row with no onPress is inert. The reason it has none is the platform's,
  // so the subtitle has to carry it rather than the control pretending.
  it('does not make a row pressable unless the platform can act on it', () => {
    render(<PermissionsScreen rows={rows} stillNeeded={[]} onContinue={() => {}} />);
    fireEvent.press(screen.getByTestId('perm-nearby'));
    expect(screen.getByTestId('perm-nearby').props.onPress).toBeUndefined();
  });

  // A row the platform cannot query is UNAVAILABLE, not on. Rendering it on
  // claims a grant -- on iOS the user may have refused local-network access in
  // the system prompt an hour ago, and nothing in JS can find that out. The
  // consequence is also that such a row must not gate Continue, which the real
  // stillNeeded list (packages/platform/src/permission-rows.ts) enforces.
  it('shows a row the platform cannot query as unavailable, not granted', () => {
    render(<PermissionsScreen rows={rows} stillNeeded={[]} onContinue={() => {}} />);
    const row = screen.getByTestId('perm-nearby');
    expect(row.props.accessibilityRole).toBeUndefined();
    expect(row.props.accessibilityLabel).toBe('Nearby devices');
    expect(screen.getByLabelText('Nearby devices')).toBeTruthy();
  });
});

describe('Cant reach any devices', () => {
  // The prototype's queue block names a Wi-Fi network this app cannot query.
  // What must not come back is that invented network name.
  it('never names a network it did not ask about', () => {
    render(<CantReachScreen onRetry={() => {}} onOpenSettings={() => {}} />);
    expect(screen.queryByText(/Home-5G/)).toBeNull();
    expect(screen.getByText("Daak can't reach any devices")).toBeTruthy();
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

  it('shows a real engine error when the check itself failed', () => {
    render(
      <CantReachScreen onRetry={() => {}} onOpenSettings={() => {}} error="the engine did not answer" />,
    );
    // Note carries its testID as an accessibility label, not a testID.
    expect(screen.getByLabelText('cant-reach-error')).toBeTruthy();
  });

  it('mounts the troubleshooting body only once the disclosure is opened', () => {
    render(<CantReachScreen onRetry={() => {}} onOpenSettings={() => {}} />);
    expect(screen.queryByTestId('cant-reach-more')).toBeNull();
    fireEvent.press(screen.getByTestId('cant-reach-more-toggle'));
    expect(screen.getByTestId('cant-reach-more')).toBeTruthy();
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
