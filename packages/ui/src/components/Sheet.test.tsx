import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Sheet } from './Sheet';

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

