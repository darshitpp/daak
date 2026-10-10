import React, { useState } from 'react';
import { ScrollView, View, Text } from 'react-native';
import { AppBar, Hero, KvCard, ONB_GLYPHS } from '../components/Onboarding';
import { Btn, Note } from '../components/ds';
import { ui } from '../theme';

/** The app version and build number, when the host can read them. */
export interface AppVersion {
  version: string;
  build: string;
}

/**
 * The Update-available screen (design route `update-required`).
 *
 * Ruling D2: there is no updater and no update server. The primary action
 * "Open the download page" opens the releases page through the host.
 *
 * The screen does not block sending. It has two exits: the back arrow and
 * "Remind me later". Both call `onDismiss`.
 *
 * The card has one row, "This app", with the real app version. The "Latest"
 * row is removed (user decision; the design was edited to match). The screen
 * takes no peers. `useBlockers` decides when it opens.
 */
export function UpdateRequiredScreen({
  onDismiss,
  onOpenDownloadPage,
  app,
}: {
  onDismiss: () => void;
  /** Opens the releases page. A rejection shows a fallback note. */
  onOpenDownloadPage: () => void | Promise<unknown>;
  app?: AppVersion;
}) {
  const [failed, setFailed] = useState(false);
  const rows: { k: string; v: string; nowrap?: boolean }[] = [];
  if (app !== undefined) {
    rows.push({ k: 'This app', v: `Version ${app.version} (build ${app.build})`, nowrap: true });
  }
  return (
    <View style={ui.screen} testID="screen-update-required">
      <AppBar title="Update available" onBack={onDismiss} backLabel="Back" />
      <ScrollView contentContainerStyle={ui.pad}>
        <Hero
          glyph={ONB_GLYPHS.update}
          title="A new version of Daak is available"
          lead="Daak updates happen in your browser. This version keeps working until you're ready."
        />

        {rows.length === 0 ? null : <KvCard rows={rows} />}

        <Note
          tone="plain"
          title="Sending still works"
          body="Your paired devices and everything already in your conversations are safe. Install when it suits you."
        />

        <View style={ui.stackSm}>
          <Btn
            variant="primary"
            block
            label="Open the download page"
            testID="update-open"
            onPress={() => {
              setFailed(false);
              // The call runs at once, so a test can see it. A sync throw and a
              // rejected promise both show the fallback note.
              try {
                void Promise.resolve(onOpenDownloadPage()).catch(() => setFailed(true));
              } catch {
                setFailed(true);
              }
            }}
          />
          <Btn variant="ghost" block label="Remind me later" testID="update-dismiss" onPress={onDismiss} />
          <Text style={ui.hint}>Opens the Daak releases page in your browser.</Text>
        </View>
        {failed ? (
          <Note
            tone="warn"
            title="Daak could not open the page"
            body="Open github.com/darshitpp/daak/releases in a browser to find the newest version."
            testID="update-open-failed"
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
