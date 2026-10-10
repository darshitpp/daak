import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { colors, ui } from '../theme';
import { Wordmark } from './ds';

/**
 * The shapes the four onboarding screens share, lifted out so the screens stay
 * screens. The prototype has one `onb` column -- hero at the top, actions
 * pinned at the bottom -- and every onboarding screen uses it, so these are the
 * pieces of that column rather than four near-identical layouts.
 *
 * None of these knows anything about the engine, a TurboModule or the
 * keystore: every permission, version and retry value arrives as a prop from
 * the app, which is why packages/ui takes no @daak/platform dependency.
 */

/**
 * `screen-fit` + `onb`: one scrollable, vertically-centred column with the
 * actions pinned OUTSIDE the scroll view, at the bottom of the screen.
 *
 * The actions must not be inside the scroll content. Inside it, the pinned
 * block claimed slack with `flexGrow`, and when the content was taller than
 * the viewport the block grew past the bottom of the visible area. The button
 * was drawn below the scroll hit area, so it never received a press: on macOS
 * the Next button did nothing. Outside the scroll view, the action bar is the
 * last flex child of the screen column and stays inside the window at any
 * content height, so every button is always reachable.
 *
 * The keyboard is why the actions cannot merely be absolutely positioned over
 * the screen: a screen-level overlay sits UNDER the software keyboard on iOS
 * and Android. This layout avoids both problems. The scroll view takes the
 * remaining height above the action bar, so the keyboard shrinks the scroll
 * area and the content scrolls, and the action bar is never covered.
 */
export function OnboardingScreen({
  title,
  onBack,
  backLabel = 'Go back',
  children,
  actions,
  testID,
}: {
  /** The appbar title. Omitted on Welcome, which has no appbar at all. */
  title?: string;
  onBack?: () => void;
  backLabel?: string;
  children: React.ReactNode;
  /** The pinned block: buttons, plus any hint under them. */
  actions?: React.ReactNode;
  testID?: string;
}) {
  return (
    <View style={[ui.screen, ui.onbScreen]} testID={testID}>
      {title === undefined ? null : (
        <AppBar title={title} onBack={onBack} backLabel={backLabel} />
      )}
      <ScrollView
        contentContainerStyle={ui.onb}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={ui.onbScroll}
      >
        {children}
      </ScrollView>
      {actions === undefined ? null : <View style={[ui.onbActions, ui.onbActionsPinned]}>{actions}</View>}
    </View>
  );
}

/**
 * The appbar with the prototype's back chevron. A separate component because
 * the error screens (cant-reach, update-required) are NOT `fit` -- they have
 * real scrolling content -- so they need the same appbar without the centred
 * column.
 */
export function AppBar({ title, onBack, backLabel = 'Go back', right }: {
  title: string;
  onBack?: () => void;
  backLabel?: string;
  right?: React.ReactNode;
}) {
  return (
    <View style={ui.appbar}>
      {onBack ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={backLabel}
          onPress={onBack}
          style={({ pressed }) => [ui.iconbtn, pressed ? ui.pressed : null]}
          testID="onb-back"
        >
          {/* The prototype's chevron is an SVG and this package has no
              react-native-svg (Wordmark.tsx uses a bundled PNG for that reason), so
              the same mark as a character. No asset, same glyph. */}
          <Text style={[ui.appbarGlyph, { color: colors.fg }]}>‹</Text>
        </Pressable>
      ) : null}
      <Text style={[ui.appbarTitle, onBack ? null : ui.appbarTitleCentred]}>{title}</Text>
      {right}
    </View>
  );
}

/** `hero-mark`: the badge, the headline and the lead, stacked. */
export function Hero({
  glyph,
  title,
  lead,
  wordmark,
}: {
  /** The mark in the circular well. Omitted when `wordmark` is set. */
  glyph?: string;
  title: string;
  lead?: string;
  /** Welcome's variant: the Daaak lockup where the badge would be. */
  wordmark?: boolean;
}) {
  return (
    <View style={ui.heroMark}>
      {wordmark === true ? <Wordmark size="lg" /> : null}
      {glyph === undefined ? null : (
        <View style={ui.heroBadge}>
          <Text style={ui.heroGlyph}>{glyph}</Text>
        </View>
      )}
      <Text style={ui.h1}>{title}</Text>
      {lead === undefined ? null : <Text style={ui.lead}>{lead}</Text>}
    </View>
  );
}

/**
 * `bullets`: the plain stacked sentences under "Three things to know" and
 * "Still fine". No marker glyph: the prototype's list items are bare text, and
 * a bullet character here would be an addition rather than a port.
 */
export function Bullets({ items }: { items: string[] }) {
  return (
    <View style={ui.bullets}>
      {items.map((item) => (
        <Text key={item} style={ui.bulletText}>
          {item}
        </Text>
      ))}
    </View>
  );
}

/**
 * The prototype's `switch` is an HTML checkbox. RN's `Switch` is the platform
 * control and is what ships; `SwitchFace` draws the prototype's track+knob for
 * a surface that has no `Switch` at all.
 *
 * `unavailable` is not decoration. The Permissions screen has a row for
 * something this build cannot grant or query on the running platform, and a
 * switch that can be flipped into a state nothing implements is a lie with a
 * control on it -- so that row is disabled and its subtitle says why.
 */
export type SwitchState = 'on' | 'off' | 'unavailable';

export function SwitchFace({ state }: { state: SwitchState }) {
  const on = state === 'on';
  const dead = state === 'unavailable';
  return (
    <View
      style={[ui.switchTrack, on ? ui.switchTrackOn : null, dead ? ui.switchDisabled : null]}
      // A drawn track is not a control, so it must not claim to be one: the
      // row below carries the label and the role.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[ui.switchKnob, on ? ui.switchKnobOn : null]} />
    </View>
  );
}

/**
 * One `switchrow`. Omitting `onPress` is what disables the row, so there is
 * no second "is it disabled" flag that could disagree with the control.
 */
export function SwitchRow({
  title,
  sub,
  state,
  onPress,
  testID,
}: {
  title: string;
  sub: string;
  state: SwitchState;
  onPress?: () => void;
  testID?: string;
}) {
  const body = (
    <View style={[ui.switchRow, state === 'on' ? ui.switchRowOn : null]}>
      <View style={ui.rowMain}>
        <Text style={ui.rowTitle}>{title}</Text>
        <Text style={ui.rowSub}>{sub}</Text>
      </View>
      <SwitchFace state={state} />
    </View>
  );
  if (onPress === undefined) {
    return (
      <View testID={testID} accessibilityLabel={title}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityState={{ checked: state === 'on' }}
      onPress={onPress}
      style={({ pressed }) => [pressed ? ui.pressed : null]}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

/** `card card-tight` of key/value rows: the update screen's version card. */
export function KvCard({ rows }: { rows: { k: string; v: string; nowrap?: boolean }[] }) {
  return (
    <View style={ui.cardTight}>
      {rows.map((row, i) => (
        <View key={row.k} style={[ui.kv, i === 0 ? ui.kvFirst : null]}>
          <Text style={ui.kvK}>{row.k}</Text>
          <Text style={[ui.kvV, row.nowrap === true ? ui.nowrap : null]}>{row.v}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The "If this keeps happening" disclosure. Native `Pressable`, native
 * `useState`, no library: it is a boolean and a View.
 *
 * The testIDs are split (`-toggle` on the trigger, the bare id on the body) so
 * a test can assert the BODY mounts, which is the only thing that proves the
 * disclosure works. The trigger stays in the tree while collapsed, so finding
 * the label alone is not a proof.
 */
export function Accordion({ label, testID, children }: {
  label: string;
  testID?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={ui.stackSm}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((was) => !was)}
        style={({ pressed }) => [pressed ? ui.pressed : null]}
        testID={testID === undefined ? undefined : `${testID}-toggle`}
      >
        <Text style={ui.btnLabel}>{label}</Text>
      </Pressable>
      {open ? (
        <View style={ui.cardTight} testID={testID}>
          {children}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The icon glyphs for the hero wells. There is no react-native-svg in this
 * package, so these are characters chosen to read as the same marks the
 * prototype's 24x24 line icons do.
 */
export const ONB_GLYPHS = {
  /** The struck-through wifi arcs of the cant-reach badge. */
  noConnection: '⌇',
  /** The two chasing arrows of the update badge. */
  update: '↻',
  /** The shield of the quarantine badge. */
  held: '⛉',
} as const;
