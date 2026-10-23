import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useEngine } from '../../EngineContext';
import { Btn, Note, Section } from '../../components/ds';
import type { SettingsHost } from './host';
import { ui } from '../../theme';

const FALLBACK = 'The share sheet could not open on this device.';

/**
 * Settings "Report an issue". A press asks the engine for the debug bundle,
 * then hands the text to the host share step. The host owns the share sheet.
 * A dismissed sheet resolves like a finished one, so it shows no note.
 */
export function ReportIssueSection({ host }: { host?: SettingsHost }) {
  const engine = useEngine();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref blocks a second press in the same tick, before state updates.
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const share = host?.reportIssue?.share;
  if (!share) return null;

  const press = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await share(await engine.exportDebugBundle());
    } catch (e) {
      if (alive.current) setError(e instanceof Error && e.message ? e.message : FALLBACK);
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return (
    <Section title="Report an issue">
      <View style={ui.cardTight}>
        <View style={ui.row}>
          <Text style={[ui.kvK, ui.fill]}>Something went wrong?</Text>
          <Btn
            variant="quiet"
            size="sm"
            testID="report-issue"
            label={busy ? 'Preparing…' : 'Report an issue'}
            disabled={busy}
            onPress={() => void press()}
          />
        </View>
      </View>
      <Text style={ui.hint}>
        Opens the share sheet with a short log of what Daak did recently. You choose where it goes. Daak sends nothing by itself.
      </Text>
      {error !== null ? (
        <Note tone="err" title="The report did not open" body={error} testID="report-issue-error" />
      ) : null}
    </Section>
  );
}
