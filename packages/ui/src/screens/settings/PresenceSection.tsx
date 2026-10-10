import React, { useState } from 'react';
import { Note, Section, type DeviceNoun } from '../../components/ds';
import { SwitchRow } from '../../components/Onboarding';
import { useToast } from '../../components/Toast';
import { useEngine } from '../../EngineContext';
import { setSelfPresenceLocal, useSelfPresence } from '../../state/selfPresence';

export function PresenceSection({ deviceNoun }: { deviceNoun?: DeviceNoun }) {
  const engine = useEngine();
  const toast = useToast();
  const presence = useSelfPresence();
  const [error, setError] = useState('');
  const on = presence === 'online';

  const toggle = () => {
    const next = on ? 'away' : 'online';
    setError('');
    setSelfPresenceLocal(next);
    // A refused change restores the old value, so the screen never claims a
    // state that peers do not see.
    engine.setPresence(next).then(
      // The design toasts `data-on` and `data-off` of `#set-presence`.
      () => toast.show(next === 'online' ? 'Other devices see you as On this network' : 'Other devices see you as Away'),
      (e: unknown) => {
        setSelfPresenceLocal(presence);
        setError(e instanceof Error ? e.message : 'The engine refused the change.');
      },
    );
  };

  return (
    <Section title="This device">
      <SwitchRow
        title="Are you using this device right now?"
        sub={`Other devices see this ${deviceNoun ?? 'device'} as ${on ? 'On this network' : 'Away'}.`}
        state={on ? 'on' : 'off'}
        onPress={toggle}
        testID="switch-presence"
      />
      {error ? <Note tone="err" title="Presence did not change" body={error} testID="presence-error" /> : null}
    </Section>
  );
}

