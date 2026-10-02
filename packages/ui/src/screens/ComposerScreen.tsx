import React, { useState } from 'react';
import { View } from 'react-native';
import { useEngine } from '../EngineContext';
import { AttachmentPicker } from '../components/AttachmentPicker';
import { ComposerBar } from '../components/ComposerBar';
import { ui } from '../theme';

/**
 * The bare composer, still used by the mobile SendFlow and by a host that
 * wants the composer WITHOUT the device rail around it. The primary Send tab
 * (SendScreen) is the full surface; this is the same inputs plus the picker.
 *
 * `onPickFiles` is INJECTED, never imported -- packages/ui takes no dependency
 * on @daak/platform or any TurboModule.
 */
export function ComposerScreen({ initialText = '', initialFiles = [], peerDeviceId = '', onPickFiles }: {
  initialText?: string; initialFiles?: string[]; peerDeviceId?: string;
  onPickFiles?: () => Promise<string[]>;
}) {
  const engine = useEngine();
  const [text, setText] = useState(initialText);
  const [files, setFiles] = useState<string[]>(initialFiles);
  const canSend = peerDeviceId !== '' && (text.trim() !== '' || files.length > 0);
  return (
    <View style={ui.stack}>
      <AttachmentPicker
        files={files}
        onPick={() => {
          if (!onPickFiles) return;
          // Swallowed: both native pickers resolve with an empty list on Cancel,
          // and a rejection means the picker broke -- leaving the composer
          // usable is strictly better than a crash over the send button.
          void onPickFiles()
            .then((picked) => setFiles((f) => [...f, ...picked]))
            .catch(() => {});
        }}
        onRemove={(p) => setFiles((f) => f.filter((x) => x !== p))}
      />
      <ComposerBar text={text} files={files} canSend={canSend} onChange={setText}
        onSend={() => void engine.send({ peerDeviceId, text: text.trim() || undefined, files })} />
    </View>
  );
}
