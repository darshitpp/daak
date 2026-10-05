import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { WelcomeScreen } from './WelcomeScreen';
import { NameDeviceScreen } from './NameDeviceScreen';
import { PermissionsScreen } from './PermissionsScreen';
import { CantReachScreen } from './CantReachScreen';
import { UpdateRequiredScreen } from './UpdateRequiredScreen';

describe('Welcome', () => {
  it('keeps the three promises the prototype makes, and both exits work', () => {
    const started = jest.fn();
    const skip = jest.fn();
    render(<WelcomeScreen onGetStarted={started} onSkip={skip} />);
    expect(screen.getByText('Send photos, files, and text')).toBeTruthy();
    expect(screen.getByText('No account, no sign-up, no cloud.')).toBeTruthy();
    expect(screen.getByText('Works with the internet off')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('welcome-get-started'));
    fireEvent.press(screen.getByLabelText('welcome-skip'));
    expect(started).toHaveBeenCalledTimes(1);
    expect(skip).toHaveBeenCalledTimes(1);
  });
});

describe('Name this device', () => {
  // A disabled Next is how the user learns the field is required; the line
  // under the field is how they learn what to do about it.
  it('refuses an empty name and says why', () => {
    const next = jest.fn();
    render(<NameDeviceScreen name="   " onNameChange={() => {}} onContinue={next} />);
    expect(screen.getByTestId('name-error')).toBeTruthy();
    expect(screen.getByText('Type a name so people know which device is yours.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('name-next'));
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a typed name and passes the keystrokes up', () => {
    const change = jest.fn();
    const next = jest.fn();
    render(<NameDeviceScreen name="Seawood Otter" onNameChange={change} onContinue={next} />);
    expect(screen.queryByTestId('name-error')).toBeNull();
    fireEvent.changeText(screen.getByTestId('name-input'), 'Study Pi');
    fireEvent.press(screen.getByLabelText('name-next'));
    expect(change).toHaveBeenCalledWith('Study Pi');
    expect(next).toHaveBeenCalledTimes(1);
  });

  // The desktop prototype calls this step `Name this Mac` and suggests a
  // computer name. Reusing the phone's nouns on a Mac reads as a leftover, so
  // the desktop flow passes `copy`. The mobile caller passes nothing and
  // must be unaffected -- these four pin that.
  it(`takes platform copy for the heading, lead, and hint`, () => {
    render(
      <NameDeviceScreen
        name="Darshit's MacBook"
        onNameChange={() => {}}
        onContinue={() => {}}
        copy={{
          heading: 'Name this Mac',
          lead: 'This name appears on the other device when it asks to receive a file.',
          hint: 'A computer name works well.',
        }}
      />
    );
    expect(screen.getByText('Name this Mac')).toBeTruthy();
    expect(
      screen.getByText('This name appears on the other device when it asks to receive a file.'),
    ).toBeTruthy();
    expect(screen.getByText('A computer name works well.')).toBeTruthy();
    // The phone's own words must be gone, not merely joined by the Mac's.
    expect(screen.queryByText('Name this device')).toBeNull();
  });

  it(`uses the overridden error line on an empty name`, () => {
    render(
      <NameDeviceScreen
        name=""
        onNameChange={() => {}}
        onContinue={() => {}}
        copy={{ error: 'Type something like a MacBook name, then move on.' }}
      />
    );
    expect(screen.getByText('Type something like a MacBook name, then move on.')).toBeTruthy();
    expect(screen.queryByText('Type a name so people know which device is yours.')).toBeNull();
  });

  // The one override that removes a line entirely. The phone's closing note
  // (`Only on your Wi-Fi`) is true everywhere but redundant on a Mac, and
  // the desktop prototype's own step has no equivalent.
  it(`omits the closing note when copy sets it to null`, () => {
    render(
      <NameDeviceScreen
        name="Darshit's MacBook"
        onNameChange={() => {}}
        onContinue={() => {}}
        copy={{ note: null }}
      />
    );
    expect(screen.queryByText('Only on your Wi-Fi')).toBeNull();
  });

  // Per-field fallback: an override that does not mention the note must leave
  // the default note in place, not silently drop it.
  it(`keeps the default note when copy omits it`, () => {
    render(
      <NameDeviceScreen
        name="Darshit's MacBook"
        onNameChange={() => {}}
        onContinue={() => {}}
        copy={{ heading: 'Name this Mac' }}
      />
    );
    expect(screen.getByText('Only on your Wi-Fi')).toBeTruthy();
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
