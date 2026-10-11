import React from 'react';
import { BackHandler, Modal, Text, View } from 'react-native';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { Sheet, SheetProvider } from './Sheet';

// react-native-macos 0.83 compiles the whole Fabric Modal host view out
// (`#if !TARGET_OS_OSX`). A Modal on the Mac crashed the app when a pairing was
// removed. The sheet must not use it on any platform.
it('does not use the react-native Modal', () => {
  render(<Sheet open title="T" onClose={() => {}} />);
  expect(screen.UNSAFE_queryByType(Modal)).toBeNull();
  render(
    <SheetProvider>
      <Sheet open title="T2" onClose={() => {}} />
    </SheetProvider>,
  );
  expect(screen.UNSAFE_queryByType(Modal)).toBeNull();
});

describe('with a SheetProvider', () => {
  const page = (open: boolean, body = 'body') => (
    <SheetProvider>
      <View testID="page">
        <Sheet open={open} title="Host sheet" onClose={() => {}}>
          <Text>{body}</Text>
        </Sheet>
      </View>
    </SheetProvider>
  );

  it('draws the sheet in the host, outside the page that asked for it', () => {
    render(page(true));
    expect(screen.getByText('Host sheet')).toBeTruthy();
    // A sheet inside a scrolling page would cover only the scrolled content.
    expect(within(screen.getByTestId('page')).queryByText('Host sheet')).toBeNull();
  });

  it('removes the sheet from the host when it closes', () => {
    const view = render(page(true));
    expect(screen.getByText('Host sheet')).toBeTruthy();
    view.rerender(page(false));
    expect(screen.queryByText('Host sheet')).toBeNull();
  });

  it('shows a changed body while the sheet stays open', () => {
    const view = render(page(true, 'first'));
    expect(screen.getByText('first')).toBeTruthy();
    view.rerender(page(true, 'second'));
    expect(screen.getByText('second')).toBeTruthy();
    expect(screen.queryByText('first')).toBeNull();
  });

  it('removes the sheet when the page that asked for it goes away', () => {
    // The provider stays mounted; only the page unmounts (a route change).
    const tree = (showPage: boolean) => (
      <SheetProvider>
        {showPage ? <Sheet open title="Host sheet" onClose={() => {}} /> : null}
      </SheetProvider>
    );
    const view = render(tree(true));
    expect(screen.getByText('Host sheet')).toBeTruthy();
    view.rerender(tree(false));
    expect(screen.queryByText('Host sheet')).toBeNull();
  });
});

it('closes on the Android back button while open, and not while closed', () => {
  const handlers: Array<() => boolean> = [];
  const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, h) => {
    handlers.push(h as () => boolean);
    return { remove: () => { handlers.splice(handlers.indexOf(h as () => boolean), 1); } };
  });
  const onClose = jest.fn();
  const view = render(<Sheet open title="T" onClose={onClose} />);
  expect(handlers).toHaveLength(1);
  expect(handlers[0]()).toBe(true);
  expect(onClose).toHaveBeenCalledTimes(1);
  view.rerender(<Sheet open={false} title="T" onClose={onClose} />);
  expect(handlers).toHaveLength(0);
  spy.mockRestore();
});

it('renders the title, the body, and the actions when open', () => {
  render(<Sheet open title="Unpair Pixel?" onClose={() => {}} actions={<Text>act</Text>}><Text>body</Text></Sheet>);
  expect(screen.getByText('Unpair Pixel?')).toBeTruthy();
  expect(screen.getByText('body')).toBeTruthy();
  expect(screen.getByText('act')).toBeTruthy();
});

it('renders nothing when closed', () => {
  render(<Sheet open={false} title="Hidden" onClose={() => {}} />);
  expect(screen.queryByText('Hidden')).toBeNull();
});

it('closes from the close button and from the scrim', () => {
  const onClose = jest.fn();
  render(<Sheet open title="T" onClose={onClose} />);
  fireEvent.press(screen.getByLabelText('Close'));
  // The scrim is a sibling of the sheet, which sets `accessibilityViewIsModal`,
  // so React Native Testing Library hides it from an accessibility query by
  // default. The press still has to work.
  fireEvent.press(screen.getByTestId('sheet-scrim', { includeHiddenElements: true }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

