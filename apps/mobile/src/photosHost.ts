import { Linking, Platform } from 'react-native';
import { photosAccessStatus, requestPhotosAccess } from '@daak/platform';
import type { PhotosHost } from '@daak/ui';

// A module-level constant, so the Settings row does not read the status again on every render.
export const photosHost: PhotosHost = {
  destination: Platform.OS === 'ios' ? 'Photos app' : 'Gallery',
  status: photosAccessStatus,
  request: requestPhotosAccess,
  openSettings: () => void Linking.openSettings(),
};

// A returning user skips onboarding, because its flag survives a reinstall. The OS
// permission does not survive. This asks once when the OS has not been asked.
// It runs at startup. It must not throw, so it swallows each error.
export async function askForPhotosIfUndetermined(
  host: Pick<PhotosHost, 'status' | 'request'> = photosHost,
): Promise<void> {
  try {
    if ((await host.status()) === 'undetermined') await host.request();
  } catch {
    // The user can still choose the permission in Settings.
  }
}
