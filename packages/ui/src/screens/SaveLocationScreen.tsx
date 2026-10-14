import React, { useRef } from 'react';
import { Text, View } from 'react-native';
import { Btn, Note } from '../components/ds';
import { DownloadFolderRow } from '../components/DownloadFolderRow';
import { OnboardingScreen } from '../components/Onboarding';
import type { PhotosHost } from '../components/PhotosAccessRow';
import { ui } from '../theme';

export interface SaveLocationFolder {
  load: () => Promise<string | null>;
  /** Omitted on a platform where the user cannot choose a folder. */
  choose?: () => Promise<string | null>;
  reset?: () => Promise<void>;
}

/**
 * The Save-location step (design route `save-location`).
 *
 * It reuses `DownloadFolderRow`, so Settings and this step share one set of
 * verbs. Continue needs no choice, because the default folder is valid. When
 * `folder.choose` is undefined the step shows no "Change folder" button, and
 * the screen prints the iPhone words of `index.html`. The picker variant prints
 * the words of `android.html` and `macos.html`. The fallback is the path for a
 * host without `choose`. It is not the iOS path, because the mobile hosts pass
 * `choose`.
 *
 * `footer` is the sentence under the button. The host sets it, because the
 * number of steps that remain depends on the host.
 */
export function SaveLocationScreen({ folder, photos, onContinue, onBack, footer = 'One quick step left.' }: {
  folder: SaveLocationFolder;
  /** The host's Photos verbs. Continue asks for access once when this is set. */
  photos?: PhotosHost;
  onContinue: () => void;
  onBack?: () => void;
  footer?: string | null;
}) {
  const canChoose = folder.choose !== undefined;
  const busy = useRef(false);
  return (
    <OnboardingScreen
      title="Where to save files"
      onBack={onBack}
      testID="screen-save-location"
      actions={
        <>
          <Btn variant="primary" block label="Continue" testID="save-location-continue" onPress={() => {
              if (!photos) { onContinue(); return; }
              // A second press must not ask again or continue again. The flag stays
              // set after the request settles, because onContinue moves the flow
              // to the next step and this screen goes away.
              if (busy.current) return;
              busy.current = true;
              // A denial or a failure does not block onboarding.
              void photos.request().then(() => onContinue(), () => onContinue());
            }}
          />
          {footer === null ? null : <Text style={ui.hint}>{footer}</Text>}
        </>
      }
    >
      {canChoose ? (
        <>
          <Text style={ui.lead}>
            Pick the folder where files you receive are saved. You can change this later in Settings.
          </Text>
          <DownloadFolderRow
            load={folder.load}
            choose={folder.choose}
            reset={folder.reset}
            title="Save files to"
            chooseLabel="Change folder"
            hideNote
          />
          <Text style={ui.hint}>Files from other devices land here.</Text>
          {photos ? (
            <Text style={ui.hint}>{`Photos and videos go to ${photos.destination}. Other files go to this folder.`}</Text>
          ) : null}
          <Note title="Only on this device" body="Files are saved here, not in the cloud. Nothing is uploaded." />
        </>
      ) : (
        <>
          <Text style={ui.lead}>iOS saves the files you receive for you. There's no folder to pick.</Text>
          <View style={ui.card}>
            <View style={[ui.kv, ui.kvFirst]}>
              <Text style={ui.kvK}>Saved to</Text>
              <Text style={ui.kvV} testID="save-location-fixed">Daak · On My iPhone</Text>
            </View>
          </View>
          <Note
            title="Only on this device"
            body="Files are saved in Daak's folder, not in the cloud. Nothing is uploaded."
          />
        </>
      )}
    </OnboardingScreen>
  );
}

