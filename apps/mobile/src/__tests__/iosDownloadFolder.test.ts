import { readFileSync } from 'fs';
import { join } from 'path';

// Field test 2026-10-11: on the iPhone the download folder picker worked, but a
// received file always stayed in the app's own folder.
//
// Three faults in modules/rn-fspaths/ios/DaakFsPaths.swift fit that symptom:
//   1. The bookmark was made while the picked folder's security scope was
//      closed. A bookmark made that way may not carry the access, so every
//      later move out of the sandbox is refused.
//   2. The move was one plain moveItem. A folder served by a File Provider
//      (iCloud Drive and similar) can refuse it.
//   3. Any error fell back to the old path with no log at all, so the failure
//      looked like "the feature does nothing".
//
// Source-level pin, the same discipline as iosOpenUrlDelegate.test.ts: there is
// no iOS unit-test target, and the behavior shows only on a real device.
const swift = readFileSync(join(__dirname, '../../../../modules/rn-fspaths/ios/DaakFsPaths.swift'), 'utf8');

// Comments are stripped first, so an assertion is about the code and not the prose.
const code = swift
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n');

const body = (name: string): string => {
  const at = code.indexOf(name);
  expect(at).toBeGreaterThan(-1);
  // To the next top-level member: enough for these assertions.
  const rest = code.slice(at);
  const next = rest.slice(1).search(/\n  (@objc )?(private )?(static )?func |\n}\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe('iOS download folder', () => {
  it('opens the picked folder scope BEFORE it makes the bookmark', () => {
    const pick = body('func documentPicker(_ controller: UIDocumentPickerViewController,\n                      didPickDocumentsAt');
    const open = pick.indexOf('startAccessingSecurityScopedResource()');
    const mark = pick.indexOf('bookmarkData(');
    expect(open).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(-1);
    expect(open).toBeLessThan(mark);
    expect(pick).toMatch(/stopAccessingSecurityScopedResource\(\)/);
  });

  it('falls back to a coordinated copy when a plain move is refused', () => {
    expect(code).toMatch(/NSFileCoordinator/);
    expect(code).toMatch(/copyItem\(at:/);
    // The plain move is still the first try.
    expect(code.indexOf('moveItem(at:')).toBeLessThan(code.indexOf('NSFileCoordinator'));
  });

  // Field test 2026-10-11: the file preview had no way back. It is presented
  // over the app's root view controller, so it gets an explicit Done button in a
  // navigation bar instead of relying on QuickLook to add one.
  it('wraps the file preview in a navigation controller with a Done button', () => {
    const open = body('func openFile');
    expect(open).toMatch(/UINavigationController\(rootViewController: preview\)/);
    expect(open).toMatch(/UIBarButtonItem\(\s*barButtonSystemItem: \.done/);
    // The navigation controller is what gets presented, not the bare preview.
    expect(open).toMatch(/top\.present\(nav,/);
    // And Done dismisses it.
    const close = body('func closePreview');
    expect(close).toMatch(/previewNav\?\.dismiss\(animated: true\)/);
  });

  it('logs why a file could not be moved, instead of failing in silence', () => {
    const move = body('func moveReceivedFiles');
    expect(move).toMatch(/NSLog\("Daak: could not move/);
    // The log line sits in the failure branch, beside the fallback to the old path.
    expect(move.indexOf('NSLog("Daak: could not move')).toBeGreaterThan(move.indexOf('catch'));
    expect(code).toMatch(/NSLog\("Daak: the download folder/);
  });
});
