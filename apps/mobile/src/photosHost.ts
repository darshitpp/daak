import { Linking, Platform } from 'react-native';
import { photosAccessStatus, requestPhotosAccess } from '@daak/platform';
import type { PhotosHost } from '@daak/ui';

// A module-level constant, so the Settings row does not read the status again on every render.
export const photosHost: PhotosHost = {
  destination: Platform.OS === 'ios' ? 'Photos' : 'Gallery',
  status: photosAccessStatus,
  request: requestPhotosAccess,
  openSettings: () => void Linking.openSettings(),
};
