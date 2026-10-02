import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useEngine } from '../EngineContext';
import { Btn, Note, Section } from '../components/ds';
import { colors, ui } from '../theme';

type Feedback = { tone: 'ok' | 'err'; title: string; body: string } | null;

/**
 * `background` is a SLOT, injected by the host app (apps/mobile passes the
 * BackgroundSyncNotice, which is the only thing that may call
 * requestBatteryExemption). packages/ui depends on @daak/core and nothing
 * else, and @daak/platform reaches TurboModules via getEnforcing at import
 * time -- importing it here would invert the dependency direction and break
 * every ui test that renders this screen.
 */
export function SettingsScreen({ background }: { background?: React.ReactNode }) {
  const engine = useEngine();
  const [name, setName] = useState('');
  const [away, setAway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Feedback>(null);

  // The name box opens on what the device is ACTUALLY called. It used to open
  // empty, which made an existing name look unset and invited a user to save
  // a blank over a real one -- the engine then re-resolves and may pick a
  // different LAN-unique suffix for the same input. `selfProfile` is the read
  // half of setDisplayName and returns the RESOLVED name, suffix included.
  //
  // A rejected read is NOT shown: an empty box plus a working Save is the
  // pre-existing behaviour and is usable. The Save reports its own failure.
  useEffect(() => {
    void engine.selfProfile().then((p) => setName(p.name), () => {});
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
      await engine.selfProfile().then((p) => setName(p.name), () => {});
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
              onChangeText={setName}
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
        {background}
      </ScrollView>
    </View>
  );
}
