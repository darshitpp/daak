import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useEngine } from '../EngineContext';
import { Btn, Note, Section } from '../components/ds';
import { DownloadFolderRow } from '../components/DownloadFolderRow';
import { colors, ui } from '../theme';

type Feedback = { tone: 'ok' | 'err'; title: string; body: string } | null;

// How many times the mounted read asks again before it stops, and how long it
// waits between asks.
//
// The bound matters: engine.start() is behind a keychain read on macOS, so the
// wait can be a second or more, and the read must outlast it. Eight tries
// across NAME_READ_RETRY_MS is a ceiling of 8 seconds, which is long enough for
// a cold keychain prompt and short enough that a screen mounted against a
// genuinely dead engine settles into a note instead of polling a process
// for ever. A read that succeeds schedules NOTHING, so a healthy engine pays
// for none of this.
const NAME_READ_ATTEMPTS = 8;
const NAME_READ_RETRY_MS = 1000;

/**
 * `background` is a SLOT, injected by the host app (apps/mobile passes the
 * BackgroundSyncNotice, which is the only thing that may call
 * requestBatteryExemption). packages/ui depends on @daak/core and nothing
 * else, and @daak/platform reaches TurboModules via getEnforcing at import
 * time -- importing it here would invert the dependency direction and break
 * every ui test that renders this screen.
 */
export function SettingsScreen({ background, onCheckConnection, downloadFolder }: {
  background?: React.ReactNode;
  /**
   * R42p: where received files go. Injected for the same reason `background`
   * is a slot -- the folder picker is a platform call, and packages/ui reaches
   * no TurboModule. `name` is null until the user chooses one, and the default
   * then is the app's own storage, which is what the copy below says.
   */
  downloadFolder?: {
    load: () => Promise<string | null>;
    choose: () => Promise<string | null>;
    reset?: () => Promise<void>;
  };
  /**
   * The prototype's "Something not working? See what to check" button, in the
   * Connection section (prototypes/index.html:1237). Injected for the same
   * reason `background` is a slot: only the host owns the engine and can say
   * whether anybody is actually reachable.
   */
  onCheckConnection?: () => void;
}) {
  const engine = useEngine();
  const [name, setName] = useState('');
  const [away, setAway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Feedback>(null);
  // What the box holds RIGHT NOW, readable from the retry closure without
  // making the box an effect dependency -- which would tear down the timer and
  // restart the read on every keystroke. This is the user's own text and
  // nothing else: a ref is the right shape for it precisely because it must
  // not trigger a render.
  const nameRef = useRef('');

  // The name box opens on what the device is ACTUALLY called. It used to open
  // empty, which made an existing name look unset and invited a user to save
  // a blank over a real one -- the engine then re-resolves and may pick a
  // different LAN-unique suffix for the same input. `selfProfile` is the read
  // half of setDisplayName. It returns BOTH names: `name` is the RESOLVED name
  // (the peer-visible one, which carries a LAN-collision prefix), and
  // `baseName` is the name the user typed. The box shows `baseName`, because
  // "Rustic Otter . D2Dp" is unreadable to a user who typed "D2Dp".
  //
  // A rejected read is SHOWN, and it is retried. Both halves were missing.
  //
  // Shown: the handler used to be an EMPTY arrow, so a failed read left the box
  // blank and the screen said nothing at all. A blank box plus a working Save
  // is indistinguishable from a device that was never named, which is exactly
  // what the user sees when a stored name fails to come back.
  //
  // Retried: this effect depends on the engine object, and that object is
  // stable for the process, so the read ran ONCE at mount. A host can mount
  // this screen before the engine is up -- Daak.swift's need() throws
  // DaakError.notStarted and daak-ffi answers "engine not started" until
  // engine.start() has resolved -- and a read that lost that race was over for
  // good. Nothing re-ran it, so the box stayed blank for the rest of the
  // session even though the name was in the database the whole time.
  //
  // The retry is a bounded TIMER, not a subscription. DaakEngine has no
  // ready signal and no start event, and this task must not invent a global
  // store or a provider to carry one. It stops on the FIRST success, so a
  // healthy engine schedules one read and no timer at all.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (attempt: number) => {
      void engine.selfProfile().then(
        (p) => {
          if (!alive) return;
          // This branch is the ONLY place the retry loop stops: the loop has
          // no other exit, so a read that answers never schedules again.
          //
          // The box is filled only when the user has NOT typed. A timer armed
          // before the first keystroke still fires after it, so the check
          // cannot live only on the scheduling side -- a name resolved from
          // the database must never overwrite what someone is in the middle
          // of typing. The typed text stays, and the user owns it from here.
          if (!nameRef.current.trim()) {
            nameRef.current = p.baseName;
            setName(p.baseName);
          }
          // The complaint is dropped either way: the engine can answer now,
          // and a note about a load that has since succeeded is a stale fault.
          setNote(null);
        },
        (e: unknown) => {
          if (!alive) return;
          setNote({
            tone: 'err',
            title: 'Name did not load',
            body:
              e instanceof Error
                ? e.message
                : 'The engine would not answer for this device.',
          });
          // A box the user has already filled needs no retry: overwriting what
          // they typed would lose it, and their Save is the honest path from
          // there. The blank box is the one this loop exists to fill.
          if (attempt < NAME_READ_ATTEMPTS && !nameRef.current.trim()) {
            timer = setTimeout(() => read(attempt + 1), NAME_READ_RETRY_MS);
          }
        },
      );
    };
    read(0);
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [engine]);

  // Every engine call here is awaited and reported. The old screen fired and
  // forgot, so a rejected setDisplayName looked exactly like a successful one.
  const run = async (what: string, verb: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await verb();
      // Re-read rather than trusting the local state: a rename re-resolves
      // against the LAN, so what the device is called afterwards can differ
      // from what was typed (a collision adds a suffix).
      await engine.selfProfile().then(
        (p) => {
          // nameRef follows, or the ref would still hold the pre-rename text
          // and a later retry could mistake this box for one the user owns.
          nameRef.current = p.baseName;
          setName(p.baseName);
        },
        (e: unknown) => {
        },
      );
      setNote({ tone: 'ok', title: what, body: 'Saved on this device.' });
    } catch (e) {
      setNote({
        tone: 'err',
        title: what + ' did not save',
        body: e instanceof Error ? e.message : 'The engine refused the change.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={ui.screen}>
      <View style={ui.appbar}>
        <Text style={ui.appbarTitle}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={ui.pad} keyboardShouldPersistTaps="handled">
        <Section title="What other devices call this">
          <View style={ui.stackSm}>
            <TextInput
              value={name}
              // THE ONE place the box is written by hand. nameRef follows it
              // because the retry reads that ref to decide whether a box the
              // user has filled is one it may overwrite.
              onChangeText={(text) => {
                nameRef.current = text;
                setName(text);
              }}
              placeholder="Display name"
              placeholderTextColor={colors.meta}
              autoCorrect={false}
              style={ui.input}
            />
            <Text style={ui.hint}>Short names are easier to spot. You can change this later.</Text>
            <Btn
              label="Save name"
              testID="save-name"
              disabled={busy || name.trim() === ''}
              onPress={() => void run('Name', () => engine.setDisplayName(name.trim()))}
              block
            />
          </View>
        </Section>

        <Section title="Are you using this device right now">
          <View style={ui.stackSm}>
            <View style={ui.seg}>
              {(['online', 'away'] as const).map((state) => {
                const on = (state === 'away') === away;
                return (
                  <Pressable
                    key={state}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() => setAway(state === 'away')}
                    style={[ui.segItem, on ? ui.segItemOn : null]}
                  >
                    <Text style={on ? { color: colors.onAccent, fontSize: 14 } : { color: colors.fg, fontSize: 14 }}>
                      {state === 'online' ? 'Available' : 'Set as away'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={ui.hint}>
              {away
                ? 'Other devices hold anything they try to send.'
                : 'Other devices can send to this device now.'}
            </Text>
            <Btn
              label={away ? 'Set as away' : 'Set as Available'}
              testID="apply-presence"
              disabled={busy}
              onPress={() => void run('Presence', () => engine.setPresence(away ? 'away' : 'online'))}
              block
            />
          </View>
        </Section>

        {/* The prototype's Connection section. The prototype fills it with a
            Status row reading "Working" and a "This Wi-Fi" row reading
            "Home-5G" (prototypes/index.html:1229-1234); neither is available
            here. Nothing in this codebase knows whether the engine is reachable
            -- that is the host's real devices() answer, not a constant -- and
            nothing knows the name of the network this device is on: there is no
            API for it on iOS and no permission for it on Android. So both rows
            are gone and only the button survives, because the button is the
            part that leads somewhere real. */}
        <Section title="Connection">
          {onCheckConnection ? (
            <Btn
              variant="quiet"
              block
              label="Something not working? See what to check"
              testID="settings-check-connection"
              onPress={onCheckConnection}
            />
          ) : null}
        </Section>

        <Section title="About Daak">
          <View style={ui.card}>
            <View style={[ui.kv, ui.kvFirst]}>
              <Text style={ui.kvK}>Works on</Text>
              <Text style={ui.kvV}>This Wi-Fi only</Text>
            </View>
            <View style={ui.kv}>
              <Text style={ui.kvK}>Account needed</Text>
              <Text style={ui.kvV}>No account, none</Text>
            </View>
            <View style={ui.kv}>
              <Text style={ui.kvK}>Where files are kept</Text>
              <Text style={ui.kvV}>On your devices</Text>
            </View>
          </View>
        </Section>

        {note ? <Note tone={note.tone} title={note.title} body={note.body} testID="settings-result" /> : null}
        {downloadFolder ? (
          <DownloadFolderRow
            load={downloadFolder.load}
            choose={downloadFolder.choose}
            reset={downloadFolder.reset}
          />
        ) : null}
        {background}
      </ScrollView>
    </View>
  );
}
