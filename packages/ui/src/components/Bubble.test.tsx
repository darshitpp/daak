import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';
import { itemKey } from '../screens/thread-merge';
import { threadItem } from '../testing/threadFixtures';
import { Bubble, FAILED_FILL_OPACITY, TEXT_PREVIEW_CHARS, bubbleKind, whenLabel } from './Bubble';

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
  // The outbox drain moves an unreachable send from queued to paused within
  // milliseconds. A paused bubble drew as a normal sent bubble, with no state
  // and no error, so a send that never left the phone looked delivered.
  it('calls a paused outbound row waiting, and says it is trying again', () => {
    expect(bubbleKind(file({ direction: 'out', transferState: 'paused', state: 'pending' }))).toBe('waiting');
    render(<Bubble item={file({ direction: 'out', transferState: 'paused', state: 'pending' })} onStop={jest.fn()} />);
    expect(screen.getByText('Trying again')).toBeTruthy();
    expect(screen.queryByText('Waiting to send')).toBeNull();
  });

  it('keeps the words Waiting to send for a queued outbound row', () => {
    render(<Bubble item={file({ direction: 'out', transferState: 'queued', state: 'pending' })} />);
    expect(screen.getByText('Waiting to send')).toBeTruthy();
    expect(screen.queryByText('Trying again')).toBeNull();
  });

  it('does not call an inbound paused row waiting', () => {
    expect(bubbleKind(file({ direction: 'in', transferState: 'paused' }))).toBe('file');
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
  // The engine cut this text to fit the page. Copy asks the host for the whole
  // text (onCopyWhole), because the page text is only the start of it.
  it('says a text cut by the engine is not whole and copies the whole text through onCopyWhole', () => {
    const onCopy = jest.fn();
    const onCopyWhole = jest.fn();
    const item = threadItem({ text: 'start of a long note', textTruncated: true });
    render(<Bubble item={item} onCopy={onCopy} onCopyWhole={onCopyWhole} />);
    expect(screen.getByText('start of a long note')).toBeTruthy();
    expect(screen.getByText('This text is too long to show in full. Copy text copies all of it.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Copy text'));
    expect(onCopyWhole).toHaveBeenCalledWith(item);
    expect(onCopy).not.toHaveBeenCalled();
  });

  it('copies the page text for a cut text when the host gives no onCopyWhole', () => {
    const onCopy = jest.fn();
    render(<Bubble item={threadItem({ text: 'start', textTruncated: true })} onCopy={onCopy} />);
    fireEvent.press(screen.getByLabelText('Copy text'));
    expect(onCopy).toHaveBeenCalledWith('start');
  });

  it('keeps Copy and shows no cut line for a text that the engine did not cut', () => {
    render(<Bubble item={threadItem({ text: 'short', textTruncated: false })} onCopy={jest.fn()} />);
    expect(screen.queryByText(/too long to show in full/)).toBeNull();
    expect(screen.getByLabelText('Copy text')).toBeTruthy();
  });

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


describe('bubble fill', () => {
  const { colors } = require('../theme');
  const running = (p = {}) => file({ direction: 'out', state: 'receiving', transferState: 'running', ...p });
  const fillStyle = () => StyleSheet.flatten(screen.getByTestId(`bubble-fill-${itemKey(running())}`).props.style);

  type Rgba = [number, number, number, number];
  const parse = (c: string): Rgba => {
    if (c.startsWith('#')) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1];
    const m = c.match(/[\d.]+/g)!.map(Number);
    return [m[0], m[1], m[2], m[3] ?? 1];
  };
  const over = (top: Rgba, base: Rgba): Rgba => [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3])).concat(1) as Rgba;
  const lum = (c: Rgba) => {
    const [r, g, b] = [0, 1, 2].map((i) => { const v = c[i] / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: Rgba, b: Rgba) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

  it('fill colors keep text at 4.5 to 1', () => {
    const paper = parse(colors.paper);
    const incoming = paper;
    const outgoing = over(parse(colors.hover), paper);
    const fill = parse(colors.fill);
    const failed = over(parse(colors.warnTint), paper);
    const tint = parse(colors.errTint);
    const failedFill = over([tint[0], tint[1], tint[2], tint[3] * FAILED_FILL_OPACITY], failed);
    const cases = {
      'fg on outgoing': ratio(parse(colors.fg), outgoing),
      'fg on outgoing fill': ratio(parse(colors.fg), over(fill, outgoing)),
      'fg on incoming fill': ratio(parse(colors.fg), over(fill, incoming)),
      'muted on outgoing fill': ratio(parse(colors.muted), over(fill, outgoing)),
      'muted on incoming fill': ratio(parse(colors.muted), over(fill, incoming)),
      'warnInk on failed fill': ratio(parse(colors.warnInk), failedFill),
    };
    for (const [name, x] of Object.entries(cases)) expect([name, x >= 4.5]).toEqual([name, true]);
  });

  it('progress 40 sets transform scaleX 0.4 on the fill', () => {
    render(<Bubble item={running()} progress={40} />);
    expect(fillStyle().transform).toEqual([{ scaleX: 0.4 }]);
    expect(fillStyle().transformOrigin).toBe('left');
  });
  it('accessibilityValue now is 40', () => {
    render(<Bubble item={running()} progress={40} />);
    expect(screen.getByTestId(`bubble-fill-${itemKey(running())}`).props.accessibilityValue).toEqual({ min: 0, max: 100, now: 40 });
  });
  it('clamps progress to 0 to 100 and draws no fill for NaN', () => {
    for (const [given, scale] of [[250, 1], [-5, 0]]) {
      const view = render(<Bubble item={running()} progress={given} />);
      expect(fillStyle().transform).toEqual([{ scaleX: scale }]);
      view.unmount();
    }
    render(<Bubble item={running()} progress={NaN} />);
    expect(screen.queryByTestId(`bubble-fill-${itemKey(running())}`)).toBeNull();
  });
  it('a text bubble ignores progress', () => {
    const t = threadItem({ state: 'receiving' });
    render(<Bubble item={t} progress={40} />);
    expect(screen.queryByTestId(`bubble-fill-${itemKey(t)}`)).toBeNull();
  });
  it('a waiting bubble draws no fill', () => {
    const w = running({ transferState: 'queued', state: 'pending' });
    render(<Bubble item={w} progress={40} />);
    expect(screen.queryByTestId(`bubble-fill-${itemKey(w)}`)).toBeNull();
  });
  it('a failed bubble keeps the fill and uses the error tint', () => {
    const f = running({ transferState: 'failed' });
    render(<Bubble item={f} progress={40} />);
    const s = StyleSheet.flatten(screen.getByTestId(`bubble-fill-${itemKey(f)}`).props.style);
    expect(s.backgroundColor).toBe(colors.errTint);
    expect(s.transform).toEqual([{ scaleX: 0.4 }]);
  });
  it('progress going down animates the scale back down', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    const timing = jest.spyOn(Animated, 'timing');
    const view = render(<Bubble item={running()} progress={60} />);
    await act(async () => {});
    view.rerender(<Bubble item={running()} progress={20} />);
    expect(timing.mock.calls.some(([, c]) => c.toValue === 0.2)).toBe(true);
    jest.restoreAllMocks();
  });
  it('a done bubble hides the Stop control', () => {
    const d = running({ state: 'done', transferState: 'done' });
    render(<Bubble item={d} progress={100} onStopRunning={jest.fn()} />);
    expect(screen.queryByTestId(`thread-stop-${d.transferId}`)).toBeNull();
  });
  it('a failed bubble hides the Stop control', () => {
    const f = running({ transferState: 'failed' });
    render(<Bubble item={f} progress={40} onStopRunning={jest.fn()} />);
    expect(screen.queryByTestId(`thread-stop-${f.transferId}`)).toBeNull();
  });
  it('a normal bubble fills with colors.fill', () => {
    render(<Bubble item={running()} progress={40} />);
    expect(fillStyle().backgroundColor).toBe(colors.fill);
  });
  it('a done bubble ends with fill opacity 0', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const d = running({ state: 'done', transferState: 'done' });
    render(<Bubble item={d} progress={100} />);
    await act(async () => {});
    expect(timing.mock.calls.some(([, cfg]) => cfg.toValue === 0 && cfg.useNativeDriver === true)).toBe(true);
    timing.mockRestore();
  });
  it('reduce motion sets the value without animation', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const timing = jest.spyOn(Animated, 'timing');
    const view = render(<Bubble item={running()} progress={40} />);
    await act(async () => {});
    view.rerender(<Bubble item={running()} progress={70} />);
    expect(timing).not.toHaveBeenCalled();
    expect(fillStyle().transform).toEqual([{ scaleX: 0.7 }]);
    timing.mockRestore();
    jest.restoreAllMocks();
  });
  it('without reduce motion a new progress animates the fill', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    const timing = jest.spyOn(Animated, 'timing');
    const view = render(<Bubble item={running()} progress={40} />);
    await act(async () => {});
    view.rerender(<Bubble item={running()} progress={70} />);
    expect(timing.mock.calls.some(([, c]) => c.toValue === 0.7 && c.useNativeDriver === true)).toBe(true);
    jest.restoreAllMocks();
  });
  it('the meta text shows', () => {
    render(<Bubble item={running()} progress={40} meta="1.2 MB of 4 MB" />);
    expect(screen.getByText('1.2 MB of 4 MB')).toBeTruthy();
  });
  it('a running bubble with no fill still shows Stop', () => {
    render(<Bubble item={running()} onStopRunning={jest.fn()} />);
    expect(screen.queryByTestId(`bubble-fill-${itemKey(running())}`)).toBeNull();
    expect(screen.getByTestId(`thread-stop-${running().transferId}`)).toBeTruthy();
  });
  it('onStopRunning shows Stop sending with the transfer test id', () => {
    const stop = jest.fn();
    render(<Bubble item={running()} progress={40} onStopRunning={stop} />);
    fireEvent.press(screen.getByTestId(`thread-stop-${running().transferId}`));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Stop sending')).toBeTruthy();
  });
});
