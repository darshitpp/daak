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
  wmD: { fontSize: 30, lineHeight: 30, fontWeight: '700', color: colors.fg },
  wmT: { fontSize: 20, lineHeight: 22, fontWeight: '600', color: colors.fg },

  search: { minHeight: control.minHeight, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface, color: colors.fg, fontSize: type.body },
  btnBlock: { alignSelf: 'stretch' },
  pressed: { opacity: 0.8 },
  noteDot: { marginTop: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
