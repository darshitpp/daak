import React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { ui } from '../theme';

/**
 * A bottom sheet over a scrim. The design uses it for Remove, Stop sending,
 * Preview, and Share. The caller owns `open`. The scrim and the close button
 * both call `onClose`.
 */
export function Sheet({ open, title, onClose, children, actions }: {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
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
    </Modal>
  );
}

