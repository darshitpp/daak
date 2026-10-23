import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useEngine } from '../../EngineContext';
import { Btn, Note, Section } from '../../components/ds';
import type { SettingsHost } from './host';
import { ui } from '../../theme';

const FALLBACK = 'The share sheet could not open on this device.';

/**
 * The longest report text, in UTF-16 code units. Android sends the text in one
 * Binder transaction as UTF-16, and that buffer is 1 MiB for the process. The
 * chooser can also copy the text into a ClipData. 128 Ki units are 256 KiB.
 */
export const MAX_SHARE_CHARS = 128 * 1024;
const LOG_HEADER = '=== recent log ===\n';

/**
 * Cut `text` to `MAX_SHARE_CHARS`. It keeps every line up to the log header
 * and the newest whole log lines. The cut is on a line boundary, so it never
 * splits a surrogate pair.
 */
function fitShareText(text: string): string {
  if (text.length <= MAX_SHARE_CHARS) return text;
  const at = text.indexOf(LOG_HEADER);
  const head = at < 0 ? '' : text.slice(0, at + LOG_HEADER.length);
  let start = text.length - (MAX_SHARE_CHARS - head.length);
  if (text[start - 1] !== '\n') {
    const nl = text.indexOf('\n', start);
    start = nl < 0 ? text.length : nl + 1;
  }
  return head + text.slice(start);
}

/**
 * The app version line. The bundle holds the engine library version only.
 * A failed or unknown read gives no line, so it never stops the report.
 */
async function appLine(host?: SettingsHost): Promise<string> {
  try {
    const info = await host?.appInfo?.();
    if (!info || info.version === 'unknown') return '';
    return `app: ${info.version} (build ${info.build})\n`;
  } catch {
    return '';
  }
}

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
      const bundle = await engine.exportDebugBundle();
      await share(fitShareText((await appLine(host)) + bundle));
    } catch (e) {
      // The note shows fixed text. The raw message is a developer string.
      console.warn('daak: report an issue failed:', e);
      if (alive.current) setError(FALLBACK);
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
