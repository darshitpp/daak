import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

// The iOS uniffi_bindgen pin is invisible to every other suite: there is no
// Swift/ObjC test target that imports the generated module, nothing on the JS
// side notices until the first engine call on a device, and CI runs no Xcode
// build at all. Reading the pin from a file that is NOT in the commit is
// silent until the script emits
//
//   uniffi = { version = "=" }
//
// which cargo cannot resolve, so gen-ios-ffi.sh fails and takes the whole app
// target down with it.
//
// Cargo.lock is untracked and forbidden from staging. Reading the pin from it
// means the extraction is EMPTY on a clean checkout, and non-reproducible when
// it does happen to exist (=0.28.3 on one machine, =0.28 on another off the
// same commit). The tracked crates/daak-ffi/Cargo.toml is the only file in the
// commit that can pin it.
const repo = '../../../../';
const repoRoot = join(__dirname, repo);
const read = (p: string) => readFileSync(join(__dirname, repo, p), 'utf8');

const script = 'apps/mobile/scripts/gen-ios-ffi.sh';
const pbxproj = 'apps/mobile/ios/Daak.xcodeproj/project.pbxproj';
const manifest = 'crates/daak-ffi/Cargo.toml';

// Comments are stripped before the Cargo.lock check: the script's own why-
// comment names Cargo.lock on purpose, and only the executable part decides
// what the script reads.
const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const src = () => code(read(script));

// The command inside the version="$(...)" assignment, e.g.
// `sed -n '...' crates/daak-ffi/Cargo.toml | head -1`. Every assertion about
// WHERE the pin is read goes through this and not through src(): the guard's
// own error message names the manifest, so matching the whole script is
// satisfied by a hardcoded version that reads nothing at all.
//
// \r? is belt-and-braces for a CRLF checkout, and is NOT what makes the CRLF
// case work: `.` already excludes \r and multiline `$` matches before \n, so
// the capture is identical either way. A CRLF script passes these assertions
// for a different reason -- assertion 4 shells `echo 0.28 | head -1`, whose
// output has no trailing \r. The real CRLF failure is at runtime, where bash
// sets version="0.28\r" and cargo chokes on `=0.28\r`; that is a script bug,
// not a test gap, and latent (no .gitattributes, core.autocrlf unset).
const assignment = () => /^version="\$\((.+)\)"\r?$/m.exec(src());
const extraction = () => assignment()?.[1];

// Xcode writes each PBXShellScriptBuildPhase object as its own block, opening
// at exactly two tabs then a 24-hex-character id. Split there and nowhere
// else: the id class is case-insensitive, because a lowercased id must not stop
// this phase from being its own block (it would otherwise bleed into a
// neighbour and the test would read the neighbour's inputPaths), and the
// block ENDS at the next such line, so it covers exactly one phase.
//
// That bound is what keeps a reformat honest: a serializer round-trip that
// turns the leading tabs into spaces matches no block at all and fails on the
// explicit "no phase block matched" assertion, instead of collapsing the file
// into one blob and matching whichever inputPaths happens to come first.
const uniffiPhase = () =>
  read(pbxproj)
    .split(/^\t\t(?=[0-9A-Fa-f]{24} )/m)
    .find(
      (b) =>
        /^[0-9A-Fa-f]{24} /.test(b) &&
        /name = "Generate UniFFI bindings \+ Rust staticlib";/.test(b),
    );

describe('iOS uniffi bindgen pin', () => {
  it('reads the pin from the TRACKED crate manifest', () => {
    expect(extraction()).toContain(manifest);
  });

  it('never reads Cargo.lock, which is untracked and not in the commit', () => {
    expect(src()).not.toMatch(/Cargo\.lock/);
  });

  // The extraction command is a RELATIVE path, so the script has to put itself
  // at an absolute repo root before running it: dirname "$0" is relative, and
  // without the `&& pwd` every later relative path depends on whatever cwd
  // Xcode happened to launch the phase from.
  it('resolves an absolute repo root before extracting the pin', () => {
    const s = src();
    const cd = /^cd "\$\(cd .*&& pwd\)"$/m.exec(s)?.[0];
    expect(cd).toBeTruthy();
    expect(s.indexOf(cd as string)).toBeLessThan(s.indexOf('version="$('));
  });

  // uniffi appears twice in daak-ffi/Cargo.toml (dependencies and
  // build-dependencies), so sed prints both and the value comes out as
  // "0.28 0.28" -- an unresolvable requirement. And an empty extraction is the
  // clean-checkout case above, which must abort rather than write "=".
  it('keeps the head -1 and the empty-extraction guard', () => {
    expect(extraction()).toBeTruthy();
    expect(extraction()).toMatch(/\| head -1\s*$/);
    expect(src()).toMatch(/test -n "\$version"/);
  });

  // Runs the script's own extraction command, not a copy of it: a rewritten
  // sed/awk expression that no longer extracts what it claims to would pass
  // every source-level pin above. cwd is repoRoot because the command is
  // relative -- under Xcode the script's own `cd` is what supplies that cwd,
  // and it is asserted separately above rather than hardcoded away here. So
  // this covers the EXPRESSION, not the script's path resolution. 0.28 is the
  // requirement the crate actually declares, so it resolves to the same 0.28.3
  // on every machine off one commit.
  it('extracting against the tracked manifest yields 0.28', () => {
    expect(
      execFileSync('bash', ['-c', extraction() as string], {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim(),
    ).toBe('0.28');
  });
});

// inputPaths is Xcode's dependency declaration for the phase. Listing
// Cargo.lock there made Xcode wait on a file that is not in the commit, and
// not on the file that actually decides the pin.
describe('Xcode UniFFI build phase inputs', () => {
  it('lists the .udl and the generator script, not Cargo.lock', () => {
    const phase = uniffiPhase();
    // expect() takes no message in jest 29, so the diagnosis for a failure here
    // lives in the split's own comment: this is false only when
    // project.pbxproj stopped using the two-tab "\t\t<24-hex-id> " phase
    // indentation, and that is a pbxproj reformat, not a missing phase.
    expect(phase).toBeTruthy();
    const inputs = /inputPaths = \(([\s\S]*?)\);/.exec(phase as string)?.[1];
    expect(inputs).toBeTruthy();
    expect(inputs).toMatch(
      /\$\(SRCROOT\)\/\.\.\/\.\.\/\.\.\/crates\/daak-ffi\/src\/daak\.udl/,
    );
    expect(inputs).toMatch(/\$\(SRCROOT\)\/\.\.\/scripts\/gen-ios-ffi\.sh/);
    expect(inputs).not.toMatch(/Cargo\.lock/);
  });
});
