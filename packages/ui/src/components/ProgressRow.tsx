import React from 'react';
import { Text, View } from 'react-native';
import { colors, ui } from '../theme';
import { Btn, ProgressBar } from './ds';

const DONE = new Set(['done', 'canceled']);

export function ProgressRow({ name, bytesDone, bytesTotal, state, error, onCancel, onRetry, onOpen }: {
  name: string;
  bytesDone: number;
  bytesTotal: number;
  state: string;
  error?: string;
  onCancel?: () => void;
  onRetry?: () => void;
  /** Route into the per-transfer detail. A row with no detail to show omits it. */
  onOpen?: () => void;
}) {
  const pct = bytesTotal > 0 ? Math.floor((bytesDone / bytesTotal) * 100) : 0;
  const failed = state === 'failed';
  return (
    <View style={ui.card} accessibilityRole="summary">
      <View style={ui.row}>
        <Text style={[ui.h3, ui.fill]} numberOfLines={1}>{name}</Text>
        <Text style={ui.progN}>{pct}%</Text>
      </View>
      <ProgressBar pct={pct} failed={failed} />
      <View style={ui.row}>
        <Text style={ui.hint} numberOfLines={1}>{state}</Text>
        {error ? <Text style={[ui.hint, { color: colors.err }]} numberOfLines={1}>{error}</Text> : null}
      </View>
      {onCancel && !DONE.has(state) && !failed ? (
        <Btn label="Stop sending" variant="danger" onPress={onCancel} testID={`cancel-${name}`} block />
      ) : null}
      {onRetry && failed ? (
        <Btn label="Try again" variant="primary" onPress={onRetry} testID={`retry-${name}`} block />
      ) : null}
      {onOpen ? (
        <Btn label="Details" variant="ghost" onPress={onOpen} testID={`open-${name}`} block />
      ) : null}
    </View>
  );
}
