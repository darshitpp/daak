import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Note, Section, type DeviceNoun } from '../../components/ds';
import { SwitchRow } from '../../components/Onboarding';
import { useToast } from '../../components/Toast';
import { ui } from '../../theme';
import type { NotifyPrefsLike, SettingsHost } from './host';

const DEFAULTS: NotifyPrefsLike = { arrival: true };

/** The design text for a blocked OS grant (`#set-notif-hint`). Do not reword it. */
export const NOTIFY_BLOCKED_HINT =
  "If notifications for Daak are blocked in your system settings, this switch can't turn alerts on. Allow notifications for Daak there, then try again.";

/**
 * One preference and one OS fact (ruling D8). The app preference and the OS
 * grant are independent. The switch reads off when either is off. When the OS
 * grant is denied, the design hint shows under the switch.
 */
export function ArrivalSection({ host, deviceNoun }: { host?: SettingsHost; deviceNoun?: DeviceNoun }) {
  const store = host?.notifyPrefs;
  // The effect depends on these two functions, not on the host objects. A host
  // that builds a new object on each render keeps the same functions, so the
  // load does not run again and does not overwrite a switch that the user
  // flipped. A host should still memoize `host`, and pass module-level functions.
  const load = store?.load;
  const granted = host?.osAlerts?.granted;
  const toast = useToast();
  const [prefs, setPrefs] = useState<NotifyPrefsLike>(DEFAULTS);
  const [os, setOs] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    // A failed read keeps the default. It is the value the engine uses
    // when nothing is stored.
    void load?.().then((p) => alive && setPrefs(p), () => {});
    void granted?.().then((g) => alive && setOs(g), () => {});
    return () => {
      alive = false;
    };
  }, [load, granted]);

  if (store === undefined) return null;

  const denied = os === false;
  const arrivalOn = prefs.arrival && !denied;

  const change = (next: NotifyPrefsLike) => {
    const before = prefs;
    setPrefs(next);
    setError('');
    store.save(next).then(
      // The design toasts `data-on` and `data-off` of `#set-alerts`.
      () => toast.show(next.arrival ? 'Arrival messages on' : 'Arrival messages off'),
      (e: unknown) => {
        setPrefs(before);
        setError(e instanceof Error ? e.message : 'The setting did not save.');
      },
    );
  };

  return (
    <Section title="Arrival messages">
      <SwitchRow
        title="Tell me when a file arrives"
        sub={`Shows a message on this ${deviceNoun ?? 'device'}.`}
        state={arrivalOn ? 'on' : 'off'}
        onPress={denied ? host?.osAlerts?.openSettings : () => change({ ...prefs, arrival: !prefs.arrival })}
        testID="switch-arrival"
      />
      {denied ? <Text style={ui.hint} testID="notify-blocked-hint">{NOTIFY_BLOCKED_HINT}</Text> : null}
      {error ? <Note tone="err" title="That setting did not save" body={error} testID="arrival-error" /> : null}
    </Section>
  );
}

