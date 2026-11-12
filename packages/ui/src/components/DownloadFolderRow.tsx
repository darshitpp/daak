import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Btn, Note, Section } from './ds';
import { useToast } from './Toast';
import { ui } from '../theme';

// The value text must shrink inside the row. Other screens use ui.kvV as is.
const shrink = { flexShrink: 1 } as const;

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
export function DownloadFolderRow({ load, choose, reset, canReset, title, chooseLabel, hideNote }: {
  load: () => Promise<string | null>;
  choose?: () => Promise<string | null>;
  reset?: () => Promise<void>;
  /**
   * The host says whether a name is one the user can reset. The reset button
   * shows only when this returns true. A host can return false for its default
   * folder, because a reset does not change that folder. Default: always true.
   */
  canReset?: (name: string) => boolean;
  title?: string;
  chooseLabel?: string;
  /** Removes the "Files are moved, not copied" note. The onboarding step has its own note. Default false. */
  hideNote?: boolean;
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
      // A read that fails leaves the row saying the app's own storage. The
      // host can return null when it has no public folder to name.
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
            <Text style={[ui.kvV, shrink]} testID="download-folder-name" numberOfLines={1} ellipsizeMode="middle">
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
          <Text style={[ui.kvV, shrink]} testID="download-folder-name" numberOfLines={1} ellipsizeMode="middle">
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
      {name && reset && (canReset === undefined || canReset(name)) ? (
        <Btn
          block
          label="Use the default folder"
          testID="download-folder-reset"
          onPress={() => {
            // After a reset the host can name a default folder. Read the name
            // again. Do not assume null.
            void reset()
              .then(() => load().then((n) => n, () => null))
              .then((n) => setName(n), () => {});
          }}
        />
      ) : null}
      {hideNote !== true ? (
        <Note
          title="Files are moved, not copied"
          body="A file that arrives is moved to the folder you choose, so it is stored once and you can open it from your own file manager."
        />
      ) : null}
    </Section>
  );
}

