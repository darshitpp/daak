import React from 'react';
import { Text, View } from 'react-native';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { EngineProvider } from '../EngineContext';
import { fakeEngine } from '../testing/fakeEngine';
import { SettingsScreen } from './SettingsScreen';
import { ToastProvider } from '../components/Toast';

// The background-sync affordance is a SLOT, not a hard import. packages/ui
// depends on @daak/core and nothing else: requestBatteryExemption is a
// TurboModule call that lives in @daak/platform, and importing that here would
// invert the dependency direction (platform -> core, never the reverse) and
// pull a getEnforcing into every ui test. So the app injects the control and
// this test only proves the slot renders when supplied.
describe('SettingsScreen background-sync slot', () => {
  it('renders an injected control', () => {
    render(
      <EngineProvider engine={fakeEngine()}>
        <SettingsScreen background={<Text>allow-bg</Text>} />
      </EngineProvider>,
    );
    expect(screen.getByText('allow-bg')).toBeTruthy();
  });

  // The default has to render a working screen: desktop and any future shell
  // that passes nothing must not crash on an absent slot.
  it('renders without one', () => {
    render(
      <EngineProvider engine={fakeEngine()}>
        <SettingsScreen />
      </EngineProvider>,
    );
    expect(screen.getByTestId('save-name')).toBeTruthy();
  });
});

// The name box opens on what the device is ACTUALLY called, and that read can
// fail: Daak.swift's need() throws DaakError.notStarted and daak-ffi's engine()
// answers "engine not started" when no engine has come up yet. A host may mount
// this screen before engine.start() has resolved -- apps/desktop/index.js keeps
// a window on screen for a start failure -- so the read at mount is a genuine
// race, not a hypothetical.
//
// The two tests below pin what the screen owes the user in that race: it must
// SAY the read failed, and it must fill the box once the engine can answer.
describe('SettingsScreen reads the stored name', () => {
  const nameBox = () => screen.getByPlaceholderText('Display name');

  // A rejected read used to land in an EMPTY arrow, so the box stayed blank and
  // the screen said nothing: the one outcome that looks like the name was
  // never set. The engine's own words reach the user instead.
  it('names the failure when the read rejects', async () => {
    const engine = fakeEngine();
    engine.selfProfile = async () => {
      throw new Error('engine not started');
    };
    render(
      <EngineProvider engine={engine}>
        <SettingsScreen />
      </EngineProvider>,
    );
    await waitFor(() => expect(screen.getByText('Name did not load')).toBeTruthy());
    expect(screen.getByText('engine not started')).toBeTruthy();
    expect(nameBox().props.value).toBe('');
  });

  // The effect depends on the engine object, which is stable for the process, so
  // it ran ONCE at mount. A read that lost the race was therefore over for good:
  // nothing re-ran it, so the box stayed blank for the rest of the session.
  // The stored name must appear once the engine can answer, with no tap.
  it('fills the box when the engine answers on a later try', async () => {
    let ready = false;
    let reads = 0;
    const engine = fakeEngine();
    engine.selfProfile = async () => {
      reads += 1;
      if (!ready) throw new Error('engine not started');
      return { name: 'DP', baseName: 'DP', deviceId: 'dd'.repeat(16) };
    };
    render(
      <EngineProvider engine={engine}>
        <SettingsScreen />
      </EngineProvider>,
    );
    // The read failed first, so the screen has something to correct later.
    await waitFor(() => expect(screen.getByText('Name did not load')).toBeTruthy());
    ready = true;
    await waitFor(() => expect(nameBox().props.value).toBe('DP'));
    // A retry, not a re-render: one read can never learn the name.
    expect(reads).toBeGreaterThan(1);
    // The stale complaint goes once the box can answer for itself.
    expect(screen.queryByText('Name did not load')).toBeNull();
  });

  // A retry that lands after the user has started typing would throw away what
  // they typed. Only an EMPTY box is ever filled by a background retry.
  it('keeps what the user typed when a later read answers', async () => {
    let ready = false;
    const engine = fakeEngine();
    engine.selfProfile = async () => {
      if (!ready) throw new Error('engine not started');
      return { name: 'Kitchen iPad', baseName: 'Kitchen iPad', deviceId: 'dd'.repeat(16) };
    };
    render(
      <EngineProvider engine={engine}>
        <SettingsScreen />
      </EngineProvider>,
    );
    await waitFor(() => expect(screen.getByText('Name did not load')).toBeTruthy());
    ready = true;
    fireEvent.changeText(nameBox(), 'Study Room');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(nameBox().props.value).toBe('Study Room');
  });

  // Save re-reads the name the engine now holds, and that re-read also writes
  // the ref the retry consults. A renamed box whose ref still held the old text
  // would let a later retry treat it as user-owned and stop filling an empty
  // box. The box shows the BASE name (R57), so the typed text survives a save.
  it('keeps saving the typed name after a read failure', async () => {
    let ready = false;
    const saved: string[] = [];
    const engine = fakeEngine();
    engine.selfProfile = async () => {
      if (!ready) throw new Error('engine not started');
      const typed = saved[saved.length - 1] ?? 'Desk';
      return { name: typed, baseName: typed, deviceId: 'dd'.repeat(16) };
    };
    engine.setDisplayName = async (n: string) => {
      saved.push(n);
    };
    render(
      <EngineProvider engine={engine}>
        <SettingsScreen />
      </EngineProvider>,
    );
    await waitFor(() => expect(screen.getByText('Name did not load')).toBeTruthy());
    ready = true;
    await waitFor(() => expect(nameBox().props.value).toBe('Desk'));
    fireEvent.changeText(nameBox(), 'Study Room');
    fireEvent.press(screen.getByTestId('save-name'));
    await waitFor(() => expect(saved).toEqual(['Study Room']));
    await waitFor(() => expect(nameBox().props.value).toBe('Study Room'));
  });
});

// R57: the collision prefix is a LAN artifact, not the name the user typed.
// Engine::self_profile reports the RESOLVED name -- "Rustic Otter · D2Dp" for a
// device the user named "D2Dp" on a LAN that already holds "D2Dp" -- and the
// screen read that field, so the box showed a name nobody typed. The screen
// must show the BASE name, which is what the settings file holds and what
// setDisplayName takes back.
describe('SettingsScreen shows the name the user typed', () => {
  const nameBox = () => screen.getByPlaceholderText('Display name');

  it('shows the base name when the engine resolved a collision prefix', async () => {
    const engine = fakeEngine();
    engine.selfProfile = async () => ({
      name: 'Rustic Otter · D2Dp',
      baseName: 'D2Dp',
      deviceId: 'dd'.repeat(16),
    });
    render(
      <EngineProvider engine={engine}>
        <SettingsScreen />
      </EngineProvider>,
    );
    await waitFor(() => expect(nameBox().props.value).toBe('D2Dp'));
  });

  // The other half of the same ruling: a name with no collision must come
  // through UNCHANGED. A screen that stripped a suffix would fail here.
  it('shows a plain name unchanged', async () => {
    const engine = fakeEngine();
    engine.selfProfile = async () => ({
      name: 'Pixel 9',
      baseName: 'Pixel 9',
      deviceId: 'dd'.repeat(16),
    });
    render(
      <EngineProvider engine={engine}>
        <SettingsScreen />
      </EngineProvider>,
    );
    await waitFor(() => expect(nameBox().props.value).toBe('Pixel 9'));
  });
});

describe('SettingsScreen sections', () => {
  const dev = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '', online: true, presence: 'online' as const, paired: true };

  it('shows the seven sections in the design order', async () => {
    render(
      <EngineProvider engine={fakeEngine([dev])}>
        <SettingsScreen
          downloadFolder={{ load: async () => null, choose: async () => null }}
          settingsHost={{ notifyPrefs: { load: async () => ({ arrival: true }), save: async () => {} } }}
          onCheckConnection={() => {}}
        />
      </EngineProvider>,
    );
    const titles = ['Device name', 'This device', 'Save files to', 'Arrival messages', 'Paired devices', 'Connection', 'About Daak'];
    await screen.findByText('Pixel 9');
    const tree = JSON.stringify(screen.toJSON());
    const at = titles.map((t) => tree.indexOf(JSON.stringify(t).slice(1, -1)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('toasts "Saved · {name}" after a save and "Type a name first" for a blank box', async () => {
    const engine = fakeEngine([]);
    let current = 'Desk';
    engine.selfProfile = async () => ({ name: current, baseName: current, deviceId: 'dd'.repeat(16) });
    const set = jest.spyOn(engine, 'setDisplayName').mockImplementation(async (n: string) => { current = n; });
    render(
      <EngineProvider engine={engine}>
        <ToastProvider>
          <SettingsScreen />
        </ToastProvider>
      </EngineProvider>,
    );
    const box = await screen.findByPlaceholderText('Display name');
    await waitFor(() => expect(box.props.value).toBe('Desk'));
    // Design: a blank box toasts and saves nothing.
    fireEvent.changeText(box, '   ');
    fireEvent.press(screen.getByTestId('save-name'));
    expect(await screen.findByText('Type a name first')).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
    // Design: a save toasts "Saved · {name}". It shows no inline success note.
    fireEvent.changeText(box, '  Study Room ');
    fireEvent.press(screen.getByTestId('save-name'));
    await waitFor(() => expect(set).toHaveBeenCalledWith('Study Room'));
    expect(await screen.findByText('Saved · Study Room')).toBeTruthy();
    expect(screen.queryByText('Saved on this device.')).toBeNull();
    expect(await screen.findByText('Saved as Study Room')).toBeTruthy();
  });

  it('keeps an error note and shows no toast when the name does not save', async () => {
    const engine = fakeEngine([]);
    engine.selfProfile = async () => ({ name: 'Desk', baseName: 'Desk', deviceId: 'dd'.repeat(16) });
    jest.spyOn(engine, 'setDisplayName').mockRejectedValue(new Error('disk full'));
    render(
      <EngineProvider engine={engine}>
        <ToastProvider>
          <SettingsScreen />
        </ToastProvider>
      </EngineProvider>,
    );
    const box = await screen.findByPlaceholderText('Display name');
    await waitFor(() => expect(box.props.value).toBe('Desk'));
    fireEvent.changeText(box, 'Study Room');
    fireEvent.press(screen.getByTestId('save-name'));
    expect(await screen.findByText('Name did not save')).toBeTruthy();
    expect(screen.getByText('disk full')).toBeTruthy();
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('shows the saved name and the presence switch in This device', async () => {
    const engine = fakeEngine([]);
    engine.selfProfile = async () => ({ name: 'Desk', baseName: 'Desk', deviceId: 'dd'.repeat(16) });
    render(
      <EngineProvider engine={engine}>
        <SettingsScreen deviceNoun="Mac" />
      </EngineProvider>,
    );
    expect(await screen.findByText('Saved as Desk')).toBeTruthy();
    expect(screen.getByText('This device')).toBeTruthy();
    expect(screen.getByText('Are you using this device right now?')).toBeTruthy();
    expect(screen.getByText('Other devices see this Mac as On this network.')).toBeTruthy();
  });

  // Design v2: macOS keeps "Change folder". iPhone has no picker in the
  // prototype, but both mobile hosts pass `choose` (Open question 14).
  it('shows Change folder when the host can choose a folder, and the no-picker words when it cannot', async () => {
    const { unmount } = render(
      <EngineProvider engine={fakeEngine([])}>
        <SettingsScreen downloadFolder={{ load: async () => null, choose: async () => null }} />
      </EngineProvider>,
    );
    expect(await screen.findByText('Change folder')).toBeTruthy();
    unmount();
    render(
      <EngineProvider engine={fakeEngine([])}>
        <SettingsScreen downloadFolder={{ load: async () => null }} />
      </EngineProvider>,
    );
    expect(await screen.findByText('Daak · On My iPhone')).toBeTruthy();
    expect(screen.queryByText('Change folder')).toBeNull();
  });

  it('shows the connection facts from the engine', async () => {
    render(
      <EngineProvider engine={fakeEngine([dev])}>
        <SettingsScreen />
      </EngineProvider>,
    );
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
  });

  it('shows the version from the host', async () => {
    render(
      <EngineProvider engine={fakeEngine([])}>
        <SettingsScreen settingsHost={{ appInfo: async () => ({ version: '1.2.3', build: '45' }) }} />
      </EngineProvider>,
    );
    expect(await screen.findByText('Version 1.2.3 (build 45)')).toBeTruthy();
  });
});


describe('SettingsScreen paired devices', () => {
  it('shows the paired devices and removes one through the engine', async () => {
    const d = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '', online: true, presence: 'online' as const, paired: true };
    const engine = fakeEngine([d]);
    const revoke = jest.spyOn(engine, 'revokePairing').mockResolvedValue();
    const onUnpair = jest.fn();
    render(
      <EngineProvider engine={engine}>
        <SettingsScreen onUnpair={onUnpair} />
      </EngineProvider>,
    );
    fireEvent.press(await screen.findByTestId('remove-' + d.deviceId));
    fireEvent.press(screen.getByTestId('confirm-remove'));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith(d.deviceId));
    await waitFor(() => expect(onUnpair).toHaveBeenCalledWith(d));
  });
});

describe('SettingsScreen Save files to', () => {
  it('hides the note and shows the reset button only for a custom folder', async () => {
    render(
      <EngineProvider engine={fakeEngine([])}>
        <SettingsScreen
          downloadFolder={{ load: async () => null, choose: async () => 'Photos', reset: async () => {} }}
        />
      </EngineProvider>,
    );
    await screen.findByTestId('download-folder-choose');
    // The design has no "Files are moved, not copied" note here.
    expect(screen.queryByText('Files are moved, not copied')).toBeNull();
    // No folder chosen: nothing to reset.
    expect(screen.queryByTestId('download-folder-reset')).toBeNull();
    fireEvent.press(screen.getByTestId('download-folder-choose'));
    expect(await screen.findByTestId('download-folder-reset')).toBeTruthy();
  });

  // Design index.html Settings: the "Saved as" hint and the Save button share
  // one row.
  it('puts the Save button in the row with the saved-name hint', async () => {
    const engine = fakeEngine([]);
    engine.selfProfile = async () => ({ name: 'Desk', baseName: 'Desk', deviceId: 'dd'.repeat(16) });
    render(
      <EngineProvider engine={engine}>
        <SettingsScreen />
      </EngineProvider>,
    );
    expect(await screen.findByText('Saved as Desk')).toBeTruthy();
    expect(within(screen.getByTestId('name-save-row')).getByTestId('save-name')).toBeTruthy();
  });
});

