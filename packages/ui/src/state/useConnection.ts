import { useEffect, useState } from 'react';
import type { DaakEngine } from '@daak/core';
import { presenceOf } from '../components/ds';

export interface Connection {
  status: 'working' | 'not-working' | 'unknown';
  wifi: 'connected' | 'not-connected' | 'unknown';
}

const UNKNOWN: Connection = { status: 'unknown', wifi: 'unknown' };

/**
 * The Settings "Connection" facts. They come from the same call that the
 * can't-reach check makes (`devices()`). This hook is separate from
 * `useBlockers` on purpose: that hook never subscribes to the engine (R43a), so
 * its fact would go stale while Settings is open.
 *
 * "Connected" means a paired device is on this network (online or away). It
 * does not name the network (ruling D6).
 */
export function useConnection(engine: DaakEngine): Connection {
  const [c, setC] = useState<Connection>(UNKNOWN);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void engine.devices().then(
        (list) => {
          if (alive) setC({ status: 'working', wifi: list.some((d) => d.paired === true && presenceOf(d).rank <= 1) ? 'connected' : 'not-connected' });
        },
        () => {
          if (alive) setC({ status: 'not-working', wifi: 'unknown' });
        },
      );
    read();
    const off = engine.on((e) => {
      // pairing.done and pairing.revoked change `paired` with no device event.
      if (
        e.type === 'device.state' ||
        e.type === 'device.discovered' ||
        e.type === 'device.presence' ||
        e.type === 'pairing.done' ||
        e.type === 'pairing.revoked'
      ) {
        read();
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [engine]);
  return c;
}

