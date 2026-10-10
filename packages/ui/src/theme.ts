import { StyleSheet } from 'react-native';

/**
 * The Open Design tokens, verbatim (Lovable system, bound in
 * app/src/styles/home.css), plus the handful of style objects every screen
 * reuses. The web conversion keeps these as CSS custom properties; React
 * Native has no variables, so they live here once instead of being restated
 * per screen.
 */
export const colors = {
  bg: '#f7f4ed',
  surface: '#f7f4ed',
  fg: '#1c1c1c',
  fg2: 'rgba(28, 28, 28, 0.83)',
  muted: '#5f5f5d',
  meta: 'rgba(28, 28, 28, 0.4)',
  border: '#eceae4',
  accent: '#ff4d8d',
  onAccent: '#ffffff',
  ok: '#16a34a',
  warn: '#eab308',
  // The amber measures 1.75:1 on cream, so an icon in it would be invisible.
  // Status is always carried by the word beside the dot, never by colour alone.
  warnInk: '#8f6202',
  err: '#dc2626',
  hover: 'rgba(28, 28, 28, 0.04)',
  okTint: 'rgba(22, 163, 74, 0.10)',
  warnTint: 'rgba(234, 179, 8, 0.14)',
  errTint: 'rgba(220, 38, 38, 0.09)',
  paper: '#fcfbf8',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 };

export const radius = { sm: 6, md: 12, lg: 16, pill: 9999 };

export const type = { xs: 12, sm: 14, body: 16, lg: 18, xl: 20, display: 36 };

/** DESIGN.md §5: nothing tappable is smaller than this, anywhere. */
export const control = { minHeight: 44, sidebarWidth: 248 };

/**
 * Shared pieces, not a component library: one object per repeated shape
 * (card, row, button, note) instead of eleven wrappers that each wrap one
 * View. No new abstraction, just the design system in a form RN can use.
 */
export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  /** Scroll CONTENT padding. Never a View style -- contentContainerStyle only. */
  pad: { padding: spacing.lg, gap: spacing.xxl },
  appbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  appbarTitle: { flex: 1, fontSize: type.xl, fontWeight: '600', color: colors.fg },

  stack: { gap: spacing.md },
  stackSm: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  fill: { flex: 1, minWidth: 0 },

  h1: { fontSize: type.display, fontWeight: '600', lineHeight: 42, letterSpacing: -0.9, color: colors.fg },
  h2: { fontSize: type.xl, fontWeight: '600', lineHeight: 24, color: colors.fg },
  h3: { fontSize: type.body, fontWeight: '600', lineHeight: 21, color: colors.fg },
  lead: { fontSize: type.body, lineHeight: 24, color: colors.fg2 },
  muted: { fontSize: type.sm, lineHeight: 19, color: colors.muted },
  hint: { fontSize: type.sm, lineHeight: 19, color: colors.muted },
  eyebrow: { fontSize: type.xs, color: colors.muted, letterSpacing: 0.8, textTransform: 'uppercase' },
  sectionT: { fontSize: type.sm, color: colors.muted },
  verify: { fontSize: 36, lineHeight: 42, fontWeight: '600', letterSpacing: 2, color: colors.fg },

  card: {
    padding: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  cardTight: { padding: spacing.md, gap: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  list: { flexDirection: 'column' },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rowTitle: { fontSize: type.body, lineHeight: 21, color: colors.fg },
  rowSub: { fontSize: type.sm, lineHeight: 19, color: colors.muted },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatarLetter: { fontSize: type.body, fontWeight: '600', color: colors.fg2 },

  btn: {
    minHeight: control.minHeight,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  btnPrimary: { backgroundColor: colors.fg },
  btnQuiet: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.meta },
  btnDanger: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.err },
  btnOnDark: { fontSize: type.body, fontWeight: '600', color: colors.paper },
  btnLabel: { fontSize: type.body, color: colors.fg },
  btnLabelSm: { fontSize: type.sm, color: colors.fg },
  btnDisabled: { opacity: 0.45 },

  chip: {
    minHeight: control.minHeight,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  chipOn: { borderColor: colors.fg },
  chipLabel: { fontSize: type.sm, color: colors.fg },
  chipLabelOn: { fontSize: type.sm, fontWeight: '600', color: colors.fg },

  input: {
    minHeight: control.minHeight,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    color: colors.fg,
    fontSize: type.body,
  },
  label: { fontSize: type.sm, color: colors.fg },

  dot: { width: 8, height: 8, borderRadius: 4 },
  statusTxt: { fontSize: type.sm, lineHeight: 19, color: colors.fg2 },

  barTrack: { height: 8, borderRadius: radius.pill, backgroundColor: colors.border, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.fg },
  progN: { fontSize: type.sm, color: colors.muted },

  note: { flexDirection: 'row', gap: spacing.md, padding: spacing.md, borderRadius: radius.sm, backgroundColor: colors.hover },
  noteOk: { backgroundColor: colors.okTint },
  noteWarn: { backgroundColor: colors.warnTint },
  noteErr: { backgroundColor: colors.errTint },
  noteTtl: { fontSize: type.sm, fontWeight: '600', lineHeight: 19, color: colors.fg },
  noteTxt: { fontSize: type.sm, lineHeight: 19, color: colors.fg2 },

  empty: { gap: spacing.sm, padding: spacing.xxl, paddingHorizontal: spacing.lg, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.meta, borderRadius: radius.md },

  kv: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  kvFirst: { borderTopWidth: 0 },
  kvK: { fontSize: type.sm, color: colors.muted },
  kvV: { fontSize: type.sm, color: colors.fg, textAlign: 'right' },

  seg: { flexDirection: 'row', gap: spacing.xs, padding: spacing.xs, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill },
  segItem: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: spacing.sm, borderRadius: radius.pill },
  segItemOn: { backgroundColor: colors.fg },

  // Navigation. The bottom bar is the phone; the 248px rail is the desktop.
  tabbar: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  tab: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderRadius: radius.md,
  },
  tabOn: { backgroundColor: colors.hover },
  tabGlyph: { fontSize: type.body, lineHeight: 20, color: colors.muted },
  tabGlyphOn: { color: colors.fg },
  tabLabel: { fontSize: type.xs, lineHeight: 14, color: colors.muted },
  tabLabelOn: { color: colors.fg, fontWeight: '600' },

  desk: { flexDirection: 'row', flex: 1 },
  sidebar: {
    width: control.sidebarWidth,
    gap: spacing.xl,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.md,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  sidenav: { gap: 2 },
  sideitem: {
    minHeight: control.minHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
  },
  sideitemOn: { backgroundColor: colors.hover },
  sideLabel: { fontSize: type.body, color: colors.fg2 },
  sideLabelOn: { color: colors.fg, fontWeight: '600' },
  sidefoot: { marginTop: 'auto', paddingHorizontal: spacing.md, fontSize: type.xs, color: colors.muted },

  // The device picker rail. The desktop prototype's chips are 176x72 cards;
  // the phone prototype's are the same idea as pills. One shape, one style.
  rail: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  devchip: {
    minWidth: 176,
    minHeight: 72,
    gap: spacing.xs,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  devchipOn: { borderColor: colors.fg, backgroundColor: colors.paper },
  devchipT: { fontSize: type.body, fontWeight: '600', lineHeight: 21, color: colors.fg },
  devchipS: { fontSize: type.xs, lineHeight: 16, color: colors.muted },

  wordmark: { flexDirection: 'row', alignItems: 'baseline' },

  search: { minHeight: control.minHeight, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface, color: colors.fg, fontSize: type.body },
  btnBlock: { alignSelf: 'stretch' },
  pressed: { opacity: 0.8 },
  noteDot: { marginTop: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },

  // ── Onboarding + error screens ──────────────────────────────────────────
  // The prototype's `onb` column: one centred stack, hero at the top, actions
  // pinned at the bottom. Every onboarding screen shares it, so it is one
  // style rather than five near-identical layouts.
  onb: { flexGrow: 1, gap: spacing.xl, justifyContent: 'center', paddingVertical: spacing.xxl },
  heroMark: { gap: spacing.lg, alignItems: 'flex-start' },
  /** The big circular icon well above the onboarding headline. */
  heroBadge: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  heroGlyph: { fontSize: 30, lineHeight: 36, color: colors.fg2 },
  bullets: { gap: spacing.sm },
  bullet: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  bulletMark: { width: 20, fontSize: type.sm, lineHeight: 19, color: colors.fg2 },
  /** `err-msg`: the inline validation under a field. */
  errMsg: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  errMark: { fontSize: type.sm, lineHeight: 19, color: colors.err },
  errTxt: { flex: 1, fontSize: type.sm, lineHeight: 19, color: colors.err },
  /** `choice-list`: the two full-width pairing choices, primary then quiet. */
  choiceList: { gap: spacing.md },
  /** The Permissions screen's switch rows. `on` tints the row. */
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  switchRowFirst: { borderTopWidth: 0 },
  switchRowOn: { backgroundColor: colors.hover, borderRadius: radius.sm },
  /** A real iOS/Android switch face; RN's `Switch` is the platform control. */
  switchTrack: { width: 48, height: 28, borderRadius: radius.pill, backgroundColor: colors.border, padding: 3, justifyContent: 'center' },
  switchTrackOn: { backgroundColor: colors.fg },
  switchKnob: { width: 22, height: 22, borderRadius: radius.pill, backgroundColor: colors.surface },
  switchKnobOn: { alignSelf: 'flex-end' },
  /** `prog-meta` + track, for the update progress row. */
  progMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  /** `nowrap` on a `kv-v`: a version string must not wrap mid-number. */
  nowrap: { flexShrink: 0 },
  /**
   * The prototype's `.mono`: a fingerprint or a hash on a `kv-v`. React Native
   * has no font-family token for a bundled monospace face in this pass, so the
   * platform default for the code is the honest choice -- a wrapper is still
   * needed so `mono` has exactly one definition when a face is added.
   */
  mono: { fontVariant: ['tabular-nums'] },
  /** The prototype's `iconbtn`: the appbar's back chevron. Square, 44px. */
  iconbtn: {
    width: control.minHeight,
    height: control.minHeight,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  /** `onb-actions`: the buttons pinned to the bottom of an onboarding screen. */
  onbActions: { gap: spacing.sm },
  /**
   * `screen-fit` is a flex COLUMN (display:flex, flex-direction:column,
   * flex:1 1 auto) so the appbar sits above the scroll area and the actions
   * can be pushed to the bottom by the content. It is not a style in CSS -- it
   * only exists to override `.screen`, which is a grid -- so the one property
   * that matters here is the column: `ui.appbar` is a row and the ScrollView
   * must be the flex child that grows.
   */
  onbScreen: { flexDirection: 'column' },
  /**
   * The scroll area of an onboarding screen. It is a flex child that grows,
   * so it takes the height left by the appbar and the pinned action bar. With
   * `flexGrow: 1` it never collapses, and the action bar stays inside the
   * window at any content height.
   */
  onbScroll: { flexGrow: 1 },
  /**
   * `onb-actions { margin-top:auto }` in CSS, as a bottom bar OUTSIDE the
   * scroll view (see OnboardingScreen).
   *
   * React Native has no `auto` margin. This block must NOT use `flexGrow`:
   * inside the scroll content, a growing pinned block is what pushed the
   * action buttons below the visible area, so their presses never reached the
   * button. Outside the scroll view it is the last flex child of the column,
   * so it takes only its natural height. `justifyContent: 'flex-end'` keeps
   * the buttons at the top of the bar rather than stretched, and the padding
   * separates the bar from the scrolling content.
   */
  onbActionsPinned: { justifyContent: 'flex-end', paddingVertical: spacing.lg, paddingHorizontal: spacing.lg },
  /** The appbar back chevron, as a character: this package has no SVG. */
  appbarGlyph: { fontSize: 28, lineHeight: 30, fontWeight: '400' },
  /**
   * The prototype centres the appbar title with `text-align:center` on the
   * flex-1 filler (`od-fill`). React Native centres with `textAlign`, and only
   * when the title itself takes the slack -- which is why it is a modifier on
   * the title rather than a second filler view.
   */
  appbarTitleCentred: { textAlign: 'center' },
  /** A `bullets li`: the list is bare text in the prototype, with padding only. */
  bulletText: { fontSize: type.sm, lineHeight: 20, color: colors.fg2 },
  /**
   * A switch row for something this build cannot grant. Visibly inert: the
   * track goes to the muted token so it cannot read as an enabled control, and
   * it is paired with a subtitle that says why (see SwitchRow).
   */
  switchDisabled: { backgroundColor: colors.border, borderColor: colors.border, opacity: 0.6 },
  /** `mt-sm`: a small gap between two stacked blocks, in one place. */
  mtSm: { marginTop: spacing.sm },
  /** `row-main`: the stacked title+sub column every switch/choice row uses. */
  rowMain: { flex: 1, minWidth: 0, gap: 2 },

  // Sheet and scrim.
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(28, 28, 28, 0.4)' },
  sheet: {
    gap: spacing.lg,
    padding: spacing.xl,
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },

  // Thread bubbles.
  msg: { gap: spacing.xs, maxWidth: '88%' },
  msgIn: { alignSelf: 'flex-start' },
  msgOut: { alignSelf: 'flex-end' },
  msgLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  bubble: {
    gap: spacing.xs,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.paper,
  },
  bubbleOut: { backgroundColor: colors.hover },
  // Failed and held bubbles (design: `.bubble-fail`, `.bubble-held`).
  bubbleWarn: { backgroundColor: colors.warnTint, borderColor: colors.warn },
  bubbleState: { fontSize: type.xs, lineHeight: 16, color: colors.warnInk },
  bubbleTxt: { fontSize: type.body, lineHeight: 22, color: colors.fg },
  msgWhen: { fontSize: type.xs, lineHeight: 16, color: colors.muted },
  msgActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  quick: {
    minHeight: control.minHeight,
    minWidth: control.minHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  quickTxt: { fontSize: type.sm, color: colors.fg2 },

  // Thread composer and the active transfer card.
  composer: {
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  threadList: { padding: spacing.lg, gap: spacing.md },

});
