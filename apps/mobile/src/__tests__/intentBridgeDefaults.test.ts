import { readFileSync } from 'fs';
import { join } from 'path';

// R26 follow-up. Neither half of this pair can be exercised from JS, so this is
// a source pin in the accepted shareTargetManifest.test.ts style. It is not
// decorative: the writer used to `set(arr, forKey:)` a [[String:String]], which
// UserDefaults stores as a plist ARRAY, while the reader does data(forKey:) --
// nil for a plist array. Compiled and run on this machine, that pair makes
// devices() return [] unconditionally, so every Siri invocation sees zero
// devices. The Swift round-trip evidence is in the task-7 report.
const writer = readFileSync(
  join(__dirname, '../../../../modules/rn-share/ios/DaakShare.swift'),
  'utf8',
);
const reader = readFileSync(join(__dirname, '../../ios/Daak/DaakIntentBridge.swift'), 'utf8');

function updateShortcutTargets(): string {
  const start = writer.indexOf('func updateShortcutTargets');
  expect(start).toBeGreaterThan(-1);
  return writer.slice(start, writer.indexOf('private static func rootViewController'));
}

describe('App Group pairedDevices writer/reader pair', () => {
  it('writes DATA under the key, not a plist array', () => {
    const fn = updateShortcutTargets();
    // If the value is never turned into Data it cannot be read back as Data,
    // and every reader sees nil.
    expect(fn).toContain('JSONSerialization.data(withJSONObject: arr)');
    // And the thing set() receives must be that Data, never `arr` itself.
    expect(fn).toContain('.set(data, forKey: "pairedDevices")');
    expect(fn).not.toMatch(/set\(arr,/);
  });

  it('the reader asks for data(forKey:) and JSON-decodes it', () => {
    expect(reader).toContain('data(forKey: "pairedDevices")');
    expect(reader).toContain('JSONSerialization.jsonObject(with: data)');
    expect(reader).not.toMatch(/array\(forKey:/);
  });

  // A build that shipped the array form must not strand the reader forever:
  // the plist array is unreadable, so a stale one is worse than none. Nothing to
  // migrate (the writer replaces the value on every startEngine publish), but
  // the reader still has to fail soft rather than crash the intent.
  it('the reader fails soft to an empty list, never a crash', () => {
    expect(reader).toMatch(/else \{ return \[\] \}/);
  });
});
