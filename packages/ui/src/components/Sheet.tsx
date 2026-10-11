import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { ui } from '../theme';

/**
 * A bottom sheet over a scrim. The design uses it for Remove, Stop sending,
 * Preview, and Share. The caller owns `open`. The scrim and the close button
 * both call `onClose`.
 *
 * The sheet does NOT use the react-native `Modal`. react-native-macos 0.83
 * compiles the whole Fabric Modal host view out (`#if !TARGET_OS_OSX`), and a
 * Modal on the Mac crashed the app when a pairing was removed. Instead a
 * `SheetProvider` near the root draws the open sheet over the whole window.
 * Without a provider (a test, or a host that has none) the sheet draws in
 * place.
 */
type Slot = { id: symbol; node: React.ReactNode } | null;
type Host = { show: (id: symbol, node: React.ReactNode) => void; hide: (id: symbol) => void };

const SheetHost = createContext<Host | null>(null);

/** Draws the one open sheet above everything inside it. Mount it once, near the root. */
export function SheetProvider({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<Slot>(null);
  // Stable, so a sheet that reads the context never re-renders for a slot change.
  const host = useMemo<Host>(
    () => ({
      show: (id, node) => setSlot({ id, node }),
      hide: (id) => setSlot((s) => (s !== null && s.id === id ? null : s)),
    }),
    [],
  );
  return (
    <SheetHost.Provider value={host}>
      <View style={styles.root}>
        {children}
        {slot !== null ? <View style={StyleSheet.absoluteFill}>{slot.node}</View> : null}
      </View>
    </SheetHost.Provider>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });

export function Sheet({ open, title, onClose, children, actions }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const host = useContext(SheetHost);
  const id = useRef(Symbol('sheet')).current;

  // The Android back button closes the sheet, as the Modal's onRequestClose did.
  // On the other platforms this registers a handler that never fires.
  useEffect(() => {
    if (!open) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  const body = (
    <View style={ui.scrim}>
      <Pressable
        testID="sheet-scrim"
        accessibilityLabel="Close sheet"
        style={{ flex: 1 }}
        onPress={onClose}
      />
      <View style={ui.sheet} accessibilityViewIsModal>
        <View style={ui.sheetHead}>
          <Text style={[ui.h2, ui.fill]} accessibilityRole="header">{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={ui.iconbtn}>
            <Text style={ui.appbarGlyph}>×</Text>
          </Pressable>
        </View>
        {children}
        {actions ? <View style={ui.stackSm}>{actions}</View> : null}
      </View>
    </View>
  );

  // Every render hands the host the current body, so a sheet that stays open
  // shows a changed body. Closing, or unmounting the page, takes it away.
  useEffect(() => {
    if (host === null) return undefined;
    if (open) host.show(id, body);
    else host.hide(id);
    return () => host.hide(id);
  });

  if (!open || host !== null) return null;
  return <View style={StyleSheet.absoluteFill}>{body}</View>;
}
