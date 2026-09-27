import React, { useState } from 'react';
import { View } from 'react-native';
import { useEngine } from '../EngineContext';
import { AttachmentPicker } from '../components/AttachmentPicker';
import { ComposerBar } from '../components/ComposerBar';

export function ComposerScreen({ initialText = '', initialFiles = [], peerDeviceId = '' }: {
  initialText?: string; initialFiles?: string[]; peerDeviceId?: string;
}) {
  const engine = useEngine();
  const [text, setText] = useState(initialText);
  const [files, setFiles] = useState<string[]>(initialFiles);
  const canSend = peerDeviceId !== '' && (text.trim() !== '' || files.length > 0);
  return (
    <View>
      <AttachmentPicker
        files={files}
        onPick={() => setFiles((f) => [...f, `/tmp/${Date.now()}.bin`])}
        onRemove={(p) => setFiles((f) => f.filter((x) => x !== p))}
      />
      <ComposerBar text={text} files={files} canSend={canSend} onChange={setText}
        onSend={() => engine.send({ peerDeviceId, text: text.trim() || undefined, files })} />
    </View>
  );
}
