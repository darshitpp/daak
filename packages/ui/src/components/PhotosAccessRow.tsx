import React, { useEffect, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { Btn, Note, Section } from './ds';
import { ui } from '../theme';

export interface PhotosHost {
  /** Where media goes, for the copy: 'Photos' on iOS, 'Gallery' on Android. */
  destination: string;
  status: () => Promise<'granted' | 'denied' | 'undetermined' | 'unavailable'>;
  request: () => Promise<boolean>;
  /** Opens the system settings page for this app. */
  openSettings: () => void;
}

/**
 * The Photos access state in Settings. It shows only when the user can act:
 * `undetermined` offers a prompt, `denied` points to the system settings.
 * `granted` and `unavailable` show nothing. The host supplies the verbs,
 * because packages/ui reaches no TurboModule.
 */
export function PhotosAccessRow({ photos }: { photos: PhotosHost }) {
  const [state, setState] = useState<Awaited<ReturnType<PhotosHost['status']>>>('unavailable');

  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void photos.status().then(
      (s) => {
        if (!cancelled) setState(s);
      },
      () => {
        if (!cancelled) setState('unavailable');
      },
    );
    // The user may change the permission in the system settings and come back.
    // A failed read keeps the old state.
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      void photos.status().then(
        (s) => {
          if (!cancelled) setState(s);
        },
        () => {},
      );
    });
    return () => {
      cancelled = true;
      sub?.remove(); // The Jest preset mock returns no subscription.
    };
  }, [photos]);

  if (state === 'granted' || state === 'unavailable') return null;
  return (
    <Section title={`Save to the ${photos.destination}`}>
      <View testID="photos-access-row">
        {state === 'denied' ? (
          <>
            <Note
              tone="warn"
              title="Photos access is off"
              body="Photos and videos stay in the save folder until you allow access."
            />
            <Btn variant="quiet" block label="Open Settings" testID="photos-access-settings" onPress={photos.openSettings} />
          </>
        ) : (
          <>
            <View style={ui.card}>
              <Text style={ui.kvK}>{`Allow Daak to add photos and videos to the ${photos.destination}.`}</Text>
            </View>
            <Btn
              variant="quiet"
              block
              label="Allow"
              testID="photos-access-allow"
              onPress={() => {
                void photos
                  .request()
                  .then(() => (mounted.current ? photos.status() : undefined))
                  .then((s) => { if (s && mounted.current) setState(s); }, () => {});
              }}
            />
          </>
        )}
      </View>
    </Section>
  );
}
