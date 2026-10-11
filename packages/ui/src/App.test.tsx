import React from 'react';
import { Text } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { DaakUiApp } from './App';
import { createUiRuntime } from './headless';
import { fakeEngine } from './testing/fakeEngine';
import { useToast } from './components/Toast';
import type { UiState } from './state/store';
import { CANT_REACH_TOKEN } from './state/useBlockers';
import type { DaakEvent } from '@daak/core';

describe('DaakUiApp', () => {
  it('renders the popover from the folded state', () => {
    const engine = fakeEngine();
    const bus = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
    const runtime = createUiRuntime(engine);
    render(<DaakUiApp mode="popover" engine={engine} runtime={runtime} />);
    act(() => {
      bus.forEach((h) => h({ type: 'device.discovered', device: { deviceId: 'a', name: 'A', addr: '1.2.3.4:1', paired: true } }));
    });
    // The device name and the avatar initial are the same letter here, so this
    // pins the row rather than counting name matches.
    expect(screen.getByLabelText('open-dashboard')).toBeTruthy();
    expect(screen.getAllByText('A').length).toBeGreaterThan(0);
  });

  // finding 8: useSyncExternalStore resubscribes whenever `subscribe` changes
  // identity, and an inline arrow changed on every render the event caused.
  it('does not resubscribe once per event', () => {
    const engine = fakeEngine();
    const bus = (engine as unknown as { __handlers: Set<(e: DaakEvent) => void> }).__handlers;
    const runtime = createUiRuntime(engine);
    let subscribes = 0;
    const counting: typeof runtime = {
      getState: runtime.getState,
      prime: runtime.prime,
      subscribe: (l: (s: UiState) => void) => {
        subscribes += 1;
        return runtime.subscribe(l);
      },
    };
    render(<DaakUiApp mode="popover" engine={engine} runtime={counting} />);
    expect(subscribes).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        bus.forEach((h) => h({ type: 'inbox.received', payload: { payloadId: String(i) } as never }));
      });
    }
    expect(subscribes).toBe(1);
  });

  // R43. The popover is a whole window the user sees from the menu bar, and it
  // DROPPED the blocking screens: DaakUiApp forwarded `alert` and
  // `alertRouteToken` to Dashboard only, so a peer on another protocol version
  // reached the dashboard window and never reached the menu-bar panel. The
  // dashboard branch had the pair and the popover branch did not, which is the
  // whole defect.
  //
  // BEHAVIOURAL, not a source pin: the reviewer found that the desktop's
  // blocking-screen suite is source-shape only, so a shell could satisfy every
  // source pin and still drop the node on the way into Popover. This mounts the
  // real tree with the real host props and asserts on what is drawn.
  it('renders the cannot-reach screen in the popover, and no panel', () => {
    const engine = fakeEngine();
    const runtime = createUiRuntime(engine);
    render(
      <DaakUiApp
        mode="popover"
        engine={engine}
        runtime={runtime}
        alert={<Text testID="blocking-alert">Cannot reach</Text>}
        alertRouteToken={CANT_REACH_TOKEN}
      />,
    );
    expect(screen.getByTestId('blocking-alert')).toBeTruthy();
    // The panel must be GONE, not merely covered: a Send button beside a
    // claim that Daak cannot proceed is a lie about what works. The dashboard
    // branch drops the tab bar for the same reason.
    expect(screen.queryByLabelText('open-dashboard')).toBeNull();
    // R43e: the wordmark row STAYS above the alert, and this pins it. Without
    // the assertion a later edit that drops the mark while blocked passes every
    // other case here.
    //
    // Queried by label, NOT by text. The wordmark draws the letter `D` and then
    // `aak` as two separate Text nodes, so a text query for "Daak" finds
    // nothing at all. The label on the wrapping View is the real handle.
    expect(screen.getAllByLabelText('Daak').length).toBeGreaterThan(0);
  });

  // P6 ruling: Update available is a BANNER above the list, so the panel STAYS
  // and Send keeps working. The panel draws its own two-line banner with the
  // design words, so the alert node is not drawn for it. The cannot-reach case
  // above still proves the node reaches the popover.
  it('keeps the panel for an update notice, and shows the banner', () => {
    const engine = fakeEngine();
    const runtime = createUiRuntime(engine);
    render(
      <DaakUiApp
        mode="popover"
        engine={engine}
        runtime={runtime}
        alert={<Text testID="blocking-alert">Update Required</Text>}
        alertRouteToken="peer-1"
      />,
    );
    expect(screen.getByTestId('popover-update-banner')).toBeTruthy();
    expect(screen.queryByTestId('blocking-alert')).toBeNull();
    expect(screen.getByLabelText('open-dashboard')).toBeTruthy();
  });

  // The negative half. Without it, a shell that renders the alert over the
  // panel, or renders the alert unconditionally, passes the case above and
  // still drops the panel on every ordinary launch. An alert with NO token is
  // the resting state of every healthy launch, so the panel must be there.
  it('renders the normal popover panel when no alert is routed', () => {
    const engine = fakeEngine();
    const runtime = createUiRuntime(engine);
    render(
      <DaakUiApp
        mode="popover"
        engine={engine}
        runtime={runtime}
        alert={<Text testID="blocking-alert">Update Required</Text>}
      />,
    );
    expect(screen.queryByTestId('blocking-alert')).toBeNull();
    expect(screen.getByLabelText('open-dashboard')).toBeTruthy();
  });
});

// A child inside the tree that DaakUiApp renders. It calls the hook once.
function ToastProbe() {
  const toast = useToast();
  React.useEffect(() => {
    toast.show('Copied');
  }, [toast]);
  return <Text testID="toast-probe">probe</Text>;
}

describe('DaakUiApp mounts the shared toast', () => {
  // The alert slot is the way to seed a child in either mode. P6 draws no alert
  // node for an update token in the popover, so the popover case uses the
  // cannot-reach token, which does draw one.
  it.each([
    ['dashboard', 'probe-1'],
    ['popover', CANT_REACH_TOKEN],
  ] as const)('shows a toast that a child raises in %s mode', async (mode, token) => {
    const engine = fakeEngine();
    render(
      <DaakUiApp
        mode={mode}
        engine={engine}
        runtime={createUiRuntime(engine)}
        alert={<ToastProbe />}
        alertRouteToken={token}
      />,
    );
    expect(await screen.findByTestId('toast-probe')).toBeTruthy();
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(screen.getByTestId('toast')).toBeTruthy();
  });
});

