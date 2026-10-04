import React from 'react';
import { Text, TextInput, View } from 'react-native';
import { Btn, Note } from '../components/ds';
import { OnboardingScreen } from '../components/Onboarding';
import { colors, ui } from '../theme';

/**
 * The prototype's screen 2 (sc-name-device).
 *
 * MAX_NAME is the prototype's maxlength="18", enforced here as well as on the
 * engine's side: the engine's limit is a rejection after the fact, and a user
 * who can type past 18 and only then be refused has been told the limit too
 * late for it to be useful.
 *
 * The error line is the prototype's own err-msg, and it is shown for the empty
 * case rather than only hiding the button. A disabled Next is how the user
 * learns the field is required; the line under the field is how they learn
 * what to do about it.
 */
export const MAX_NAME = 18;

/**
 * Platform copy overrides.
 *
 * The defaults are the MOBILE screen's words. The desktop prototype's own
 * step says "Name this Mac", asks what other devices should call you, and
 * suggests a computer name -- none of which is wrong on a phone and all of
 * which reads as a leftover on a Mac.
 *
 * Every field is optional and the component falls back per-field, so the
 * mobile caller passes nothing and keeps its exact text.
 */
export interface NameDeviceCopy {
  /** The screen's h1. */
  heading?: string;
  /** The paragraph under the heading. */
  lead?: string;
  /** The hint under the field, shown when the name is not blank. */
  hint?: string;
  /** The empty-field error line. */
  error?: string;
  /** The closing reassurance note. Pass null to omit it entirely. */
  note?: { title: string; body: string } | null;
}

export function NameDeviceScreen({
  name,
  onNameChange,
  onContinue,
  onBack,
  submitLabel = 'Next',
  title = 'Step 1 of 3',
  copy,
}: {
  name: string;
  onNameChange: (next: string) => void;
  onContinue: () => void;
  onBack?: () => void;
  /** "Next" in the flow; the Settings editor reuses this with its own label. */
  submitLabel?: string;
  /** The flow's step counter, or undefined when this is not a step. */
  title?: string;
  /** Platform-specific wording; omitted on mobile. See NameDeviceCopy. */
  copy?: NameDeviceCopy;
}) {
  const blank = name.trim() === '';
  const heading = copy?.heading ?? 'Name this device';
  const lead =
    copy?.lead ??
    'Choose a name the people at home will recognise. It shows up whenever someone sends you something.';
  const hint = copy?.hint ?? 'Up to ' + MAX_NAME + ' characters, like "Darshit\'s Pixel".';
  const error = copy?.error ?? 'Type a name so people know which device is yours.';
  const note = copy?.note === undefined ? { title: 'Only on your Wi-Fi', body: 'People on your network can see this name. Nobody else can.' } : copy.note;
  return (
    <OnboardingScreen
      title={title}
      onBack={onBack}
      backLabel="Back to Daak"
      testID="screen-name-device"
      actions={
        <Btn
          variant="primary"
          block
          label={submitLabel}
          testID="name-next"
          disabled={blank}
          onPress={onContinue}
        />
      }
    >
      <View style={ui.stack}>
        <Text style={ui.h1}>{heading}</Text>
        <Text style={ui.lead}>{lead}</Text>
      </View>

      <View style={ui.stackSm}>
        <Text style={ui.kvK}>Device name</Text>
        <TextInput
          value={name}
          onChangeText={onNameChange}
          placeholder="Device name"
          placeholderTextColor={colors.meta}
          autoCorrect={false}
          maxLength={MAX_NAME}
          testID="name-input"
          style={ui.input}
        />
        {blank ? (
          <View style={ui.errMsg} testID="name-error">
            <Text style={ui.errMark}>!</Text>
            <Text style={ui.errTxt}>{error}</Text>
          </View>
        ) : (
          <Text style={ui.hint}>{hint}</Text>
        )}
      </View>

      {note === null ? null : <Note title={note.title} body={note.body} />}
    </OnboardingScreen>
  );
}
