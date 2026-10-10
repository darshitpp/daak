import React from 'react';
import { Text, View } from 'react-native';
import { Btn, Section, Status } from '../../components/ds';
import type { Connection } from '../../state/useConnection';
import { ui } from '../../theme';

const STATUS = {
  working: { tone: 'ok', label: 'Working' },
  'not-working': { tone: 'off', label: 'Not working' },
  unknown: { tone: 'off', label: 'Checking' },
} as const;
const WIFI = { connected: 'Connected', 'not-connected': 'Not connected', unknown: 'Checking' } as const;

export function ConnectionSection({ connection, networkLabel, onCheckConnection }: {
  connection: Connection;
  /** Design: 'This Wi-Fi' on iPhone and Android, 'Network' on macOS. */
  networkLabel?: string;
  onCheckConnection?: () => void;
}) {
  const s = STATUS[connection.status];
  return (
    <Section title="Connection">
      <View style={ui.card}>
        <View style={[ui.kv, ui.kvFirst]}>
          <Text style={ui.kvK}>Status</Text>
          <Status tone={s.tone} label={s.label} />
        </View>
        <View style={ui.kv}>
          <Text style={ui.kvK}>{networkLabel ?? 'This Wi-Fi'}</Text>
          <Text style={ui.kvV}>{WIFI[connection.wifi]}</Text>
        </View>
      </View>
      {onCheckConnection ? (
        <Btn
          variant="quiet"
          block
          label="Something not working? See what to check"
          testID="settings-check-connection"
          onPress={onCheckConnection}
        />
      ) : null}
    </Section>
  );
}

