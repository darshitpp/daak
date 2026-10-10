import React from 'react';
import { Text } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { EngineProvider } from '../EngineContext';
import { fakeEngine } from '../testing/fakeEngine';
import { AppShell } from './AppShell';

// `paired: true`: R42g hides Send on an unpaired peer, so the fixtures the
// Send route is asserted against must be paired.
const peer = { deviceId: 'aa'.repeat(16), name: 'Pixel 9', addr: '192.168.1.9:40001', online: true, paired: true };
const second = { deviceId: 'cc'.repeat(16), name: 'ThinkPad', addr: '192.168.1.4:40001', online: true, paired: true };

// The background control has to be REACHABLE, not merely renderable: an app
// that injects it into SettingsScreen but forgets to thread it through AppShell
// shows a Settings screen that silently has no affordance on it. This drives
// the real tab bar, so the whole path is covered.
it('threads a background slot through to the Settings tab', () => {
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell background={<Text>allow-bg</Text>} />
    </EngineProvider>,
  );
  // TabBar exposes each tab as Pressable > Text, not as an accessibilityLabel,
  // so the press target is the text node itself.
  fireEvent.press(screen.getByText('Settings'));
  expect(screen.getByText('allow-bg')).toBeTruthy();
});

// The pair flow is APP-side (R100), so the shell test proves the slot is
// threaded with a stub; apps/mobile/src/__tests__/pairingFlow.test.tsx proves
// the real wrapper behind it. Same split as the background slot. Pairing is a
// ROUTE out of Devices now, not a sixth tab, so this drives the real button.
it('threads a pair slot through to Pairing from Devices', async () => {
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell pair={<Text>pair-ui</Text>} />
    </EngineProvider>,
  );
  fireEvent.press(screen.getByText('Devices'));
  fireEvent.press(await screen.findByLabelText('pair-a-device'));
  expect(screen.getByText('pair-ui')).toBeTruthy();
});

// Send is a destination in its own right, not a strip above whatever tab is
// open. This drives the real tab bar, so losing the 'Send' entry fails here.
it('opens on Send and routes a device card into that tab', async () => {
  const engine = fakeEngine();
  const listed = jest.spyOn(engine, 'devices').mockResolvedValue([peer]);
  const sent = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: 'bb'.repeat(16), queued: true });
  render(
    <EngineProvider engine={engine}>
      <AppShell />
    </EngineProvider>,
  );
  expect(screen.getAllByText('Send').length).toBeGreaterThan(0);

  // DeviceCard's Send is a ROUTE with the tapped peer as the target, not a
  // callback the host has to supply: the engine.send that follows proves it
  // landed on THAT peer and not on devices[0].
  fireEvent.press(screen.getByText('Devices'));
  fireEvent.press(await screen.findByTestId('open-' + peer.deviceId));
  fireEvent.changeText(await screen.findByPlaceholderText('Message'), 'hi');
  fireEvent.press(screen.getByLabelText('send'));
  await waitFor(() => expect(sent).toHaveBeenCalledWith({ peerDeviceId: peer.deviceId, text: 'hi', files: [] }));
  expect(listed).toHaveBeenCalled();
});

// I1: TransferProgressScreen had ZERO render sites, so every transfer.item row
// the engine really emits was invisible. The transfers slot now HAS a real
// default (TransfersScreen), so a shell passing nothing still shows every
// transfer instead of a blank tab.
it('threads a transfers slot through to the Transfers tab', () => {
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell transfers={<Text>transfers-ui</Text>} />
    </EngineProvider>,
  );
  fireEvent.press(screen.getByText('Transfers'));
  expect(screen.getByText('transfers-ui')).toBeTruthy();
});

it('shows the real transfers screen when the host supplies none', async () => {
  const engine = fakeEngine();
  jest.spyOn(engine, 'listTransfers').mockResolvedValue([]);
  render(
    <EngineProvider engine={engine}>
      <AppShell />
    </EngineProvider>,
  );
  fireEvent.press(screen.getByText('Transfers'));
  expect(await screen.findByText('No transfers yet')).toBeTruthy();
});

it('routes the desktop sidebar to Inbox', () => {
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell layout="desktop" />
    </EngineProvider>,
  );
  // Same five labels, different furniture, so the Inbox screen mounting after
  // the tap is what proves the sidebar is the thing being pressed.
  fireEvent.press(screen.getByText('Inbox'));
  expect(screen.getByText('Search what arrived')).toBeTruthy();
});

// A pair route with no way out: the tab bar has no pair entry, so on a desktop
// sidebar NOTHING is highlighted and every destination click leaves pairing.
it('routes out of the pair slot again', async () => {
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell pair={<Text>pair-ui</Text>} />
    </EngineProvider>,
  );
  fireEvent.press(screen.getByText('Devices'));
  fireEvent.press(await screen.findByLabelText('pair-a-device'));
  expect(screen.getByText('pair-ui')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('pair-back'));
  expect(screen.queryByText('pair-ui')).toBeNull();
  expect(screen.getByLabelText('pair-a-device')).toBeTruthy();
});

// A daak://send link that prefills the composer but leaves the user on Devices
// is not handled -- the tap that should be the next one is somewhere else.
it('routes a send link to Send with its peer and note', async () => {
  const engine = fakeEngine();
  jest.spyOn(engine, 'devices').mockResolvedValue([peer]);
  const sent = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: 'bb'.repeat(16), queued: true });
  render(
    <EngineProvider engine={engine}>
      <AppShell initialPeerDeviceId={peer.deviceId} initialText="from a link" />
    </EngineProvider>,
  );
  // Still the default tab (send) but seeded: the proof is what the engine got.
  expect(await screen.findByDisplayValue('from a link')).toBeTruthy();
  // React 19: the target comes from the devices() promise, and SendScreen
  // returns early while target is null. Await the ENABLED label, not just the
  // seeded text, or the press lands on a disabled button.
  await screen.findByText('Send to Pixel 9');
  fireEvent.press(screen.getByLabelText('send'));
  await waitFor(() =>
    expect(sent).toHaveBeenCalledWith({ peerDeviceId: peer.deviceId, text: 'from a link', files: [] }),
  );
});

// The failure the link fixes: a peer chosen in-session used to keep winning,
// so a link naming A sent to B. The link is the more recent instruction.
it('lets a later link peer override a peer tapped earlier', async () => {
  const engine = fakeEngine();
  jest.spyOn(engine, 'devices').mockResolvedValue([peer, second]);
  const sent = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: 'bb'.repeat(16), queued: true });
  const { rerender } = render(
    <EngineProvider engine={engine}>
      <AppShell />
    </EngineProvider>,
  );
  fireEvent.press(await screen.findByLabelText('select-' + second.deviceId));
  rerender(
    <EngineProvider engine={engine}>
      <AppShell initialPeerDeviceId={peer.deviceId} />
    </EngineProvider>,
  );
  fireEvent.changeText(await screen.findByPlaceholderText('Message'), 'hi');
  fireEvent.press(screen.getByLabelText('send'));
  await waitFor(() => expect(sent).toHaveBeenCalledWith({ peerDeviceId: peer.deviceId, text: 'hi', files: [] }));
});

it('routes a pair link into the pair slot', () => {
  render(
    <EngineProvider engine={fakeEngine()}>
      <AppShell pair={<Text>pair-ui</Text>} pairBundle='{"cbor":"aabb"}' />
    </EngineProvider>,
  );
  // Opened on Devices so a same-tab pairing could not be mistaken for a route.
  expect(screen.getByText('pair-ui')).toBeTruthy();
});

// TransferProgressScreen had no render site at all, so every transfer.item row
// the engine emits was invisible and a stopped transfer could not be inspected.
// A Details button that lands on the per-item screen is the whole fix.
it('routes a transfer row into its detail, and back out again', async () => {
  const engine = fakeEngine();
  const id = 'bb'.repeat(16);
  jest.spyOn(engine, 'listTransfers').mockResolvedValue([
    { transferId: id, peerDeviceId: peer.deviceId, direction: 'in', kind: 'media',
      state: 'receiving', bytesDone: 1, bytesTotal: 2, itemCount: 1, updatedAt: 5 },
  ]);
  jest.spyOn(engine, 'devices').mockResolvedValue([peer]);
  render(
    <EngineProvider engine={engine}>
      <AppShell />
    </EngineProvider>,
  );
  fireEvent.press(screen.getByText('Transfers'));
  await screen.findByText('1 item(s) from Pixel 9');
  expect(screen.queryByLabelText('detail-back')).toBeNull();
  fireEvent.press(screen.getByLabelText('open-1 item(s) from Pixel 9'));
  expect(screen.getByLabelText('detail-back')).toBeTruthy();
  // The list is gone; the detail route owns the view now.
  expect(screen.queryByText('1 item(s) from Pixel 9')).toBeNull();
  fireEvent.press(screen.getByLabelText('detail-back'));
  // Back unmounts the detail and remounts the list, which re-reads the engine.
  await waitFor(() => expect(screen.getByText('1 item(s) from Pixel 9')).toBeTruthy());
});

// An OS share import is a Send instruction, exactly like a daak://send link:
// it has to land ON Send, not seed a composer hidden behind another tab -- the
// bytes are already off the native inbox, so an invisible draft is a lost one.
it('routes an inbound share into the Send composer', async () => {
  const engine = fakeEngine();
  jest.spyOn(engine, 'devices').mockResolvedValue([peer]);
  const sent = jest.spyOn(engine, 'send').mockResolvedValue({ transferId: 'bb'.repeat(16), queued: true });
  render(
    <EngineProvider engine={engine}>
      <AppShell initialText='shared note' initialFiles={['/Documents/photo.png']} />
    </EngineProvider>,
  );
  expect(await screen.findByDisplayValue('shared note')).toBeTruthy();
  expect(screen.getByText('photo.png')).toBeTruthy();
  // Same as above: the peer list resolves asynchronously and the button stays
  // disabled until it does.
  await screen.findByText('Send to Pixel 9');
  fireEvent.press(screen.getByLabelText('send'));
  await waitFor(() =>
    expect(sent).toHaveBeenCalledWith({
      peerDeviceId: peer.deviceId,
      text: 'shared note',
      files: ['/Documents/photo.png'],
    }),
  );
});

// A tapped [Open] notification has to land ON the Inbox. The notification is
// posted with the InboxRow as its payload and the Inbox already lists that row,
// so the shell needs only the route -- and it has to be a CHANGING token, or
// the same row tapped twice lands once.
it('routes a tapped notification to the Inbox, and again on a repeat tap', async () => {
  const engine = fakeEngine();
  const { rerender } = render(
    <EngineProvider engine={engine}>
      <AppShell />
    </EngineProvider>,
  );
  fireEvent.press(screen.getByText('Transfers'));
  expect(await screen.findByText('No transfers yet')).toBeTruthy();

  rerender(
    <EngineProvider engine={engine}>
      <AppShell inboxRouteToken="1" />
    </EngineProvider>,
  );
  expect(screen.getByText('Search what arrived')).toBeTruthy();

  // Leave, then tap the SAME row again: a token the shell ignores after the
  // first delivery would strand the user wherever they navigated to.
  fireEvent.press(screen.getByText('Transfers'));
  expect(await screen.findByText('No transfers yet')).toBeTruthy();
  rerender(
    <EngineProvider engine={engine}>
      <AppShell inboxRouteToken="2" />
    </EngineProvider>,
  );
  expect(screen.getByText('Search what arrived')).toBeTruthy();
});
