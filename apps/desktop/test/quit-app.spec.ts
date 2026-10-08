import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeModules } from 'react-native';
import { applyTrayAction } from '../src/tray-action';
import { closePopover, openDashboard, quitApp } from '../src/window-host';
import { stripComments } from './strip-comments';

// QUIT MUST QUIT THE PROCESS. The user reported this twice: the tray menu Quit
// leaves the status item in the menu bar, and the Quit inside the app window
// does the same.
//
// THREE ROUTES EXIST, AND ONLY ONE OF THEM WAS DEAD.
//
// The macOS APP MENU already had a working Quit before this change:
// Daak-macOS/Base.lproj/Main.storyboard binds the standard 'Quit Daak' item
// (keyEquivalent="q") to the selector terminate: on the First Responder.
// Info.plist sets NSMainStoryboardFile=Main and main.m runs NSApplicationMain,
// so AppKit loads that menu. Nothing here repairs that route and nothing here
// should: a SECOND native Quit item would give the user two Quit entries.
//
// The TRAY menu Quit is the dead route. It reaches JS, becomes
// TrayAction quit, and applyTrayAction calls host.quit() -- which shells.tsx
// handed a no-op arrow. That is the defect this file pins.
//
// WHY SOURCE PINS: the effects live on the far side of a native bridge, so a
// vitest suite in this package (environment: 'node', react-native aliased to
// test/react-native-stub.ts) cannot call AppKit. Reading the sources is the
// house style for native defects here; see macos-app-delegate.spec.ts and
// macos-activation-policy.spec.ts for the same pattern, and picker.spec.ts for
// the lesson that a source pin must be scoped and stripped so a comment cannot
// satisfy it.

const shellsCode = stripComments(
  readFileSync(join(__dirname, '..', 'src', 'shells.tsx'), 'utf8'),
);
const windowHostCode = stripComments(
  readFileSync(join(__dirname, '..', 'src', 'window-host.ts'), 'utf8'),
);
const trayActionCode = stripComments(
  readFileSync(join(__dirname, '..', 'src', 'tray-action.ts'), 'utf8'),
);
const nativeHeader = stripComments(readFileSync(
  join(__dirname, '..', '..', '..', 'modules', 'rn-tray', 'macos', 'RNWindowHost.h'),
  'utf8',
));
const nativeSource = readFileSync(
  join(__dirname, '..', '..', '..', 'modules', 'rn-tray', 'macos', 'RNWindowHost.mm'),
  'utf8',
);
const storyboard = readFileSync(
  join(__dirname, '..', 'macos', 'Daak-macOS', 'Base.lproj', 'Main.storyboard'),
  'utf8',
);

// One typed view of the bridge, the same cast direct-share.spec.ts:13-21 makes.
// NativeModules is a plain index signature at runtime, so the test asserts on the
// CALL and not on the types.
interface BridgeModules {
  DaakWindowHost?: {
    openDashboard(): Promise<void>;
    closePopover(): Promise<void>;
    quitApp(): Promise<void>;
  };
}
const mods = NativeModules as BridgeModules;

afterEach(() => {
  delete mods.DaakWindowHost;
});

// The host object shells.tsx builds for applyTrayAction. Scoped to the
// onTrayAction function body so no other quit key anywhere in the file can stand
// in for it -- the same scoping lesson picker.spec.ts records after a whole-file
// regex was satisfied by the wrong function.
function onTrayActionBody(): string {
  const at = shellsCode.indexOf('function onTrayAction(');
  expect(at).toBeGreaterThan(-1);
  const open = shellsCode.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < shellsCode.length; i += 1) {
    if (shellsCode[i] === '{') depth += 1;
    else if (shellsCode[i] === '}' && --depth === 0) return shellsCode.slice(open, i + 1);
  }
  throw new Error('unbalanced braces in onTrayAction');
}

// The BODY of one exported function, brace balanced. window-host.ts is matched
// on the whole file today, so openDashboard's own `?? Promise.resolve()` can
// satisfy a case that means quitApp's, and moving quitApp above openDashboard
// would leave both cases green for the wrong reason. Slicing to the body is
// what makes each case read the function it names. Same shape as the scanner
// above, and the reason picker.spec.ts records the same lesson.
function functionBody(code: string, signature: string): string {
  const at = code.indexOf(signature);
  expect(at).toBeGreaterThan(-1);
  const open = code.indexOf('{', at + signature.length - 1);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${signature}`);
}

// The BODY of the native quitApp method, read on the STRIPPED source. Same
// reason as the file header gives for stripping: the comment block above the
// method names NSApp, terminate:, Prohibited and Regular, so an unstripped
// slice would satisfy a case on the prose instead of on the code.
const nativeQuitAppBody = functionBody(
  stripComments(nativeSource),
  '- (void)quitApp {',
);

// The BODY of the JS wrapper, for the same reason as nativeQuitAppBody. Both
// cases that read it were whole-file regexes with [\s\S]*? and no end anchor,
// so openDashboard's own `?? Promise.resolve()` would have satisfied the
// fallback case once quitApp moved above it.
const quitAppWrapperBody = functionBody(
  windowHostCode,
  'export function quitApp()',
);

describe('the tray Quit reaches the native terminate, not a no-op', () => {
  it('hands applyTrayAction the window host quit instead of an inline arrow', () => {
    // The defect, exactly: an inline empty arrow. The host object must carry the
    // imported wrapper BY NAME, so a no-op cannot be reintroduced here without
    // failing this case.
    expect(onTrayActionBody()).toMatch(/quit:\s*quitApp\b/);
  });

  it('imports that quit from the window host, the module that owns AppKit', () => {
    // A quit defined locally in shells.tsx would be a SECOND quit path, which
    // the brief forbids. The import is what makes the host value and the native
    // module the same object.
    expect(shellsCode).toMatch(
      /import\s*\{[^}]*\bquitApp\b[^}]*\}\s*from\s*'\.\/window-host'/,
    );
  });

  it('keeps one quit value in the tray host object', () => {
    // Exactly once. A second key added later would silently replace the first,
    // and this is the case that catches it.
    expect(onTrayActionBody().match(/\bquit\s*:/g) ?? []).toHaveLength(1);
  });

  it('hands the host quit the tray decision and nothing else', () => {
    // THE CHAIN, EXECUTED. The earlier version of this case ran applyTrayAction
    // with a hand-built fake host, so it asserted that applyTrayAction calls
    // whatever quit it was handed. It never touched the value shells.tsx hands
    // it, and it duplicated tray-action.spec.ts:34. It could not have caught the
    // no-op.
    //
    // These are the REAL window-host wrappers, the same three shells.tsx passes
    // to applyTrayAction, and the source cases above pin that it passes these.
    // So the route the tray click takes is run here end to end, as far as a Node
    // suite can go: it must land on the bridge, under the key the native module
    // exports.
    const native = {
      openDashboard: vi.fn(() => Promise.resolve()),
      closePopover: vi.fn(() => Promise.resolve()),
      quitApp: vi.fn(() => Promise.resolve()),
    };
    mods.DaakWindowHost = native;

    applyTrayAction({ kind: 'quit' }, { closePopover, openDashboard, quit: quitApp });

    expect(native.quitApp).toHaveBeenCalledOnce();
    // The negative half. Without it a wrapper that opened the dashboard on its
    // way to quitting would satisfy the assertion above.
    expect(native.openDashboard).not.toHaveBeenCalled();
    expect(native.closePopover).not.toHaveBeenCalled();
  });
});

describe('RNWindowHost exports a quit that terminates the process', () => {
  it('declares quitApp on the host header', () => {
    expect(nativeHeader).toMatch(/^-\s*\(void\)quitApp\s*;/m);
  });

  // The selector the storyboard app menu Quit already uses. Pinning the exact
  // call makes this a behaviour pin rather than a name pin: a quitApp that hides
  // the window, closes the popover, or calls the engine stop would satisfy a
  // looser assertion and leave the process running.
  it('terminates the app through NSApp', () => {
    expect(stripComments(nativeSource)).toMatch(/\[NSApp\s+terminate:nil\]/);
  });

  it('reaches the singleton from the exported method', () => {
    // Scoped to the exported bridge method. RCT_EXPORT_MODULE registers the
    // CLASS, so the bridge's own instance is not the singleton AppDelegate.mm
    // adopted the factory and the window onto. The other two exports forward to
    // [RNWindowHost shared] and the quit export keeps that shape.
    //
    // HONEST LIMIT, recorded so the pin is not read as stronger than it is.
    // quitApp reads no ivar, so `[self quitApp]` would terminate the process just
    // as well and the forwarding is NOT load bearing for THIS method. It is
    // pinned because it is this file's convention, not because the chain needs
    // it. The load-bearing part of this chain is the terminate: call, pinned
    // below.
    const at = nativeSource.indexOf('RCT_EXPORT_METHOD(quitApp');
    expect(at).toBeGreaterThan(-1);
    const close = nativeSource.indexOf('\n}\n', at);
    expect(nativeSource.slice(at, close)).toMatch(
      /\[\[RNWindowHost\s+shared\]\s+quitApp\]/,
    );
  });

  // The exported method must not terminate on the bridge's own instance while
  // the ObjC method terminates on the singleton, or the chain splits.
  it('defines the implementation that the export calls', () => {
    const at = nativeSource.indexOf('- (void)quitApp {');
    expect(at).toBeGreaterThan(-1);
    const close = nativeSource.indexOf('\n}\n', at);
    expect(nativeSource.slice(at, close)).toMatch(/\[NSApp\s+terminate:nil\]/);
  });
});

describe('the window host wrapper reads the module the same lazy way', () => {
  // THE LINK THAT DECIDES WHETHER THE BRIDGE IS FOUND AT ALL. Every other case
  // in this file reads one file. This one reads both halves of a name that has
  // to match across the language boundary: the wrapper asks NativeModules for
  // DaakWindowHost, and RCT_EXPORT_MODULE(DaakWindowHost) is what registers it.
  //
  // The mutation this closes was MEASURED on review. Changing the one token in
  // window-host.ts to NativeModules.DaakTray left all 16 cases green: the key is
  // inside native(), and every case read the export name, the wrapper body, or a
  // different file. At runtime that makes native()?.quitApp() throw on a module
  // with no quitApp, and the app stays in the menu bar. That is the original
  // defect back again, so the pair is asserted in ONE case.
  it('asks NativeModules for the exact name the native module exports', () => {
    const exported = nativeSource.match(
      /RCT_EXPORT_MODULE\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/,
    );
    expect(exported).not.toBeNull();
    expect(stripComments(nativeSource)).toMatch(
      new RegExp(`RCT_EXPORT_MODULE\\(\\s*${exported![1]}\\s*\\)`),
    );
    // And the wrapper must ask for THAT name, not for a name of its own.
    const asked = windowHostCode.match(/NativeModules\.([A-Za-z_][A-Za-z0-9_]*)/);
    expect(asked).not.toBeNull();
    expect(asked![1]).toBe(exported![1]);
  });

  it('declares quitApp beside the other two methods', () => {
    expect(windowHostCode).toMatch(/quitApp\(\)\s*:\s*Promise<void>\s*;/);
  });

  // The lazy read is load-bearing: window-host.ts is imported at the top of
  // apps/desktop/index.js, which evaluates before the bridge installs its
  // modules, so a value captured at module scope is undefined for the whole
  // run. A wrapper that captured it would be a wrapper that never works.
  it('resolves the native module inside the call, not at module scope', () => {
    expect(quitAppWrapperBody).toMatch(/native\(\)\?\.quitApp\(\)/);
  });

  it('falls back to a resolved promise when the module is absent', () => {
    // Same shape as openDashboard and closePopover, so a host without the
    // module does not get an unhandled rejection instead of a no-op.
    expect(quitAppWrapperBody).toMatch(/\?\?\s*Promise\.resolve\(\)/);
  });
});

describe('no quit route stops the daemon', () => {
  // The failure this prevents: DaemonClientEngine.stop() sends
  // IpcRequest::Shutdown, which shuts daakd down. daakd runs under launchd, so
  // it comes back and the app stays in the menu bar with no working daemon --
  // the same visible symptom as today's no-op, which is why a reviewer who
  // reads only the symptom cannot tell the two apart.
  const quitSources: Array<[string, string]> = [
    ['shells.tsx', shellsCode],
    ['window-host.ts', windowHostCode],
    ['tray-action.ts', trayActionCode],
    ['RNWindowHost.h', nativeHeader],
    ['RNWindowHost.mm', stripComments(nativeSource)],
  ];

  it('names no engine stop verb on any quit route', () => {
    for (const [name, code] of quitSources) {
      expect(`${name}: ${code}`).not.toMatch(/engine\s*\.\s*stop\s*\(/);
      expect(`${name}: ${code}`).not.toMatch(/IpcRequest\s*::\s*Shutdown/);
    }
  });

  // The decision layer keeps its TrayHost interface: it calls host.quit() and
  // knows nothing about an engine. This is what the brief requires to stay.
  it('keeps the decision layer calling the host, with no engine of its own', () => {
    expect(trayActionCode).toMatch(/host\s*\.\s*quit\s*\(\s*\)/);
    expect(trayActionCode).not.toMatch(/\bengine\b/);
  });
});

describe('both quit routes reach the same native call', () => {
  it('uses the selector the storyboard app menu Quit already uses', () => {
    expect(storyboard).toMatch(/<action selector="terminate:"/);
    // And the app must not grow a second native Quit item. One is the rule, and
    // the count is pinned so a copy cannot be added unnoticed.
    expect(storyboard.match(/selector="terminate:"/g) ?? []).toHaveLength(1);
  });

  // The tray route adds a native Quit METHOD, never a native Quit MENU ITEM. A
  // second menu item would put two Quit entries in the app menu bar and would
  // not be pinned by the storyboard count alone.
  //
  // Scoped to the quitApp body. Over the whole file the guard would also fire on
  // a correct future change -- dismissing the popover through RNTray on the way
  // out is a reasonable thing for this method to do, and it would fail here for
  // no reason. The tray route must not BUILD a menu; the rest of the file is not
  // this case's business.
  it('adds no native menu item for the tray route', () => {
    expect(nativeQuitAppBody).not.toMatch(/menuItem|NSMenu/);
    expect(nativeQuitAppBody).not.toMatch(/addItem/);
  });

  it('keeps the app a normal app, with no LSUIElement', () => {
    // The app is a NORMAL app: a Dock icon, a Cmd-Tab entry, and the standard
    // app menu bar, with the menu-bar status item beside them. Info.plist must
    // not set LSUIElement or the two NSSupports* keys, and the code must choose
    // Regular. The quit routes must not change that shape.
    const info = readFileSync(
      join(__dirname, '..', 'macos', 'Daak-macOS', 'Info.plist'),
      'utf8',
    );
    expect(info).not.toMatch(/<key>LSUIElement<\/key>/);
    expect(info).not.toMatch(/<key>NSSupportsAutomaticTermination<\/key>/);
    expect(info).not.toMatch(/<key>NSSupportsSuddenTermination<\/key>/);
    expect(stripComments(nativeSource)).toMatch(
      /setActivationPolicy:\s*NSApplicationActivationPolicyRegular/,
    );
  });
});
