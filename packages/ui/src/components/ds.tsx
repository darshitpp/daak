import React from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { colors, ui } from '../theme';
export { Wordmark } from './Wordmark';

/**
 * The handful of shapes the Open Design markup uses more than once. Not a
 * component library: eight elements that would otherwise be the same eight
 * lines of View+Text in every screen.
 */

export function Btn({ onPress, label, variant = 'quiet', block, disabled, testID, style }: {
  onPress: () => void;
  label: string;
  variant?: 'primary' | 'quiet' | 'ghost' | 'danger';
  block?: boolean;
  disabled?: boolean;
  testID?: string;
  style?: ViewStyle;
}) {
  const tone =
    variant === 'primary' ? ui.btnPrimary
    : variant === 'ghost' ? ui.btnGhost
    : variant === 'danger' ? ui.btnDanger
    : ui.btnQuiet;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        ui.btn,
        tone,
        block ? ui.btnBlock : null,
        disabled ? ui.btnDisabled : null,
        pressed ? ui.pressed : null,
        style,
      ]}
    >
      <Text style={[variant === 'primary' ? { color: colors.onAccent } : ui.btnLabel]}>{label}</Text>
    </Pressable>
  );
}

/**
 * The status dot plus its word. The word is not decoration: the token amber
 * measures 1.75:1 on cream, so a dot alone would be invisible, and every state
 * has to survive a greyscale screenshot anyway.
 */
export function Status({ tone, label }: { tone: 'ok' | 'warn' | 'off'; label: string }) {
  const fill = tone === 'ok' ? colors.ok : tone === 'warn' ? colors.warn : colors.meta;
  return (
    <View style={ui.statusRow}>
      <View style={[ui.dot, { backgroundColor: fill }]} />
      <Text style={ui.statusTxt}>{label}</Text>
    </View>
  );
}

/** Three states, because the engine has three and two of them are not offline. */
export function devicePresence(online: boolean | undefined): { tone: 'ok' | 'warn' | 'off'; label: string } {
  if (online === true) return { tone: 'ok', label: 'On this network' };
  if (online === false) return { tone: 'off', label: 'Not on this network' };
  return { tone: 'warn', label: 'Ready when connected' };
}

export function Avatar({ letter }: { letter: string }) {
  return (
    <View style={ui.avatar}>
      <Text style={ui.avatarLetter}>{letter.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

export function Note({ title, body, tone = 'plain', testID }: {
  title?: string;
  body: string;
  tone?: 'plain' | 'ok' | 'warn' | 'err';
  testID?: string;
}) {
  const fill =
    tone === 'ok' ? ui.noteOk : tone === 'warn' ? ui.noteWarn : tone === 'err' ? ui.noteErr : null;
  const dot = tone === 'ok' ? colors.ok : tone === 'warn' ? colors.warnInk : tone === 'err' ? colors.err : colors.meta;
  return (
    <View style={[ui.note, fill]} accessibilityLabel={testID}>
      <View style={[ui.dot, { backgroundColor: dot }, ui.noteDot]} />
      <View style={ui.fill}>
        {title ? <Text style={ui.noteTtl}>{title}</Text> : null}
        <Text style={ui.noteTxt}>{body}</Text>
      </View>
    </View>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <View style={ui.empty}>
      <Text style={ui.h3}>{title}</Text>
      <Text style={ui.muted}>{body}</Text>
      {action}
    </View>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={ui.stack}>
      <Text style={ui.sectionT}>{title}</Text>
      {children}
    </View>
  );
}

export function ProgressBar({ pct, failed }: { pct: number; failed?: boolean }) {
  return (
    <View style={ui.barTrack}>
      <View style={[ui.barFill, { width: `${Math.max(0, Math.min(100, pct))}%` }, failed ? { backgroundColor: colors.err } : null]} />
    </View>
  );
}

