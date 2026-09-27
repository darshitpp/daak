import { createEngine, syncShortcutTargets } from '@daak/platform';
import type { DaakEngine } from '@daak/core';
import { startEngine } from '../bootstrap';

jest.mock('@daak/platform', () => {
  const { fakeEngine } = jest.requireActual('@daak/ui');
  // bootstrap builds `engine` ONCE at import time via createEngine(), so this
  // test needs the handle on that one instance, not a fresh fakeEngine() per
  // call. The singleton lives on globalThis because jest hoists this factory
  // above the module body, so a module-level const here would be in TDZ.
  const g = globalThis as unknown as { __daakSingleton: DaakEngine | null };
  return {
    createEngine: () => {
      g.__daakSingleton ??= fakeEngine();
      return g.__daakSingleton;
    },
    consumePendingShare: jest.fn(),
    consumeIntentSends: jest.fn(async () => []),
    syncShortcutTargets: jest.fn(async () => {}),
  };
});

let live = 0;
const teardowns: jest.Mock[] = [];

beforeAll(() => {
  // createEngine() returns the same instance bootstrap captured.
  const engine = createEngine();
  const realOn = engine.on.bind(engine);
  jest.spyOn(engine, 'on').mockImplementation((cb) => {
    live += 1;
    const off = realOn(cb);
    const teardown = jest.fn(() => {
      live -= 1;
      off();
    });
    teardowns.push(teardown);
    return teardown;
  });
});

describe('startEngine pairing.done subscription', () => {
  // A comment claiming "startEngine is called once" is not an invariant. If it
  // is ever called twice (a remount, a hot reload, a future owner), the second
  // call must drop the first subscription, or every pairing.done after that
  // fires its publish twice.
  it('does not leave two live subscriptions after being called twice', async () => {
    await startEngine();
    expect(live).toBe(1);

    await startEngine();
    expect(teardowns[0]).toHaveBeenCalledTimes(1);
    expect(live).toBe(1);

    await startEngine();
    expect(teardowns[1]).toHaveBeenCalledTimes(1);
    expect(live).toBe(1);
  });

  it('still publishes the peer list on every start (the point of the call)', async () => {
    const sync = jest.mocked(syncShortcutTargets);
    sync.mockClear();
    await startEngine();
    expect(sync).toHaveBeenCalled();
  });
});
