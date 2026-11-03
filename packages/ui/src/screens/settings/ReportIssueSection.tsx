import React, { useEffect, useRef, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { useEngine } from '../../EngineContext';
import { Btn, Note, Section } from '../../components/ds';
import type { SettingsHost } from './host';
import { ui } from '../../theme';
import { useToast } from '../../components/Toast';
import { ISSUES_URL } from '../about-links';

const COPY_FAILED = {
  title: 'The report did not copy',
  body: 'The report could not be copied on this device.',
};
const OPEN_FAILED = {
  title: 'The report is copied',
  body: 'Open github.com/darshitpp/daak/issues/new in a browser, then paste.',
};
const FENCE_OPEN = '```text\n';
const FENCE_CLOSE = '\n```';

/**
 * The longest report text, in UTF-16 code units, fence lines included. A
 * GitHub issue body holds at most 65,536 characters.
 */
export const MAX_REPORT_CHARS = 60_000;
const LOG_HEADER = '=== recent log ===\n';

/**
 * Cut `text` to `limit` units. It keeps every line up to the log header
 * and the newest whole log lines. The cut is on a line boundary, so it never
 * splits a surrogate pair.
 */
function fitText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const at = text.indexOf(LOG_HEADER);
  const head = at < 0 ? '' : text.slice(0, at + LOG_HEADER.length);
  let start = text.length - (limit - head.length);
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
 * then hands the fenced text to the host copy step. Then it shows a toast and
 * opens the GitHub new-issue page. A failed copy never opens the page.
 */
export function ReportIssueSection({ host }: { host?: SettingsHost }) {
  const engine = useEngine();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  // A ref blocks a second press in the same tick, before state updates.
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const copy = host?.reportIssue?.copy;
  if (!copy) return null;

  const press = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let copied = false;
    try {
      const bundle = await engine.exportDebugBundle();
      const text = fitText((await appLine(host)) + bundle, MAX_REPORT_CHARS - FENCE_OPEN.length - FENCE_CLOSE.length);
      await copy(FENCE_OPEN + text + FENCE_CLOSE);
      copied = true;
      toast.show('Copied · paste it into the issue');
      await Linking.openURL(ISSUES_URL);
    } catch (e) {
      // The note shows fixed text. The raw message is a developer string.
      console.warn('daak: report an issue failed:', e);
      if (alive.current) setError(copied ? OPEN_FAILED : COPY_FAILED);
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
        Copies a short log of what Daak did recently, then opens GitHub. Paste the log into a new issue. Issues are public, so read the log first. Daak sends nothing by itself.
      </Text>
      {error !== null ? (
        <Note tone="err" title={error.title} body={error.body} testID="report-issue-error" />
      ) : null}
    </Section>
  );
}
