import { act, renderHook } from '@testing-library/react-native';
import { formatEta, formatSpeed, shortSpeedText, useTransferSpeed } from './speed';

const MIB = 1024 * 1024;
const TOTAL = 100000 * MIB;

type Props = { done: number; active?: boolean };

const setup = (initial = 0) => {
  let renders = 0;
  const hook = renderHook(
    ({ done, active = true }: Props) => {
      renders += 1;
      return useTransferSpeed('t1', done, TOTAL, active);
    },
    { initialProps: { done: initial } as Props },
  );
  return { hook, renders: () => renders };
};

// Advance the clock by `ms`, then give the hook a new byte count.
const step = (hook: ReturnType<typeof setup>['hook'], ms: number, done: number) => {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
  hook.rerender({ done });
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('useTransferSpeed', () => {
  it('steady_stream_gives_right_rate', () => {
    const { hook } = setup();
    for (let i = 1; i <= 30; i += 1) step(hook, 100, i * MIB);
    expect(hook.result.current.bytesPerSec / MIB).toBeCloseTo(10, 0);
    expect(hook.result.current.text).toContain('10.0 MiB/s');
    expect(hook.result.current.etaSeconds).not.toBeNull();
  });

  it('works_at_700ms_spacing', () => {
    const { hook } = setup();
    for (let i = 1; i <= 8; i += 1) step(hook, 700, i * 7 * MIB);
    expect(hook.result.current.bytesPerSec / MIB).toBeCloseTo(10, 0);
    expect(hook.result.current.text).toContain('MiB/s');
  });

  it('resume_seed_gives_no_inflated_rate', () => {
    const { hook } = setup(500 * MIB);
    expect(hook.result.current.bytesPerSec).toBe(0);
    expect(hook.result.current.text).toBeNull();
    for (let i = 1; i <= 20; i += 1) step(hook, 100, 500 * MIB + i * MIB);
    expect(hook.result.current.bytesPerSec / MIB).toBeLessThanOrEqual(10.01);
    expect(hook.result.current.bytesPerSec / MIB).toBeGreaterThan(9);
  });

  it('stall_hides_speed', () => {
    const { hook } = setup();
    for (let i = 1; i <= 20; i += 1) step(hook, 100, i * MIB);
    expect(hook.result.current.text).not.toBeNull();
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(hook.result.current.bytesPerSec).toBe(0);
    expect(hook.result.current.text).toBeNull();
    // A new sample starts the 1 s warm-up again.
    step(hook, 100, 21 * MIB);
    expect(hook.result.current.text).toBeNull();
    for (let i = 1; i <= 5; i += 1) step(hook, 100, (21 + i) * MIB);
    expect(hook.result.current.text).toBeNull();
    for (let i = 6; i <= 15; i += 1) step(hook, 100, (21 + i) * MIB);
    expect(hook.result.current.text).not.toBeNull();
  });

  it('ignores_close_samples', () => {
    const { hook } = setup();
    for (let i = 1; i <= 20; i += 1) step(hook, 100, i * MIB);
    const before = hook.result.current.bytesPerSec;
    step(hook, 50, 21 * MIB + 50 * MIB);
    expect(hook.result.current.bytesPerSec).toBe(before);
  });

  it('sets_state_only_on_text_change', () => {
    const { hook, renders } = setup();
    for (let i = 1; i <= 20; i += 1) step(hook, 100, i * MIB);
    const text = hook.result.current.text;
    expect(text).not.toBeNull();
    // Timer ticks with an unchanged text must not render again.
    const before = renders();
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(hook.result.current.text).toBe(text);
    expect(renders()).toBe(before);
  });

  it('no_zero_speed_after_stall_between_ticks', () => {
    // The panel renders every 700 ms. A render can fall after the stall
    // threshold and before the next 1 s tick. The three fields must agree.
    for (let offset = 0; offset < 1000; offset += 100) {
      const { hook } = setup();
      let done = 0;
      for (let i = 1; i <= 8; i += 1) {
        done += 7 * MIB;
        step(hook, 700, done);
      }
      expect(hook.result.current.text).not.toBeNull();
      act(() => {
        jest.advanceTimersByTime(offset);
      });
      for (let i = 0; i < 14; i += 1) {
        step(hook, 700, done);
        const r = hook.result.current;
        if (r.text !== null) {
          expect(r.bytesPerSec).toBeGreaterThan(0);
        } else {
          expect(r.bytesPerSec).toBe(0);
          expect(r.etaSeconds).toBeNull();
        }
      }
      expect(hook.result.current.text).toBeNull();
      hook.unmount();
    }
  });

  it('ema_step_change_moves_63_percent_in_tau', () => {
    const { hook } = setup();
    let done = 0;
    for (let i = 0; i < 30; i += 1) {
      done += MIB;
      step(hook, 100, done);
    }
    expect(hook.result.current.bytesPerSec / MIB).toBeCloseTo(10, 0);
    // The rate steps from 10 MiB/s to 20 MiB/s. Tau is 1.5 s.
    for (let i = 0; i < 15; i += 1) {
      done += 2 * MIB;
      step(hook, 100, done);
    }
    // 10 + 0.632 * 10 = 16.3 MiB/s
    expect(Math.abs(hook.result.current.bytesPerSec / MIB - 16.32)).toBeLessThan(1);
  });

  it('unmount_and_inactive_clear_the_interval', () => {
    const { hook } = setup();
    step(hook, 100, MIB);
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    hook.rerender({ done: MIB, active: false });
    expect(jest.getTimerCount()).toBe(0);
    hook.rerender({ done: MIB, active: true });
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    hook.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('shortSpeedText', () => {
  it('short_form_has_no_about_or_left', () => {
    expect(shortSpeedText(12.3 * MIB, 120)).toBe('12.3 MiB/s · 2 min');
    expect(shortSpeedText(12.3 * MIB, 45)).toBe('12.3 MiB/s · 45 s');
    expect(shortSpeedText(12.3 * MIB, null)).toBe('12.3 MiB/s');
    expect(shortSpeedText(12.3 * MIB, 100 * 3600)).toBe('12.3 MiB/s');
  });
});

describe('formatSpeed', () => {
  it('format_units', () => {
    expect(formatSpeed(512 * 1024)).toBe('512.0 KiB/s');
    expect(formatSpeed(12.3 * MIB)).toBe('12.3 MiB/s');
    expect(formatSpeed(2.5 * 1024 * MIB)).toBe('2.5 GiB/s');
    expect(formatSpeed(0)).toBe('0.0 KiB/s');
    expect(formatSpeed(10 * MIB)).not.toContain('MB/s ');
  });
});

describe('formatEta', () => {
  it('format_eta', () => {
    expect(formatEta(45)).toBe('45 s left');
    expect(formatEta(43)).toBe('45 s left');
    expect(formatEta(20)).toBe('20 s left');
    expect(formatEta(56)).toBe('55 s left');
    expect(formatEta(59)).toBe('about 1 min left');
    expect(formatEta(60)).toBe('about 1 min left');
    expect(formatEta(150)).toBe('about 3 min left');
    expect(formatEta(7200)).toBe('about 2 h left');
    expect(formatEta(100 * 3600)).toBeNull();
  });
});
