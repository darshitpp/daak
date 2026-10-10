import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, type } from '../theme';

export interface ToastApi {
  show: (message: string) => void;
}

// The value outside a provider. A screen without a provider (most unit tests)
// calls show() and nothing happens.
const NO_TOAST: ToastApi = { show: () => {} };

const ToastContext = createContext<ToastApi>(NO_TOAST);

/** `show(message)` puts a toast on screen. It is a no-op outside a `ToastProvider`. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

/**
 * Renders the children and, above them, the current toast. One toast at a
 * time: a new `show` replaces the current one and restarts the timer. The
 * timer is cleared on unmount.
 */
export function ToastProvider({ children, durationMs = 2600, bottomOffset = 96 }: { children: React.ReactNode; durationMs?: number; bottomOffset?: number }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (next: string) => {
      if (timer.current !== null) clearTimeout(timer.current);
      setMessage(next);
      timer.current = setTimeout(() => {
        timer.current = null;
        setMessage(null);
      }, durationMs);
    },
    [durationMs],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      <View style={styles.root}>
        {children}
        {message !== null ? (
          <View testID="toast-wrap" pointerEvents="none" style={[styles.wrap, { bottom: bottomOffset }]}>
            <View testID="toast" accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.pill}>
              <Text style={styles.glyph} accessibilityElementsHidden importantForAccessibility="no">✓</Text>
              <Text testID="toast-text" style={styles.text}>{message}</Text>
            </View>
          </View>
        ) : null}
      </View>
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  // The root fills its parent, so the absolute wrapper below spans the whole window.
  root: { flex: 1 },
  // `bottom` comes from the `bottomOffset` prop (default 96, the phone design). The Mac design uses 24.
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 30, elevation: 8 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: '90%',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.fg,
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  glyph: { fontSize: type.sm, fontWeight: '700', color: colors.paper },
  text: { fontSize: type.sm, color: colors.paper, flexShrink: 1 },
});

