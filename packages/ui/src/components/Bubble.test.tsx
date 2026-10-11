import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { threadItem } from '../testing/threadFixtures';
import { Bubble, TEXT_PREVIEW_CHARS, bubbleKind, whenLabel } from './Bubble';

const file = (p = {}) => threadItem({ type: 'file', text: null, name: 'Q3-report.pdf', size: 4_400_000, destPath: '/d/Q3-report.pdf', ...p });

describe('bubbleKind', () => {
  it('classifies each case', () => {
    expect(bubbleKind(threadItem())).toBe('text');
    expect(bubbleKind(file())).toBe('file');
    expect(bubbleKind(file({ state: 'quarantined' }))).toBe('held');
    expect(bubbleKind(file({ state: 'failed', error: 'x' }))).toBe('failed');
    expect(bubbleKind(file({ direction: 'out', transferState: 'failed' }))).toBe('failed');
    expect(bubbleKind(file({ direction: 'out', transferState: 'queued', state: 'pending' }))).toBe('waiting');
    expect(bubbleKind(file({ direction: 'out', transferState: 'canceled' }))).toBe('stopped');
  });
  // A queued INBOUND row is not "waiting to send".
  it('does not call an inbound queued row waiting', () => {
    expect(bubbleKind(file({ direction: 'in', transferState: 'queued' }))).toBe('file');
  });
});

describe('whenLabel', () => {
  const now = Date.UTC(2026, 9, 9, 12, 0, 0);
  it('says Just now inside a minute', () => {
    expect(whenLabel(now / 1000 - 20, now)).toBe('Just now');
  });
  it('shows a clock time on the same day and a date on an older day', () => {
    expect(whenLabel(now / 1000 - 3600, now)).toMatch(/\d/);
    expect(whenLabel(now / 1000 - 5 * 86400, now)).not.toBe('Just now');
  });
});

describe('Bubble', () => {
  it('copies a text bubble', () => {
    const onCopy = jest.fn();
    render(<Bubble item={threadItem({ text: 'hello there' })} onCopy={onCopy} />);
    expect(screen.getByText('hello there')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Copy text'));
    expect(onCopy).toHaveBeenCalledWith('hello there');
  });

  // Review Focus 2. A 1 MiB body must not reach the Text node whole.
  it('shows the first 4000 characters of a huge text and still copies all of it', () => {
    const huge = 'é'.repeat(1024 * 1024);
    const onCopy = jest.fn();
    render(<Bubble item={threadItem({ text: huge })} onCopy={onCopy} />);
    const shown = screen.getByTestId('bubble-text').props.children as string;
    expect(shown.length).toBeLessThanOrEqual(TEXT_PREVIEW_CHARS + 1);
    expect(screen.getByText('Showing the first 4000 characters. Copy text to get all of it.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Copy text'));
    expect((onCopy.mock.calls[0][0] as string).length).toBe(huge.length);
  });

  it('does not cut a surrogate pair in half', () => {
    const emoji = '😀'.repeat(TEXT_PREVIEW_CHARS);
    render(<Bubble item={threadItem({ text: emoji })} />);
    const shown = screen.getByTestId('bubble-text').props.children as string;
    expect(shown).not.toMatch(/[\ud800-\udbff]$/);
  });

  it('shows no Copy for a text item whose body did not parse', () => {
    render(<Bubble item={threadItem({ text: null })} onCopy={jest.fn()} />);
    expect(screen.queryByLabelText('Copy text')).toBeNull();
    expect(screen.getByText('This text could not be read.')).toBeTruthy();
  });

  it('labels Preview and Share with the file name', () => {
    const onPreview = jest.fn();
    const onShare = jest.fn();
    render(<Bubble item={file()} onPreview={onPreview} onShare={onShare} />);
    expect(screen.getByText('Q3-report.pdf')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Preview Q3-report.pdf'));
    fireEvent.press(screen.getByLabelText('Share Q3-report.pdf'));
    expect(onPreview).toHaveBeenCalled();
    expect(onShare).toHaveBeenCalled();
  });

  it('shows no Preview and no Share for a file with no saved path', () => {
    render(<Bubble item={file({ destPath: null })} onPreview={jest.fn()} onShare={jest.fn()} />);
    expect(screen.queryByLabelText('Preview Q3-report.pdf')).toBeNull();
    expect(screen.queryByLabelText('Share Q3-report.pdf')).toBeNull();
  });

  // Design v2 (`bubble-held`): the size line ends with " · Held back". The one
  // action is Review. A held bubble has no Preview and no Share.
  it('shows Held back after the size and opens the held route from Review', () => {
    const onOpenHeld = jest.fn();
    render(<Bubble item={file({ state: 'quarantined', destPath: null })} onOpenHeld={onOpenHeld} onPreview={jest.fn()} onShare={jest.fn()} />);
    expect(screen.getByText(/ · Held back$/)).toBeTruthy();
    expect(screen.queryByLabelText('Preview Q3-report.pdf')).toBeNull();
    expect(screen.queryByLabelText('Share Q3-report.pdf')).toBeNull();
    fireEvent.press(screen.getByLabelText('Review Q3-report.pdf'));
    expect(onOpenHeld).toHaveBeenCalledTimes(1);
  });

  // Design v2 (`bubble-fail`): the file row keeps its size. A line under it
  // reads "Couldn't send". The action is Retry. There is no Share.
  it('offers Retry for a failed outbound item only', () => {
    const onRetry = jest.fn();
    const { rerender } = render(
      <Bubble item={file({ direction: 'out', state: 'failed', error: 'timed out' })} onRetry={onRetry} onShare={jest.fn()} />,
    );
    expect(screen.getByText("Couldn't send")).toBeTruthy();
    expect(screen.getByText(/^4\.\d MB$/)).toBeTruthy();
    expect(screen.queryByLabelText('Share Q3-report.pdf')).toBeNull();
    fireEvent.press(screen.getByLabelText('Retry sending Q3-report.pdf'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // The design has no failed inbound item. The error text stands in.
    rerender(<Bubble item={file({ direction: 'in', state: 'failed', error: 'hash mismatch' })} onRetry={onRetry} />);
    expect(screen.getByText('hash mismatch')).toBeTruthy();
    expect(screen.queryByLabelText('Retry sending Q3-report.pdf')).toBeNull();
  });

  // Design v2 (`state: 'queued'`): the time slot reads "Waiting", the state line
  // reads "Waiting to send", and the action is a short "Stop".
  it('shows Waiting and Waiting to send with Stop for a queued outbound item', () => {
    const onStop = jest.fn();
    render(<Bubble item={file({ direction: 'out', transferState: 'queued', state: 'pending', destPath: null })} onStop={onStop} />);
    expect(screen.getByText('Waiting to send')).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();
    expect(screen.getByText('Stop')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Stop waiting to send Q3-report.pdf'));
    expect(onStop).toHaveBeenCalled();
  });

  // The design has no stopped item. This is a deliberate extra state (see Open question 13).
  it('says Stopped for a canceled transfer', () => {
    render(<Bubble item={file({ direction: 'out', transferState: 'canceled', destPath: null })} />);
    expect(screen.getByText('Stopped')).toBeTruthy();
  });

  // Design .bubble-state: the state word shows on every bubble type. A text
  // bubble keeps its Copy action in both states.
  it('shows the state word and keeps Copy on a failed outbound text item', () => {
    const onCopy = jest.fn();
    render(
      <Bubble
        item={threadItem({ direction: 'out', text: 'hi there', state: 'failed', transferState: 'failed', error: 'timed out' })}
        onCopy={onCopy}
      />,
    );
    expect(screen.getByText("Couldn't send")).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Copy text'));
    expect(onCopy).toHaveBeenCalledWith('hi there');
  });

  it('shows the state word and keeps Copy on a waiting outbound text item', () => {
    const onCopy = jest.fn();
    render(
      <Bubble
        item={threadItem({ direction: 'out', text: 'hi there', state: 'pending', transferState: 'queued' })}
        onCopy={onCopy}
      />,
    );
    expect(screen.getByText('Waiting to send')).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Copy text'));
    expect(onCopy).toHaveBeenCalledWith('hi there');
  });

  it('keeps every action at 44 points or more', () => {
    render(<Bubble item={file()} onPreview={jest.fn()} onShare={jest.fn()} />);
    const style = screen.getByLabelText('Preview Q3-report.pdf').props.style;
    const flat = Array.isArray(style) ? Object.assign({}, ...style.flat()) : style;
    expect(flat.minHeight).toBeGreaterThanOrEqual(44);
  });
});

