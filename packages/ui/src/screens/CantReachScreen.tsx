import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Accordion, AppBar, Bullets, Hero, ONB_GLYPHS } from '../components/Onboarding';
import { Btn, Note, Section, type DeviceNoun } from '../components/ds';
import { ui } from '../theme';
import { humanBytes } from './quarantine-facts';

/**
 * The Cannot-reach screen (design route `cant-reach`).
 *
 * Ruling D6: nothing in this codebase reads the Wi-Fi name. The design shows a
 * mock name ("Home-5G"). Every place that the design fills with the name reads
 * "this Wi-Fi" here.
 *
 * The queue block ("Waiting to send") is a list of real outbox transfers. The
 * host passes it in. This screen does not make rows.
 */
export interface QueuedTransfer {
  transferId: string;
  /** What the transfer is labelled with, from the real engine list. */
  label: string;
  bytesTotal: number;
}

export function CantReachScreen({
  queued = [],
  onRetry,
  onOpenSettings,
  onBack,
  retrying = false,
  error = '',
  deviceNoun = 'device',
}: {
  queued?: QueuedTransfer[];
  onRetry: () => void;
  onOpenSettings: () => void;
  onBack?: () => void;
  retrying?: boolean;
  /**
   * The real `engine.devices()` rejection, when the last attempt was the check
   * failing and not the network coming back empty. The engine skips a peer whose
   * protocol version it refuses, so a failing check is most often a peer that is
   * out of step. The screen then leads with what is known and gives the real
   * next step: update whichever device is behind.
   */
  error?: string;
  /** The word for this device. The host sets it, because ui has no platform check. */
  deviceNoun?: DeviceNoun | 'device';
}) {
  // The design shows a hint after the first retry that finds nobody. This
  // screen unmounts when a retry finds a device, so a finished retry that
  // leaves the screen mounted means "still nothing".
  const [looked, setLooked] = useState(false);
  const wasRetrying = useRef(false);
  useEffect(() => {
    if (wasRetrying.current && !retrying) setLooked(true);
    wasRetrying.current = retrying;
  }, [retrying]);

  return (
    <View style={ui.screen} testID="screen-cant-reach">
      <AppBar title="No connection" onBack={onBack} backLabel="Back to Settings" />
      <ScrollView contentContainerStyle={ui.pad}>
        <Hero
          glyph={ONB_GLYPHS.noConnection}
          title={error === '' ? "Daak can't reach any devices" : 'Daak could not finish the search'}
          lead={
            error === ''
              ? "Daak only works between devices on the same Wi-Fi. Right now it can't find one."
              : 'Daak looked for devices on this Wi-Fi and did not get an answer back, so it cannot tell you whether anyone is there.'
          }
        />

        {error === '' ? (
          <Note
            tone="warn"
            title="Looking on this Wi-Fi"
            // The design phone copy (index.html, cant-reach) and the design Mac
            // copy (macos.html) both say "the same network".
            body={`This ${deviceNoun} is on this Wi-Fi. The devices you paired need to be on the same network too.`}
          />
        ) : (
          <>
            <Note
              tone="warn"
              title="Daak could not read the devices on this Wi-Fi"
              body="The search did not finish, so this is not a report that nobody is there. Something stopped the check:"
              testID="cant-reach-error"
            />
            <Note tone="err" title="What the check said" body={error} testID="cant-reach-error-detail" />
            <Note
              tone="plain"
              title="If a device you use is on this Wi-Fi"
              body="Two devices can only pair when their file-moving versions match. Update Daak on whichever device is behind and they will pair again. Nothing already paired is lost either way."
            />
          </>
        )}

        <View>
          <Text style={ui.sectionT}>Still fine</Text>
          <Bullets
            items={[
              'Your paired devices are still paired.',
              'Everything already in your conversations is untouched.',
            ]}
          />
        </View>

        {queued.length === 0 ? null : (
          <Section title="Waiting to send">
            <View style={ui.list}>
              {queued.map((t, i) => (
                <View
                  key={t.transferId}
                  style={[ui.listRow, i === 0 ? ui.kvFirst : null]}
                  testID="cant-reach-queued"
                >
                  <View style={ui.fill}>
                    <Text style={ui.rowTitle}>{t.label}</Text>
                    <Text style={ui.rowSub}>{humanBytes(t.bytesTotal)}</Text>
                  </View>
                </View>
              ))}
            </View>
            <Text style={ui.hint}>
              {`${queued.length} ${queued.length === 1 ? 'item' : 'items'} will go by itself as soon as Daak finds the network again.`}
            </Text>
          </Section>
        )}

        <View style={ui.stackSm}>
          <Btn
            variant="primary"
            block
            label={retrying ? 'Checking' : 'Try again'}
            testID="cant-reach-retry"
            disabled={retrying}
            onPress={onRetry}
          />
          <Btn variant="ghost" block label="Open Settings" testID="cant-reach-settings" onPress={onOpenSettings} />
          {looked && error === '' ? (
            <Text style={ui.hint}>Still nothing on this Wi-Fi. Wait a few seconds, then look again.</Text>
          ) : null}
        </View>

        <Accordion label="If this keeps happening" testID="cant-reach-more">
          <Bullets
            items={[
              'Turn Wi-Fi off, then back on.',
              'Check the other devices are on this Wi-Fi, not a guest network or mobile data.',
              'If you just came back from another app, wait a few seconds and try again.',
            ]}
          />
        </Accordion>
      </ScrollView>
    </View>
  );
}
