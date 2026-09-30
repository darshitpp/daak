import { describe, expect, it } from 'vitest';
import { LAUNCHD_LABEL, installerKind, parseLaunchctlList, parseSystemctlShow } from './daemon';

describe('installerKind', () => {
  it('maps each desktop OS to its supervisor', () => {
    expect(installerKind('darwin')).toBe('launchd');
    expect(installerKind('linux')).toBe('systemd');
    expect(installerKind('win32')).toBe('windows-service');
  });

  // A default arm that returns 'systemd' for everything else would install a
  // systemd unit on a box with no systemd. Unknown platform is its own answer
  // so the type forces every caller to handle it.
  it('says unsupported instead of guessing', () => {
    expect(installerKind('freebsd')).toBe('unsupported');
    expect(installerKind('')).toBe('unsupported');
  });
});

describe('parseLaunchctlList', () => {
  it('reports running when a pid is present', () => {
    const out = 'PID\tStatus\tLabel\n4321\t0\tdev.darshit.daak.daakd\n- \t0\tcom.other\n';
    expect(parseLaunchctlList(out, LAUNCHD_LABEL)).toBe('running');
  });

  it('reports stopped for a dash pid and unknown when absent', () => {
    expect(parseLaunchctlList('-\t0\tdev.darshit.daak.daakd\n', LAUNCHD_LABEL)).toBe('stopped');
    expect(parseLaunchctlList('4321\t0\tcom.other\n', LAUNCHD_LABEL)).toBe('unknown');
  });

  // `launchctl list` is a system tool: a label that merely CONTAINS ours (or
  // carries surrounding junk) is somebody else's job, not ours.
  it('matches the label field exactly, never as a substring', () => {
    expect(parseLaunchctlList('4321\t0\tcom.apple.dev.darshit.daak.daakd\n', LAUNCHD_LABEL)).toBe('unknown');
    expect(parseLaunchctlList('4321\t0\tx.dev.darshit.daak.daakd\n', LAUNCHD_LABEL)).toBe('unknown');
    expect(parseLaunchctlList('4321\t0\tdev.darshit.daak.daakd.plist\n', LAUNCHD_LABEL)).toBe('unknown');
  });

  // Neither a dash nor all digits: the job is loaded but no pid is serving it.
  it('does not call a garbage pid running', () => {
    expect(parseLaunchctlList('abc\t0\tdev.darshit.daak.daakd\n', LAUNCHD_LABEL)).toBe('stopped');
  });

  it('is unknown on empty output', () => {
    expect(parseLaunchctlList('', LAUNCHD_LABEL)).toBe('unknown');
  });
});

describe('parseSystemctlShow', () => {
  it('reads SubState', () => {
    expect(parseSystemctlShow('LoadState=loaded\nActiveState=active\nSubState=running\n')).toBe('running');
    expect(parseSystemctlShow('LoadState=loaded\nActiveState=inactive\nSubState=dead\n')).toBe('stopped');
    expect(parseSystemctlShow('')).toBe('unknown');
  });

  it('treats a crashed unit as stopped', () => {
    expect(parseSystemctlShow('LoadState=loaded\nActiveState=failed\nSubState=failed\n')).toBe('stopped');
    expect(parseSystemctlShow('LoadState=loaded\nSubState=exited\n')).toBe('stopped');
  });

  // LoadState is REQUIRED, and the plan pins the WRONG answer here. It expects
  // `ActiveState=inactive` + `SubState=dead` (no LoadState) to be `stopped`,
  // but `systemctl show` synthesises exactly that pair for a unit name it has
  // never heard of, so trusting SubState without LoadState reports `stopped`
  // for a unit that was never installed. Fail-closed wins over the plan.
  it('is unknown when LoadState is absent', () => {
    expect(parseSystemctlShow('ActiveState=inactive\nSubState=dead\n')).toBe('unknown');
    // `systemctl --user show -p SubState daakd` -- the plan's own Step 8 command
    // -- emits no LoadState at all, so this is the common real-world shape.
    expect(parseSystemctlShow('SubState=dead\n')).toBe('unknown');
    expect(parseSystemctlShow('LoadState=loaded\nSubState=dead\n')).toBe('stopped');
  });

  // A malformed value must not be silently dropped, or it becomes
  // indistinguishable from an absent one and the gate is skipped.
  it('is unknown when LoadState is malformed or empty', () => {
    expect(parseSystemctlShow('LoadState=not-found&x\nSubState=dead\n')).toBe('unknown');
    expect(parseSystemctlShow('LoadState=\nSubState=running\n')).toBe('unknown');
    expect(parseSystemctlShow('LoadState=loaded &\nSubState=running\n')).toBe('unknown');
  });

  it('is unknown when LoadState contradicts itself', () => {
    expect(parseSystemctlShow('LoadState=loaded\nLoadState=error\nSubState=running\n')).toBe('unknown');
    expect(parseSystemctlShow('LoadState=loaded\nLoadState=loaded\nSubState=running\n')).toBe('running');
  });

  // A key that appears BOTH well-formed and malformed must fail closed. If the
  // malformed copy were merely dropped, the well-formed `loaded` would unlock
  // SubState and this would report a confident `running` for a unit whose own
  // output says it is in two states at once. Any malformed occurrence poisons
  // the key: the output is not a single agreed value, so we do not get to pick
  // which one to believe.
  it('is unknown when a key appears both valid and malformed', () => {
    expect(parseSystemctlShow('LoadState=loaded\nLoadState=not-found&x\nSubState=running\n')).toBe('unknown');
    expect(parseSystemctlShow('LoadState=loaded\nLoadState=\nSubState=running\n')).toBe('unknown');
    expect(parseSystemctlShow('LoadState=loaded\nSubState=running\nSubState=bad&x\n')).toBe('unknown');
    expect(parseSystemctlShow('LoadState=loaded\nSubState=running\nSubState=\n')).toBe('unknown');
  });

  it('is unknown when SubState contradicts itself', () => {
    expect(parseSystemctlShow('LoadState=loaded\nSubState=running\nSubState=dead\n')).toBe('unknown');
    expect(parseSystemctlShow('LoadState=loaded\nSubState=running\nSubState=running\n')).toBe('running');
  });

  it('accepts both loaded and merged as loaded', () => {
    expect(parseSystemctlShow('LoadState=merged\nSubState=running\n')).toBe('running');
    expect(parseSystemctlShow('LoadState=merged\nSubState=dead\n')).toBe('stopped');
  });

  // activating/deactivating/reloading are neither up nor settled, and the
  // plan's `anything != running` rule would call them stopped.
  it('does not call a transitional substate stopped', () => {
    expect(parseSystemctlShow('LoadState=loaded\nSubState=activating\n')).toBe('unknown');
    expect(parseSystemctlShow('LoadState=loaded\nSubState=deactivating\n')).toBe('unknown');
    expect(parseSystemctlShow('LoadState=loaded\nSubState=reloading\n')).toBe('unknown');
  });

  // `systemctl show` synthesises SubState=dead for a unit it has never heard
  // of, so a non-loaded LoadState is the only thing standing between
  // "stopped" and "not installed".
  it('never reports a not-installed unit as stopped', () => {
    expect(parseSystemctlShow('LoadState=not-found\nActiveState=inactive\nSubState=dead\n')).toBe('unknown');
    expect(parseSystemctlShow('LoadState=masked\nSubState=dead\n')).toBe('unknown');
    expect(parseSystemctlShow('LoadState=error\nSubState=dead\n')).toBe('unknown');
  });

  it('accepts a repeated SubState only when every copy agrees', () => {
    expect(parseSystemctlShow('LoadState=loaded\nSubState=running\nSubState=running\n')).toBe('running');
    expect(parseSystemctlShow('LoadState=loaded\nSubState=running\nSubState=dead\n')).toBe('unknown');
  });

  it('rejects a SubState carrying trailing junk', () => {
    expect(parseSystemctlShow('SubState=running;rm -rf /\n')).toBe('unknown');
    expect(parseSystemctlShow('SubState=\n')).toBe('unknown');
  });
});
