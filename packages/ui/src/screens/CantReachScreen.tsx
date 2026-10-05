import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Accordion, AppBar, Bullets, Hero, ONB_GLYPHS } from '../components/Onboarding';
import { Btn, Note, Section } from '../components/ds';
import { ui } from '../theme';

/**
 * The prototype's cant-reach screen (sc-cant-reach).
 *
 * THE ONE PROTOTYPE SCREEN THAT HAD TO LOSE ITS COPY. The prototype's warning
 * note is titled with a Wi-Fi name -- "Looking on Home-5G" -- and its body
 * repeats it. Nothing in this codebase knows the name of the network this
 * device is on: there is no API for it on iOS and no permission for it on
 * Android. So the note cannot be a network name, and rendering one would name
 * a network Daak has never asked about. What replaces it is the fact that is
 * actually known: discovery found nobody.
 *
 * The prototype's queue block ("Waiting to send") is a list of real outbox
 * transfers, handed in as a prop by the host. It is not synthesised here.
 */
export interface QueuedTransfer {
  transferId: string;
  /** Whatever the transfer is labelled with, from the real engine list. */
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
}: {
  queued?: QueuedTransfer[];
  onRetry: () => void;
  onOpenSettings: () => void;
  onBack?: () => void;
  retrying?: boolean;
  /**
   * The real engine.devices() rejection, when the last attempt was the CHECK
   * FAILING rather than the network coming back empty.
   *
   * This is the one screen state that had no truthful rendering. The engine
   * SKIPS a peer whose protocol version it refuses, so a failing devices() is
   * most often an out-of-step peer -- not an empty network and not a broken
   * engine. Rendering "Discovery found no other Daak device" there names the
   * wrong cause twice, and "Your paired devices are still paired" beside it is
   * a claim Daak cannot make: the peer exists and Daak is refusing to talk to it.
   *
   * So a failed check leads with what IS known, and says the real next step --
   * update whichever side is behind. It is the same advice Update Required
   * gives, arrived at honestly, because the engine has no better fact to offer:
   * the check failed and Daak cannot tell you which device is out of step.
   */
  error?: string;
}) {
  return (
    <View style={ui.screen} testID="screen-cant-reach">
      <AppBar title="No connection" onBack={onBack} backLabel="Back to Settings" />
      {/* Deliberately not a fit screen, so it uses AppBar + a padded
          ScrollView rather than OnboardingScreen's centred column: this one
          has real scrolling content and the actions belong after it. */}
      <ScrollView contentContainerStyle={ui.pad}>
        <Hero
          glyph={ONB_GLYPHS.noConnection}
          title={error === '' ? "Daak can't reach any devices" : 'Daak could not finish the search'}
          lead={
            error === ''
              ? "Daak only works between devices on the same Wi-Fi. Right now it can't find one."
              : "Daak looked for devices on this Wi-Fi and did not get an answer back, so it cannot tell you whether anyone is there."
          }
        />

        {error === '' ? (
          <Note
            tone="warn"
            title="Nothing on this Wi-Fi is answering"
            body="Discovery found no other Daak device. If one is in the room, the two of you are probably on different networks."
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
              'Everything already in your Inbox is untouched.',
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
                    <Text style={ui.rowSub}>{t.bytesTotal} bytes, waiting for a device</Text>
                  </View>
                </View>
              ))}
            </View>
          </Section>
        )}

        <View style={ui.stackSm}>
          <Btn
            variant="primary"
            block
            label={retrying ? 'Looking again' : 'Try again'}
            testID="cant-reach-retry"
            disabled={retrying}
            onPress={onRetry}
          />
          <Btn variant="ghost" block label="Open Settings" testID="cant-reach-settings" onPress={onOpenSettings} />
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
