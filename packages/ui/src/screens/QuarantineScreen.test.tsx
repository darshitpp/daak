import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { DaakEngine } from '@daak/core';
import { EngineProvider } from '../EngineContext';
import { ToastProvider } from '../components/Toast';
import { fakeEngine } from '../testing/fakeEngine';
import { QuarantineScreen } from './QuarantineScreen';
import { colors } from '../theme';

const TID = 'cc'.repeat(16);

function mount(engine: DaakEngine, props: Partial<React.ComponentProps<typeof QuarantineScreen>> = {}) {
  return render(
    <EngineProvider engine={engine}>
      <ToastProvider>
        <QuarantineScreen transferId={TID} itemIndex={0} {...props} />
      </ToastProvider>
    </EngineProvider>,
  );
}

describe('QuarantineScreen, the words of the design', () => {
  it('shows the title, the lead, the facts, and the note', async () => {
    mount(fakeEngine());
    expect(screen.getByText('Held back')).toBeTruthy();
    expect(screen.getByText("This file didn't pass its check")).toBeTruthy();
    expect(await screen.findByText('harbor-lighthouse.jpg')).toBeTruthy();
    expect(screen.getByText('4.2 MB')).toBeTruthy();
    expect(screen.getByText('Kitchen Tablet')).toBeTruthy();
    expect(screen.getByText('Fingerprint it should have')).toBeTruthy();
    expect(screen.getByText('Fingerprint it has')).toBeTruthy();
    expect(screen.getByText('7f3a 91c2 04be')).toBeTruthy();
    expect(screen.getByText('7f3a 91c2 04c9')).toBeTruthy();
    expect(screen.getByText('Nothing was changed')).toBeTruthy();
  });

  // Ruling D1.
  it('never offers "Ask the sender again"', async () => {
    mount(fakeEngine());
    await screen.findByText('harbor-lighthouse.jpg');
    expect(screen.queryByText('Ask the sender again')).toBeNull();
  });

  it('says "Back to conversation" on the back control', async () => {
    const back = jest.fn();
    mount(fakeEngine(), { onBack: back });
    await screen.findByText('harbor-lighthouse.jpg');
    expect(screen.getByLabelText('Back to conversation')).toBeTruthy();
    expect(screen.queryByLabelText('Back to Inbox')).toBeNull();
    fireEvent.press(screen.getByTestId('onb-back'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('expands "What does this mean?"', async () => {
    mount(fakeEngine());
    await screen.findByText('harbor-lighthouse.jpg');
    expect(screen.queryByTestId('quarantine-why-body')).toBeNull();
    fireEvent.press(screen.getByTestId('quarantine-why'));
    expect(screen.getByTestId('quarantine-why-body')).toBeTruthy();
    expect(screen.getByText(/A fingerprint is a short code Daak works out from a file/)).toBeTruthy();
  });
});

describe('QuarantineScreen, Delete it', () => {
  it('opens a sheet that names the device noun, and Keep it closes it without deleting', async () => {
    const engine = fakeEngine();
    const del = jest.spyOn(engine, 'deleteQuarantined');
    mount(engine, { deviceNoun: 'Mac' });
    await screen.findByText('harbor-lighthouse.jpg');
    fireEvent.press(screen.getByTestId('quarantine-delete'));
    expect(screen.getByText('Delete this file?')).toBeTruthy();
    expect(screen.getByText('It was never opened. Deleting it only clears the holding area on this Mac.')).toBeTruthy();
    fireEvent.press(screen.getByTestId('quarantine-delete-cancel'));
    await waitFor(() => expect(screen.queryByText('Delete this file?')).toBeNull());
    expect(del).not.toHaveBeenCalled();
  });

  it('deletes after the confirm, then shows the Deleted state and calls onDeleted', async () => {
    const engine = fakeEngine();
    const del = jest.spyOn(engine, 'deleteQuarantined');
    const deleted = jest.fn();
    const back = jest.fn();
    mount(engine, { deviceNoun: 'phone', onDeleted: deleted, onBack: back });
    await screen.findByText('harbor-lighthouse.jpg');
    fireEvent.press(screen.getByTestId('quarantine-delete'));
    fireEvent.press(screen.getByTestId('quarantine-delete-confirm'));
    expect(await screen.findByText('Deleted')).toBeTruthy();
    expect(screen.getByText('The held-back file is gone. Nothing else on this phone changed.')).toBeTruthy();
    expect(del).toHaveBeenCalledWith(TID, 0);
    expect(deleted).toHaveBeenCalledTimes(1);
    // The design toasts "File deleted" and returns to the conversation. The
    // Deleted pane keeps no button of its own.
    expect(await screen.findByText('File deleted')).toBeTruthy();
    expect(back).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('quarantine-gone-back')).toBeNull();
    expect(screen.queryByText('Back to conversation')).toBeNull();
  });

  // Design: "Delete it" on the screen is a primary button. Only the sheet
  // confirm is danger.
  it('draws the screen Delete it as a primary button and the sheet one as danger', async () => {
    mount(fakeEngine());
    await screen.findByText('harbor-lighthouse.jpg');
    const screenBtn = StyleSheet.flatten(screen.getByTestId('quarantine-delete').props.style);
    expect(screenBtn.backgroundColor).toBe(colors.fg);
    fireEvent.press(screen.getByTestId('quarantine-delete'));
    const sheetBtn = StyleSheet.flatten(screen.getByTestId('quarantine-delete-confirm').props.style);
    expect(sheetBtn.borderColor).toBe(colors.err);
  });

  it('says "device" when the host gives no noun', async () => {
    mount(fakeEngine());
    await screen.findByText('harbor-lighthouse.jpg');
    fireEvent.press(screen.getByTestId('quarantine-delete'));
    fireEvent.press(screen.getByTestId('quarantine-delete-confirm'));
    expect(await screen.findByText('The held-back file is gone. Nothing else on this device changed.')).toBeTruthy();
  });

  it('closes the sheet and shows the engine message when the delete fails', async () => {
    const engine = fakeEngine();
    jest.spyOn(engine, 'deleteQuarantined').mockRejectedValue(new Error('the file is locked'));
    mount(engine);
    await screen.findByText('harbor-lighthouse.jpg');
    fireEvent.press(screen.getByTestId('quarantine-delete'));
    fireEvent.press(screen.getByTestId('quarantine-delete-confirm'));
    expect(await screen.findByText('the file is locked')).toBeTruthy();
    expect(screen.queryByText('Delete this file?')).toBeNull();
    expect(screen.queryByText('Deleted')).toBeNull();
  });
});
