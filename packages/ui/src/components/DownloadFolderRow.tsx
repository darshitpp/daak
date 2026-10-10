import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Btn, Note, Section } from './ds';
import { useToast } from './Toast';
import { ui } from '../theme';

/**
 * R42p: where received files go.
 *
 * The VERBS are injected and the STATE lives here, and both halves of that are
 * deliberate. packages/ui reaches no TurboModule, so the picker can only come
 * from the host. The name is held HERE rather than in the shell because the
 * shell owns the tray overlay: a state update one level up re-runs that hook,
 * and the desktop's tray-survival test rightly notices a second call.
 *
 * `load` resolves the remembered folder's display name, or null when none was
 * chosen. `choose` resolves the new name, or null when the user cancelled -- a
 * cancelled picker is an ANSWER, not an error, and the row must not change.
 * `choose` absent means the host has no picker: the row shows the iPhone
 * prototype words and no button.
 */
export function DownloadFolderRow({ load, choose, reset, title, chooseLabel }: {
  load: () => Promise<string | null>;
  choose?: () => Promise<string | null>;
  reset?: () => Promise<void>;
  title?: string;
  chooseLabel?: string;
}) {
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void load().then(
      (stored) => {
        if (!cancelled) setName(stored);
      },
      // A read that fails leaves the row saying the app's own storage, which is
      // true whenever no folder is remembered.
      () => {
        if (!cancelled) setName(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (choose === undefined) {
    return (
      <Section title={title ?? 'Where received files go'}>
        <View style={ui.card}>
          <View style={[ui.kv, ui.kvFirst]}>
            <Text style={ui.kvK}>Saved to</Text>
            <Text style={ui.kvV} testID="download-folder-name" numberOfLines={2}>
              {name ?? 'Daak · On My iPhone'}
            </Text>
          </View>
        </View>
        <Text style={ui.hint}>
          {"iOS keeps received files in Daak's own folder. There's no folder to pick."}
        </Text>
      </Section>
    );
  }

  return (
    <Section title={title ?? 'Where received files go'}>
      <View style={ui.card}>
        <View style={[ui.kv, ui.kvFirst]}>
          <Text style={ui.kvK}>Folder</Text>
          <Text style={ui.kvV} testID="download-folder-name" numberOfLines={2}>
            {name ?? 'This app\u2019s own storage'}
          </Text>
        </View>
      </View>
      <Btn
        label={chooseLabel ?? 'Choose a folder'}
        testID="download-folder-choose"
        block
        disabled={busy}
        onPress={() => {
          setBusy(true);
          void choose()
            .then(
              (chosen) => {
                if (chosen !== null) {
                  setName(chosen);
                  // Design `showToast('Files save to ' + savePath)`. A
                  // cancelled picker shows nothing.
                  toast.show(`Files save to ${chosen}`);
                }
              },
              () => {},
            )
            .then(() => setBusy(false));
        }}
      />
      {name && reset ? (
        <Btn
          variant="ghost"
          block
          // A JS EXPRESSION, not a bare attribute: JSX attribute text is not a
          // JavaScript string, so \u2019 in `label="..."` renders the six
          // characters literally. Same words, evaluated.
          label={'Use the app\u2019s own storage'}
          testID="download-folder-reset"
          onPress={() => {
            void reset().then(() => setName(null), () => {});
          }}
        />
      ) : null}
      <Note
        title="Files are moved, not copied"
        body="A file that arrives is moved to the folder you choose, so it is stored once and you can open it from your own file manager."
      />
    </Section>
  );
}

