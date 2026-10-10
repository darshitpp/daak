import React, { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Btn } from '../components/ds';
import { OnboardingScreen } from '../components/Onboarding';
import { colors, ui } from '../theme';

/** The design `maxlength` of the name field. The screen enforces it while the user types. */
export const MAX_NAME = 18;

/**
 * The Name step (design route `name-device`).
 *
 * The design checks the name when the field loses focus and when the user
 * presses Continue. It does not check on first render, and it does not disable
 * Continue. The error clears as soon as the name is not blank.
 *
 * `footer` is the sentence under the button. The host sets it, because the
 * number of steps that remain depends on the host.
 */
export function NameDeviceScreen({
  name,
  onNameChange,
  onContinue,
  onBack,
  submitLabel = 'Continue',
  title = 'Name this device',
  footer = 'Three quick steps left.',
}: {
  name: string;
  onNameChange: (next: string) => void;
  onContinue: () => void;
  onBack?: () => void;
  submitLabel?: string;
  /** The appbar title. */
  title?: string;
  /** The sentence under the button. `null` removes it. */
  footer?: string | null;
}) {
  const [touched, setTouched] = useState(false);
  const blank = name.trim() === '';
  const showError = touched && blank;
  return (
    <OnboardingScreen
      title={title}
      onBack={onBack}
      testID="screen-name-device"
      actions={
        <>
          <Btn
            variant="primary"
            block
            label={submitLabel}
            testID="name-next"
            onPress={() => {
              if (blank) {
                setTouched(true);
                return;
              }
              onContinue();
            }}
          />
          {footer === null ? null : <Text style={ui.hint}>{footer}</Text>}
        </>
      }
    >
      <Text style={ui.lead}>Other devices on your Wi-Fi will see this name so you can pick the right one.</Text>
      <View style={ui.stackSm}>
        <Text style={ui.kvK}>Device name</Text>
        <TextInput
          value={name}
          onChangeText={onNameChange}
          onBlur={() => setTouched(true)}
          placeholder="Device name"
          placeholderTextColor={colors.meta}
          autoCorrect={false}
          maxLength={MAX_NAME}
          testID="name-input"
          style={ui.input}
        />
        {showError ? (
          <View style={ui.errMsg} testID="name-error">
            <Text style={ui.errMark}>!</Text>
            <Text style={ui.errTxt}>Give this device a name so people can tell it apart.</Text>
          </View>
        ) : (
          <Text style={ui.hint}>Short names are easier to spot. You can change this later.</Text>
        )}
      </View>
    </OnboardingScreen>
  );
}

