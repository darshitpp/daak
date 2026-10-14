import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SaveLocationScreen } from './SaveLocationScreen';

const noop = () => {};

describe('SaveLocationScreen', () => {
  it('shows the words of the design', async () => {
    render(<SaveLocationScreen folder={{ load: async () => null, choose: async () => null }} onContinue={noop} />);
    expect(screen.getByText('Where to save files')).toBeTruthy();
    expect(
      screen.getByText('Pick the folder where files you receive are saved. You can change this later in Settings.'),
    ).toBeTruthy();
    expect(screen.getByText('Save files to')).toBeTruthy();
    expect(screen.getByText('Files from other devices land here.')).toBeTruthy();
    expect(screen.getByText('Only on this device')).toBeTruthy();
    expect(screen.getByText('Files are saved here, not in the cloud. Nothing is uploaded.')).toBeTruthy();
    expect(screen.getByText('One quick step left.')).toBeTruthy();
    expect(await screen.findByText('Change folder')).toBeTruthy();
  });

  // The picker variant uses the android.html and macos.html words only.
  it('does not show the iPhone words when the platform can choose a folder', async () => {
    render(<SaveLocationScreen folder={{ load: async () => null, choose: async () => null }} onContinue={noop} />);
    await screen.findByText('Change folder');
    expect(screen.queryByText('Daak · On My iPhone')).toBeNull();
    expect(screen.queryByText("iOS saves the files you receive for you. There's no folder to pick.")).toBeNull();
  });

  it('does not show the second note of the folder row', async () => {
    render(<SaveLocationScreen folder={{ load: async () => null, choose: async () => null }} onContinue={noop} />);
    await screen.findByText('Change folder');
    expect(screen.queryByText('Files are moved, not copied')).toBeNull();
  });

  it('shows the chosen folder name after a choice', async () => {
    render(<SaveLocationScreen folder={{ load: async () => null, choose: async () => 'Documents / Daak' }} onContinue={noop} />);
    fireEvent.press(await screen.findByTestId('download-folder-choose'));
    expect(await screen.findByText('Documents / Daak')).toBeTruthy();
  });

  // Continue needs no choice. The default folder is valid.
  it('continues with no choice made', () => {
    const next = jest.fn();
    render(<SaveLocationScreen folder={{ load: async () => null, choose: async () => null }} onContinue={next} />);
    fireEvent.press(screen.getByTestId('save-location-continue'));
    expect(next).toHaveBeenCalledTimes(1);
  });

  describe('with a photos host', () => {
    const photos = (request: () => Promise<boolean>) => ({
      destination: 'Photos',
      status: async () => 'undetermined' as const,
      request,
      openSettings: () => {},
    });
    const folder = { load: async () => null, choose: async () => null };

    it('asks for access once, then continues', async () => {
      const next = jest.fn();
      const request = jest.fn(async () => true);
      render(<SaveLocationScreen folder={folder} photos={photos(request)} onContinue={next} />);
      expect(screen.getByText('Photos and videos go to Photos. Other files go to this folder.')).toBeTruthy();
      fireEvent.press(screen.getByTestId('save-location-continue'));
      await waitFor(() => expect(next).toHaveBeenCalledTimes(1));
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('continues when the answer is no', async () => {
      const next = jest.fn();
      render(<SaveLocationScreen folder={folder} photos={photos(async () => false)} onContinue={next} />);
      fireEvent.press(screen.getByTestId('save-location-continue'));
      await waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    });

    it('continues when the request fails', async () => {
      const next = jest.fn();
      render(<SaveLocationScreen folder={folder} photos={photos(async () => { throw new Error('x'); })} onContinue={next} />);
      fireEvent.press(screen.getByTestId('save-location-continue'));
      await waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    });

    it('shows no photos line and continues at once without a host', () => {
      const next = jest.fn();
      render(<SaveLocationScreen folder={folder} onContinue={next} />);
      expect(screen.queryByText(/Photos and videos go to/)).toBeNull();
      fireEvent.press(screen.getByTestId('save-location-continue'));
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  // Review Focus 2. A host that gives no `choose` gets the fallback. It is not
  // the iOS path: both mobile hosts pass `choose`. The fallback shows the
  // iPhone words (label and value match P3 Task 8's DownloadFolderRow
  // fallback), no "Change folder", and a Continue button that works.
  it('has a variant for a platform with no folder picker', async () => {
    const next = jest.fn();
    render(<SaveLocationScreen folder={{ load: async () => null }} onContinue={next} />);
    // The words of the iPhone design (index.html, sc save-location).
    expect(screen.getByText("iOS saves the files you receive for you. There's no folder to pick.")).toBeTruthy();
    expect(screen.getByText('Saved to')).toBeTruthy();
    expect(screen.getByText('Daak · On My iPhone')).toBeTruthy();
    expect(screen.getByText('Only on this device')).toBeTruthy();
    expect(screen.getByText("Files are saved in Daak's folder, not in the cloud. Nothing is uploaded.")).toBeTruthy();
    expect(screen.getByText('One quick step left.')).toBeTruthy();
    expect(screen.queryByText('Change folder')).toBeNull();
    expect(screen.queryByTestId('download-folder-choose')).toBeNull();
    expect(screen.queryByText('Pick the folder where files you receive are saved. You can change this later in Settings.')).toBeNull();
    expect(screen.queryByText('Files you receive are saved on this device.')).toBeNull();
    fireEvent.press(screen.getByTestId('save-location-continue'));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('lets the host replace or remove the footer sentence', () => {
    const { rerender } = render(
      <SaveLocationScreen folder={{ load: async () => null }} onContinue={noop} footer={null} />,
    );
    expect(screen.queryByText('One quick step left.')).toBeNull();
    rerender(<SaveLocationScreen folder={{ load: async () => null }} onContinue={noop} footer="Almost done." />);
    expect(screen.getByText('Almost done.')).toBeTruthy();
  });

  it('goes back', () => {
    const back = jest.fn();
    render(<SaveLocationScreen folder={{ load: async () => null }} onContinue={noop} onBack={back} />);
    fireEvent.press(screen.getByTestId('onb-back'));
    expect(back).toHaveBeenCalledTimes(1);
  });
});

