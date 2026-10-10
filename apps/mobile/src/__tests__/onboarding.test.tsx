import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import App from '../App';

// The real @daak/platform barrel pulls cbor-x (ESM) in through @daak/core and
// jest cannot parse it. OnboardingFlow is the only thing under test here, and
// the keystore answers below are what it asks for, so the barrel is swapped
// for the same facades the flow really uses.
// The mock-prefixed names are not decoration. babel-plugin-jest-hoist refuses
// a factory that references any out-of-scope variable except those beginning
// with `mock`, and this factory has to call real jest.fn()s to let a test drive
// the answers. Naming them readOnboarding/writeOnboarding fails at transform
// time with "the module factory of jest.mock() is not allowed to reference any
// out-of-scope variables" -- before a single test runs.
const mockReadOnboarding = jest.fn();
const mockWriteOnboarding = jest.fn(async () => true);
// The OS's own answer to the arrival-banner ask, as a test can change it. Kept
// as a mutable mock-prefixed binding for the same hoisting reason as the two
// above.
let mockGranted: boolean | undefined = true;
// What the OS will answer when the user taps the row, standing in for the
// real initNotifications() ask. A mutable mock-prefixed binding because the
// hoisting rule allows no other out-of-scope name in a jest.mock factory.
let mockAskAnswer: boolean = true;
const mockPermissionRows = (facts: { notificationsGranted?: boolean }) => ({
  rows: [
    {
      key: 'alerts',
      title: 'Alerts when a file arrives',
      sub: 'A short banner so you know something came in.',
      state: facts.notificationsGranted === true ? ('on' as const) : ('off' as const),
    },
  ],
});
jest.mock('@daak/platform', () => ({
  pickFiles: jest.fn(async () => []),
  readOnboarding: (...args: unknown[]) => mockReadOnboarding(...args),
  writeOnboarding: (...args: unknown[]) => mockWriteOnboarding(...(args as [])),
  INITIAL_ONBOARDING: { complete: false, discovery: false, alerts: false },
  permissionRows: (facts: { notificationsGranted?: boolean }) => mockPermissionRows(facts),
  // R42p: the download folder. An unset folder answers null, and the move
  // returns its input unchanged -- which is the real no-op path, not a stub
  // that hides a difference.
  chooseDownloadFolder: jest.fn(async () => null),
  downloadFolderName: jest.fn(async () => null),
  clearDownloadFolder: jest.fn(async () => undefined),
  moveReceivedFiles: jest.fn(async (paths: string[]) => paths),
  relocateReceivedFiles: jest.fn(async () => undefined),
  // The re-ask wrapper returns the SAME rows with a real handler bound to the
  // alerts one. Two earlier versions of this mock broke the flow in ways that
  // looked like product bugs: returning [] rendered an empty permission list,
  // and returning the rows without handlers meant the flow's `granted` state
  // never moved -- so `stillNeeded` never emptied and Continue stayed disabled
  // forever, with no visible cause.
  withNotificationReask: (
    facts: { notificationsGranted?: boolean },
    onAsked: (granted: boolean) => void,
  ) =>
    mockPermissionRows(facts).rows.map((row) =>
      row.key === 'alerts' ? { ...row, onPress: () => onAsked(mockAskAnswer) } : row,
    ),
}));

jest.mock('../BackgroundSyncNotice', () => ({ BackgroundSyncNotice: () => null }));
jest.mock('../PairingFlow', () => ({ PairingFlow: () => null }));

jest.mock('../bootstrap', () => ({
  engine: jest.requireActual('@daak/ui').fakeEngine(),
  startEngine: async () => {},
  startEngineOnce: jest.fn(async () => {}),
  drainInbound: jest.fn(async () => {}),
  wireNotificationActions: jest.fn(() => () => {}),
  sendIntentItems: jest.fn(async () => {}),
  // The peer.incompatible fan-out off the ONE engine subscription. Every file
  // that renders App needs it: the import is undefined without it, and the
  // mount effect throws before the shell renders at all.
  onIncompatiblePeer: jest.fn(() => () => {}),
  postReceiveNotifications: jest.fn(async () => true),
  notificationGrant: jest.fn(() => mockGranted),
  recordNotificationGrant: jest.fn(),
}));

const { startEngineOnce, engine } = jest.requireMock('../bootstrap');

/** A promise a test resolves by hand, standing in for an engine that is still
 *  starting. Without this the only reachable state is "already started", and a
 *  flow that rendered Pair in the same tick as the readiness request would
 *  pass every test in this file. */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteOnboarding.mockResolvedValue(true);
  // UNDEFINED, not true: initNotifications has not run at this point, because
  // the engine has not started. That is the real first-launch value, and it is
  // what keeps the prototype's own Continue gate honest -- a test that granted
  // it up front would be asserting against a state the app is never in.
  // packages/platform/src/permission-rows.test.ts is where the granted,
  // denied and unasked renderings are proven on their own.
  mockGranted = undefined;
  mockAskAnswer = true;
});

const firstLaunch = { complete: false, discovery: false, alerts: false };
const returning = { complete: true, name: 'Seawood Otter', discovery: true, alerts: true };

/** Welcome, Name (typed), Permissions. Stops on the Save-location step. */
async function reachSaveStep() {
  mockReadOnboarding.mockResolvedValue(firstLaunch);
  render(<App />);
  await waitFor(() => screen.getByLabelText('welcome-get-started'));
  fireEvent.press(screen.getByLabelText('welcome-get-started'));
  await waitFor(() => screen.getByTestId('name-input'));
  fireEvent.changeText(screen.getByTestId('name-input'), 'Seawood Otter');
  fireEvent.press(screen.getByLabelText('name-next'));
  await waitFor(() => screen.getByLabelText('permissions-continue'));
  await act(async () => {
    fireEvent.press(screen.getByLabelText('permissions-continue'));
  });
  await screen.findByLabelText('save-location-continue');
}

/** The same, then Continue on the Save-location step. */
async function reachPairStep() {
  await reachSaveStep();
  await act(async () => {
    fireEvent.press(screen.getByLabelText('save-location-continue'));
  });
}

describe('first launch', () => {
  it('asks to name the device before it starts an engine', async () => {
    mockReadOnboarding.mockResolvedValue(firstLaunch);
    render(<App />);
    await waitFor(() => expect(screen.getByText('Send anything to a phone next door')).toBeTruthy());
    // Nothing may publish an engine-backed name before the user chose one.
    expect(startEngineOnce).not.toHaveBeenCalled();
  });

  it('walks welcome to name to permissions', async () => {
    mockReadOnboarding.mockResolvedValue(firstLaunch);
    render(<App />);
    await waitFor(() => screen.getByLabelText('welcome-get-started'));
    fireEvent.press(screen.getByLabelText('welcome-get-started'));

    await waitFor(() => screen.getByTestId('name-input'));
    fireEvent.press(screen.getByLabelText('name-next'));
    expect(screen.getByTestId('name-error')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('name-input'), 'Seawood Otter');
    fireEvent.press(screen.getByLabelText('name-next'));

    await waitFor(() => expect(screen.getByText('Optional alerts')).toBeTruthy());
    expect(screen.getByText('Alerts when a file arrives')).toBeTruthy();
    expect(screen.queryByText('Local network')).toBeNull();
  });

  it('lets the user continue with alerts off', async () => {
    mockReadOnboarding.mockResolvedValue(firstLaunch);
    render(<App />);
    await waitFor(() => screen.getByLabelText('welcome-get-started'));
    fireEvent.press(screen.getByLabelText('welcome-get-started'));
    await waitFor(() => screen.getByTestId('name-input'));
    fireEvent.changeText(screen.getByTestId('name-input'), 'Seawood Otter');
    fireEvent.press(screen.getByLabelText('name-next'));
    await waitFor(() => screen.getByLabelText('permissions-continue'));
    expect(screen.getByTestId('permissions-hint').props.children).toBe('Alerts are off. You can continue without them.');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('permissions-continue'));
    });
    await screen.findByLabelText('save-location-continue');
    const written = (mockWriteOnboarding.mock.calls[0] as unknown[])[0] as { alerts?: boolean };
    expect(written.alerts).toBe(false);
  });

  it('does not write anything until the user has actually answered', async () => {
    mockReadOnboarding.mockResolvedValue(firstLaunch);
    render(<App />);
    await waitFor(() => screen.getByLabelText('welcome-get-started'));
    expect(mockWriteOnboarding).not.toHaveBeenCalled();
  });

  // REGRESSION. The Welcome skip used to write complete:true and stop there:
  // it never told the parent, so Welcome stayed on screen until a relaunch. A
  // user who had already paired their phone would be stuck staring at the
  // first-run screen for the rest of the session.
  it('leaves Welcome on the skip path, not just in the keystore', async () => {
    mockReadOnboarding.mockResolvedValue(firstLaunch);
    render(<App />);
    await waitFor(() => screen.getByLabelText('welcome-skip'));
    fireEvent.press(screen.getByLabelText('welcome-skip'));
    await waitFor(() => expect(startEngineOnce).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText('welcome-skip')).toBeNull();
  });

  // The skip swaps the whole tree for the shell, and the shell asks the engine
  // for a device list on its first render. Completing before the engine is up
  // would show an empty Devices tab with no cause, which is the same "nobody is
  // home" lie the update-required screen exists to avoid.
  it('waits for the engine before the skip hands over to the shell', async () => {
    const startup = deferred();
    startEngineOnce.mockReturnValueOnce(startup.promise);
    mockReadOnboarding.mockResolvedValue(firstLaunch);
    render(<App />);
    await waitFor(() => screen.getByLabelText('welcome-skip'));
    await act(async () => {
      fireEvent.press(screen.getByLabelText('welcome-skip'));
    });
    expect(screen.queryByTestId('tab-devices')).toBeNull();

    await act(async () => {
      startup.release();
      await startup.promise;
    });
    await waitFor(() => expect(screen.getByTestId('tab-devices')).toBeTruthy());
  });

  // REGRESSION, and the one that mattered most. Reaching the pairing step
  // without a running engine means armHostPairing resolves against nothing, so
  // the very device being paired for the first time could not be paired. The
  // fix is structural: OnboardingFlow owns no engine and App.tsx has the only
  // start call site, so the engine is necessarily up before Pair renders.
  it('has a running engine by the time the pairing step is reachable', async () => {
    await reachPairStep();

    await waitFor(() => expect(startEngineOnce).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText('pair-skip')).toBeTruthy();
  });

  // A completion that cannot be remembered must not advance the UI, or every
  // question comes back on the next launch with no explanation.
  it('refuses to finish when the keystore will not take the write', async () => {
    mockReadOnboarding.mockResolvedValue(firstLaunch);
    mockWriteOnboarding.mockResolvedValue(false);
    render(<App />);
    await waitFor(() => screen.getByLabelText('welcome-skip'));
    fireEvent.press(screen.getByLabelText('welcome-skip'));
    expect(await screen.findByTestId('onboarding-fault')).toBeTruthy();
    expect(startEngineOnce).not.toHaveBeenCalled();
  });

  // THE regression this shape exists for, and the one the previous test could
  // not see. That test asserted startEngineOnce HAD BEEN CALLED by the time
  // Pair rendered, which is a statement about the call, not about the engine.
  // startEngineOnce is async, so the call can be in flight while the engine is
  // still starting -- and PairingFlow arms a real accept slot through it.
  //
  // Here startup is held open on purpose: if Pair renders before the promise
  // settles, the arming control is on screen against an engine that is not
  // there, and that is the bug in its exact shipping shape.
  it('does not reach the pairing step while the engine is still starting', async () => {
    const startup = deferred();
    startEngineOnce.mockReturnValueOnce(startup.promise);
    await reachPairStep();

    // The write has landed and startup is genuinely in flight.
    await waitFor(() => expect(startEngineOnce).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('onboarding-starting')).toBeTruthy();
    // THE assertion. The arming control must not exist yet.
    expect(screen.queryByLabelText('pair-skip')).toBeNull();

    await act(async () => {
      startup.release();
      await startup.promise;
    });
    expect(await screen.findByLabelText('pair-skip')).toBeTruthy();
  });
});


describe('the Save-location step', () => {
  it('follows Permissions, writes the name there, and does not start the engine', async () => {
    await reachSaveStep();
    expect(screen.getByText('Where to save files')).toBeTruthy();
    expect(screen.getByText('One quick step left.')).toBeTruthy();
    expect(mockWriteOnboarding).toHaveBeenCalledTimes(1);
    expect((mockWriteOnboarding.mock.calls[0] as unknown[])[0]).toMatchObject({ name: 'Seawood Otter', complete: false });
    expect(startEngineOnce).not.toHaveBeenCalled();
  });

  it('starts the engine on Continue and then shows the pairing step', async () => {
    await reachPairStep();
    await waitFor(() => expect(startEngineOnce).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText('pair-skip')).toBeTruthy();
    expect(screen.getByText('Pair your first device')).toBeTruthy();
  });

  it('lets the user pick a folder with the platform verbs', async () => {
    const { chooseDownloadFolder } = jest.requireMock('@daak/platform');
    chooseDownloadFolder.mockResolvedValueOnce('Documents / Daak');
    await reachSaveStep();
    fireEvent.press(await screen.findByLabelText('download-folder-choose'));
    expect(await screen.findByText('Documents / Daak')).toBeTruthy();
    expect(chooseDownloadFolder).toHaveBeenCalledTimes(1);
  });

  it('goes back to Permissions without starting the engine', async () => {
    await reachSaveStep();
    fireEvent.press(screen.getByTestId('onb-back'));
    expect(await screen.findByLabelText('permissions-continue')).toBeTruthy();
    expect(startEngineOnce).not.toHaveBeenCalled();
  });

  // Review Focus 1. The keystore holds the name after Permissions. A kill on the
  // Save-location step leaves { complete: false, name }. The next launch starts
  // at Welcome with the name typed and the engine stopped.
  it('resumes at Welcome with the saved name after an app kill', async () => {
    mockReadOnboarding.mockResolvedValue({ complete: false, name: 'Seawood Otter', discovery: true, alerts: false });
    render(<App />);
    await waitFor(() => screen.getByLabelText('welcome-get-started'));
    expect(startEngineOnce).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText('welcome-get-started'));
    expect((await screen.findByTestId('name-input')).props.value).toBe('Seawood Otter');
  });

  it('shows no step counter on any step', async () => {
    await reachSaveStep();
    expect(screen.queryByText(/Step \d of \d/)).toBeNull();
  });

  // Commit 552459d. The engine keeps a new pairing pending until the user presses
  // "They match" (`confirmPairing`). The SAS event is not a finished pairing,
  // so the Pair step must stay open. Only `pairing.done` ends it (R42n).
  it('keeps the Pair step open when a SAS arrives and ends it only on pairing.done', async () => {
    await reachPairStep();
    expect(await screen.findByLabelText('pair-skip')).toBeTruthy();
    const handlers = (engine as unknown as { __handlers: Set<(e: unknown) => void> }).__handlers;
    await act(async () => {
      handlers.forEach((h) => h({ type: 'pairing.sas', peerDeviceId: 'aa'.repeat(16), sas: '482917' }));
    });
    const lastWrite = () => {
      const last = mockWriteOnboarding.mock.calls.at(-1) as unknown[] | undefined;
      return last?.[0] as { complete?: boolean } | undefined;
    };
    expect(lastWrite()?.complete).not.toBe(true);
    expect(screen.getByLabelText('pair-skip')).toBeTruthy();
    await act(async () => {
      handlers.forEach((h) => h({ type: 'pairing.done', deviceId: 'aa'.repeat(16) }));
    });
    await waitFor(() => expect(lastWrite()?.complete).toBe(true));
  });
});

describe('a keystore that cannot be read', () => {
  // A rejection is deliberately NOT treated as "not onboarded": re-running
  // onboarding on a locked keystore is how a user re-pairs a device they
  // already paired. It must be visible, and nothing may be written.
  it('says so instead of silently re-running onboarding', async () => {
    mockReadOnboarding.mockRejectedValue(new Error('keychain read failed'));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('onboarding-fault')).toBeTruthy());
    expect(screen.getByText(/keychain read failed/)).toBeTruthy();
    expect(mockWriteOnboarding).not.toHaveBeenCalled();
    expect(startEngineOnce).not.toHaveBeenCalled();
  });
});

describe('every launch after the first', () => {
  it('goes straight to the shell and applies NO name', async () => {
    mockReadOnboarding.mockResolvedValue(returning);
    // The engine handed to App is a fake, so setDisplayName must be a spy or
    // the assertion below has nothing to match.
    const setDisplayName = jest.spyOn(engine, 'setDisplayName');
    render(<App />);
    await waitFor(() => expect(startEngineOnce).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('tab-devices')).toBeTruthy());
    expect(screen.queryByText('Send anything to a phone next door')).toBeNull();
    // R42: the keychain name is NOT replayed. The engine read the real name out
    // of SQLite during start, so applying the first-run copy here would undo
    // every rename the user has made in Settings since -- on every launch.
    // setDisplayName resolves against the LAN, so the old order required the
    // engine to be up first; that constraint is gone with the call.
    await act(async () => {});
    expect(setDisplayName).not.toHaveBeenCalled();
  });

  // The other half of R42, and the reason removing the replay is safe: a FIRST
  // run has no stored name at all, so the engine comes up with the machine
  // default and the name the user typed must still be applied by hand.
  //
  // Without this, "stop replaying the keychain copy" would also mean "never
  // apply a first-run name", and every new install would advertise the
  // hostname forever.
  it('applies the name typed on a first run once the engine is up', async () => {
    mockReadOnboarding.mockResolvedValue(firstLaunch);
    const setDisplayName = jest.spyOn(engine, 'setDisplayName');
    await reachPairStep();

    await waitFor(() => expect(setDisplayName).toHaveBeenCalledWith('Seawood Otter'));
  });

  // R42n: pairing a device IS the Pair step's result. Before this the only exit
  // was "Skip for now", so a user who had just paired was asked to skip the
  // step they had completed -- and the reported "scanning the QR puts me back on
  // the onboarding screen" was the same defect from the other side.
  it('finishes onboarding when a pairing completes, with no skip tap', async () => {
    await reachPairStep();
    expect(await screen.findByLabelText('pair-skip')).toBeTruthy();

    // The engine's OWN event, driven through the live handlers the flow
    // subscribed to. Nothing here taps Skip.
    const handlers = (engine as unknown as { __handlers: Set<(e: unknown) => void> }).__handlers;
    await act(async () => {
      handlers.forEach((h) => h({ type: 'pairing.done', deviceId: 'aa'.repeat(16) }));
    });

    await waitFor(() => {
      // The mock is declared with no parameters, so its call tuple is `[]` and
      // indexing it needs the cast. The REAL write takes the next state.
      const last = mockWriteOnboarding.mock.calls.at(-1) as unknown[] | undefined;
      const written = last?.[0] as { complete?: boolean } | undefined;
      expect(written?.complete).toBe(true);
    });
  });
});
