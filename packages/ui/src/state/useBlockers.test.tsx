import React from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import type { DaakEngine } from '@daak/core';
import { useBlockers } from './useBlockers';
import type { IncompatiblePeer } from './store';

/**
 * THE BLOCKING FACTS, ONCE.
 *
 * These cases mount the hook itself against a fake engine rather than reading
 * the desktop shell, because a shell only forwards four values and a forward
 * cannot be wrong about WHICH screen a value opens. Every case here asserts on
 * the real rendered screen and on the real engine calls behind it.
 *
 * The fake is a partial object cast to DaakEngine, not fakeEngine(): this hook
 * calls exactly two engine methods, and a fake that implements twenty-two
 * others lets a case pass while the hook has started calling a twentieth.
 */

type Transfer = {
  transferId: string;
  peerDeviceId: string;
  state: string;
  bytesTotal: number;
};

type EngineStub = {
  devices: jest.Mock<Promise<{ deviceId: string }[]>, []>;
  listTransfers: jest.Mock<Promise<Transfer[]>, []>;
};

const peer = (deviceId: string) => ({ deviceId });

/**
 * Mount the hook AND its alert in ONE tree.
 *
 * renderHook and render each own their own react-test-renderer root, so a
 * case that calls render() on a value from renderHook() unmounts the hook's
 * root and the next query throws "Can't access .root on unmounted test
 * renderer". This component holds both, so a press on the rendered screen can
 * be observed on the NEXT hook value.
 */
function mountWithAlert(engine: DaakEngine, initialPeers: IncompatiblePeer[] = []) {
  const seen: ReturnType<typeof useBlockers> = {
    alert: undefined,
    alertRouteToken: undefined,
    settingsRouteToken: undefined,
    onCheckConnection: () => {},
  };
  function Harness({ peers }: { peers: IncompatiblePeer[] }) {
    Object.assign(seen, useBlockers(engine, peers));
    return <>{seen.alert}</>;
  }
  const ui = render(<Harness peers={initialPeers} />);
  return {
    current: () => seen,
    setPeers: (peers: IncompatiblePeer[]) =>
      act(() => {
        ui.rerender(<Harness peers={peers} />);
      }),
    press: (testID: string) =>
      act(() => {
        fireEvent.press(screen.getByLabelText(testID));
      }),
    screen,
  };
}

function stubEngine(over: Partial<EngineStub> = {}): EngineStub & DaakEngine {
  return {
    devices: jest.fn(async () => [] as { deviceId: string }[]),
    listTransfers: jest.fn(async () => [] as Transfer[]),
    ...over,
  } as unknown as EngineStub & DaakEngine;
}

const outOfStep: IncompatiblePeer = {
  peerDeviceId: 'aa'.repeat(16),
  peerName: "Darshit's Pixel",
  peerVersion: 5,
  ourVersion: 3,
};

const secondPeer: IncompatiblePeer = {
  peerDeviceId: 'bb'.repeat(16),
  peerName: 'Study Pi',
  peerVersion: 5,
  ourVersion: 3,
};

describe('useBlockers, which screen opens', () => {
  // R43b: the check runs when the user asks it. A mount-time devices() answers
  // "nobody" on a healthy LAN whenever the other device is asleep, and that
  // wall in front of a working app is worse than no screen at all.
  it('runs no engine call on mount', () => {
    const engine = stubEngine();
    renderHook(() => useBlockers(engine, []));
    expect(engine.devices).not.toHaveBeenCalled();
    expect(engine.listTransfers).not.toHaveBeenCalled();
  });

  it('shows nothing when no peer is out of step and no check has run', () => {
    const { result } = renderHook(() => useBlockers(stubEngine(), []));
    expect(result.current.alert).toBeUndefined();
    expect(result.current.alertRouteToken).toBeUndefined();
    expect(result.current.settingsRouteToken).toBeUndefined();
  });

  // The peer list is the host's, already reduced from peer.incompatible. The
  // hook renders it. It does not filter the list or reduce it again.
  it('opens update required as soon as a peer is out of step', () => {
    const { result } = renderHook(() => useBlockers(stubEngine(), [outOfStep]));
    render(<>{result.current.alert}</>);
    expect(screen.getByTestId('screen-update-required')).toBeTruthy();
    // The card has no "Latest" row. The screen shows no protocol number.
    expect(screen.queryByText('Latest')).toBeNull();
    expect(screen.queryByText(/Protocol/)).toBeNull();
  });

  // A peer that is behind means this app is the newer one. No download exists
  // for this user, and the screen says "a new version is available".
  it('does not open update available for a peer that is behind this app', () => {
    const behind = { ...outOfStep, peerDeviceId: 'cc'.repeat(16), peerVersion: 1, ourVersion: 3 };
    const { result } = renderHook(() => useBlockers(stubEngine(), [behind]));
    expect(result.current.alert).toBeUndefined();
    expect(result.current.alertRouteToken).toBeUndefined();
  });

  // Update Required wins over Cant Reach: an incompatible peer is a fact the
  // engine reported, while an empty list may only mean nobody is home yet.
  it('prefers update required over cannot-reach when both conditions hold', async () => {
    const engine = stubEngine({ devices: jest.fn(async () => []) });
    const { result } = renderHook(() => useBlockers(engine, [outOfStep]));
    await act(async () => {
      result.current.onCheckConnection();
    });
    render(<>{result.current.alert}</>);
    expect(screen.getByTestId('screen-update-required')).toBeTruthy();
    expect(screen.queryByTestId('screen-cant-reach')).toBeNull();
  });
});

describe('useBlockers, the reachability check', () => {
  it('opens cannot-reach when the engine finds nobody', async () => {
    const engine = stubEngine({ devices: jest.fn(async () => []) });
    const { result } = renderHook(() => useBlockers(engine, []));
    await act(async () => {
      result.current.onCheckConnection();
    });
    render(<>{result.current.alert}</>);
    expect(screen.getByTestId('screen-cant-reach')).toBeTruthy();
    // The empty answer is its own text. A rejection never reaches here.
    expect(screen.getByText("Daak can't reach any devices")).toBeTruthy();
    expect(result.current.alertRouteToken).toBe('cant-reach');
  });

  // Somebody is there: the device list was already telling the truth, so a
  // "cannot reach" wall beside it would be the app contradicting itself.
  it('stays quiet when the engine finds a peer', async () => {
    const engine = stubEngine({ devices: jest.fn(async () => [peer('bb')]) });
    const { result } = renderHook(() => useBlockers(engine, []));
    await act(async () => {
      result.current.onCheckConnection();
    });
    expect(result.current.alert).toBeUndefined();
    expect(result.current.alertRouteToken).toBeUndefined();
    // ONE real call. A second one here would double a daemon round trip.
    expect(engine.devices).toHaveBeenCalledTimes(1);
  });

  // A rejected check is NOT nobody at home. The engine is up and not answering,
  // and the screen must say which of the two happened.
  it('says the check failed, and not that nobody is home, when devices() rejects', async () => {
    const engine = stubEngine({
      devices: jest.fn(async () => {
        throw new Error('daakd is not answering');
      }),
    });
    const { result } = renderHook(() => useBlockers(engine, []));
    await act(async () => {
      result.current.onCheckConnection();
    });
    render(<>{result.current.alert}</>);
    // Note carries its testID as the accessibilityLabel, which is what the
    // OnboardingScreens cases query. getByTestId finds nothing here.
    expect(screen.getByLabelText('cant-reach-error')).toBeTruthy();
    expect(screen.getByText('daakd is not answering')).toBeTruthy();
    expect(screen.queryByText("Daak can't reach any devices")).toBeNull();
  });

  // The outbox is REAL, filtered to what is still waiting. A synthesised queue
  // would prove nothing about the promise the screen makes.
  it('passes the real waiting transfers, and drops the done and failed ones', async () => {
    const engine = stubEngine({
      devices: jest.fn(async () => []),
      listTransfers: jest.fn(async () => [
        { transferId: 't1', peerDeviceId: 'ccccdddd'.repeat(4), state: 'pending', bytesTotal: 900 },
        { transferId: 't2', peerDeviceId: 'eeee'.repeat(8), state: 'done', bytesTotal: 10 },
        { transferId: 't3', peerDeviceId: 'ffff'.repeat(8), state: 'failed', bytesTotal: 10 },
      ]),
    });
    const { result } = renderHook(() => useBlockers(engine, []));
    await act(async () => {
      result.current.onCheckConnection();
    });
    render(<>{result.current.alert}</>);
    expect(screen.getAllByTestId('cant-reach-queued')).toHaveLength(1);
    expect(screen.getByText('To ccccdddd')).toBeTruthy();
    expect(screen.getByText('900 B')).toBeTruthy();
  });

  // A queue Daak cannot read is not evidence either way, so the screen says
  // nothing about waiting sends rather than claiming none exist.
  it('shows no queue when listTransfers() rejects', async () => {
    const engine = stubEngine({
      devices: jest.fn(async () => []),
      listTransfers: jest.fn(async () => {
        throw new Error('the database is closed');
      }),
    });
    const { result } = renderHook(() => useBlockers(engine, []));
    await act(async () => {
      result.current.onCheckConnection();
    });
    render(<>{result.current.alert}</>);
    expect(screen.getByTestId('screen-cant-reach')).toBeTruthy();
    expect(screen.queryByTestId('cant-reach-queued')).toBeNull();
  });
});

describe('useBlockers, a peer that re-announces on a timer', () => {
  const mount = () => mountWithAlert(stubEngine());

  // The engine re-announces on a timer. A repeat announcement of the SAME peer
  // is the same fact restated, so the screen must stay up rather than cycle.
  it('leaves the screen open when the same peer announces again', () => {
    const h = mount();
    h.setPeers([outOfStep]);
    h.setPeers([outOfStep]);
    expect(h.current().alert).not.toBeUndefined();
    expect(h.current().alertRouteToken).toBe(outOfStep.peerDeviceId);
  });

  // Remind me later closes the screen WITHOUT navigating, and the peer is now
  // in the shown set, so its next announcement must not put the screen back up.
  // A timer that re-opened it would make the button impossible to use.
  it('does not reopen the screen after the user dismissed it', () => {
    const h = mount();
    h.setPeers([outOfStep]);
    h.press('update-dismiss');
    expect(h.current().alert).toBeUndefined();
    expect(h.current().alertRouteToken).toBeUndefined();
    // The dismissal is not consent to be navigated.
    expect(h.current().settingsRouteToken).toBeUndefined();

    h.setPeers([outOfStep]);
    expect(h.current().alert).toBeUndefined();
  });

  // Two out-of-step devices are two separate facts. The second one still gets
  // its own screen, even though the first was already on it.
  it('still opens the screen for a peer it has not shown it to before', () => {
    const h = mount();
    h.setPeers([outOfStep]);
    h.press('update-dismiss');
    h.setPeers([outOfStep, secondPeer]);
    expect(h.current().alert).not.toBeUndefined();
    expect(h.current().alertRouteToken).toBe(secondPeer.peerDeviceId);
  });
});

describe('useBlockers, Open Settings', () => {
  // The cannot-reach screen is the only blocking screen with this button. It
  // must clear the alert and bump the settings route in ONE render, and the
  // token must fire again when asked twice. A boolean would not.
  it('clears the cannot-reach screen and routes to Settings, every time', async () => {
    const engine = stubEngine({ devices: jest.fn(async () => []) });
    const h = mountWithAlert(engine);
    await act(async () => {
      h.current().onCheckConnection();
    });
    h.press('cant-reach-settings');
    expect(h.current().alert).toBeUndefined();
    expect(h.current().alertRouteToken).toBeUndefined();
    expect(h.current().settingsRouteToken).toBe('1');

    await act(async () => {
      h.current().onCheckConnection();
    });
    h.press('cant-reach-settings');
    expect(h.current().settingsRouteToken).toBe('2');
  });
});

describe('useBlockers, Update available', () => {
  const info = { version: '1.2.3', build: '45' };

  function mountHost(engine: DaakEngine, host: Parameters<typeof useBlockers>[2]) {
    const seen = { current: undefined as ReturnType<typeof useBlockers> | undefined };
    function Harness({ peers }: { peers: IncompatiblePeer[] }) {
      seen.current = useBlockers(engine, peers, host);
      return <>{seen.current.alert}</>;
    }
    const ui = render(<Harness peers={[]} />);
    return {
      current: () => seen.current as ReturnType<typeof useBlockers>,
      setPeers: (peers: IncompatiblePeer[]) =>
        act(() => {
          ui.rerender(<Harness peers={peers} />);
        }),
    };
  }

  it('opens the releases page through the host opener and leaves the screen up', async () => {
    const openUrl = jest.fn();
    const h = mountHost(stubEngine(), { openUrl });
    await h.setPeers([outOfStep]);
    fireEvent.press(screen.getByLabelText('update-open'));
    expect(openUrl).toHaveBeenCalledWith('https://github.com/darshitpp/daak/releases/latest');
    expect(h.current().alert).not.toBeUndefined();
    expect(h.current().settingsRouteToken).toBeUndefined();
  });

  // "Remind me later" and the back arrow both dismiss. Neither routes to Settings.
  it('dismisses from the back arrow without routing', async () => {
    const h = mountHost(stubEngine(), undefined);
    await h.setPeers([outOfStep]);
    fireEvent.press(screen.getByLabelText('Back'));
    expect(h.current().alert).toBeUndefined();
    expect(h.current().settingsRouteToken).toBeUndefined();
  });

  it('shows the app version once it loads', async () => {
    const h = mountHost(stubEngine(), { appInfo: async () => info });
    await h.setPeers([outOfStep]);
    expect(await screen.findByText('Version 1.2.3 (build 45)')).toBeTruthy();
  });

  // The host may be a sync function, and it may fail. The screen must still
  // open, with no "This app" row.
  it('accepts a sync appInfo', async () => {
    const h = mountHost(stubEngine(), { appInfo: () => info });
    await h.setPeers([outOfStep]);
    expect(await screen.findByText('Version 1.2.3 (build 45)')).toBeTruthy();
  });

  it('shows the screen with no app row when appInfo throws', async () => {
    const h = mountHost(stubEngine(), {
      appInfo: () => {
        throw new Error('no native module');
      },
    });
    await h.setPeers([outOfStep]);
    await act(async () => {});
    expect(screen.getByTestId('screen-update-required')).toBeTruthy();
    expect(screen.queryByText('This app')).toBeNull();
  });

  // A host that builds its object inline gets a new identity on every render.
  // The load must not run again for that, or the screen would loop.
  it('loads the app version once for one open screen, even with a new host object on every render', async () => {
    const appInfo = jest.fn(async () => info);
    const engine = stubEngine();
    const seen = { current: undefined as ReturnType<typeof useBlockers> | undefined };
    function Harness({ peers }: { peers: IncompatiblePeer[] }) {
      seen.current = useBlockers(engine, peers, { appInfo });
      return <>{seen.current.alert}</>;
    }
    const ui = render(<Harness peers={[]} />);
    await act(async () => {
      ui.rerender(<Harness peers={[outOfStep]} />);
    });
    await act(async () => {});
    expect(appInfo).toHaveBeenCalledTimes(1);
  });
});

describe('useBlockers, the retry on the cannot-reach screen', () => {
  it('asks the engine again, and says it is looking while it waits', async () => {
    // The FIRST call resolves empty, so the screen opens. Only the SECOND call
    // is left pending: a promise that never settles inside act() never paints,
    // and a promise that settles immediately gives the flag no window at all.
    let release: (() => void) | undefined;
    let calls = 0;
    const engine = stubEngine({
      devices: jest.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.resolve([] as { deviceId: string }[]);
        return new Promise<{ deviceId: string }[]>((resolve) => {
          release = () => resolve([]);
        });
      }),
    });
    const h = mountWithAlert(engine);
    await act(async () => {
      h.current().onCheckConnection();
    });
    expect(h.screen.getByText('Try again')).toBeTruthy();

    h.press('cant-reach-retry');
    // The screen is still open and the button now reads as working.
    expect(h.screen.getByText('Checking')).toBeTruthy();
    expect(engine.devices).toHaveBeenCalledTimes(2);

    await act(async () => {
      release?.();
    });
    expect(h.screen.getByText('Try again')).toBeTruthy();
  });

  // A stuck send is the reason a user taps Retry, so the retry must re-read the
  // outbox as well as re-ask the question. An early return on the reachable path
  // would leave the same stuck rows on screen.
  it('re-reads the outbox on every check, not only the first', async () => {
    const engine = stubEngine({
      devices: jest.fn(async () => [peer('bb')]),
      listTransfers: jest.fn(async () => [
        { transferId: 't1', peerDeviceId: 'aaaaaaaa', state: 'pending', bytesTotal: 7 },
      ]),
    });
    const h = mountWithAlert(engine);
    await act(async () => {
      h.current().onCheckConnection();
    });
    expect(engine.listTransfers).toHaveBeenCalledTimes(1);

    // Now the peer is gone, so the screen opens and Retry becomes reachable.
    (engine.devices as jest.Mock).mockImplementation(async () => []);
    await act(async () => {
      h.current().onCheckConnection();
    });
    await act(async () => {
      fireEvent.press(h.screen.getByLabelText('cant-reach-retry'));
    });
    expect(engine.devices).toHaveBeenCalledTimes(3);
    expect(engine.listTransfers).toHaveBeenCalledTimes(3);
    expect(h.screen.getByText('To aaaaaaaa')).toBeTruthy();
  });
});

describe('useBlockers, the host argument', () => {
  it('gives the device noun to the cannot-reach screen', async () => {
    const engine = stubEngine({ devices: jest.fn(async () => []) });
    const { result } = renderHook(() => useBlockers(engine, [], { deviceNoun: 'Mac' }));
    await act(async () => {
      result.current.onCheckConnection();
    });
    render(<>{result.current.alert}</>);
    expect(screen.getByText('This Mac is on this Wi-Fi. The devices you paired need to be on the same network too.')).toBeTruthy();
  });

  it('says "device" when the host gives no noun', async () => {
    const engine = stubEngine({ devices: jest.fn(async () => []) });
    const { result } = renderHook(() => useBlockers(engine, []));
    await act(async () => {
      result.current.onCheckConnection();
    });
    render(<>{result.current.alert}</>);
    expect(screen.getByText('This device is on this Wi-Fi. The devices you paired need to be on the same network too.')).toBeTruthy();
  });
});
